//! Interactive full-screen ratatui chat. Replicates agentj's behavior — streaming transcript, tool
//! lines, a spinner/status line, `/task` re-key, slash-command highlight + Tab completion, and Ctrl-C
//! to interrupt a turn — in a full-screen ratatui layout (transcript / status / input).
//!
//! Input model: **Enter submits**. A newline chord (Alt/Shift/Ctrl+Enter on terminals that report it,
//! plus Ctrl-J everywhere) inserts a newline for multi-line input; a bracketed paste inserts multi-line
//! text directly. Arrow keys move the cursor (Left/Right within a line, Up/Down across lines); the
//! transcript scrolls with PageUp/PageDown or Ctrl+Up/Down.

use crate::agent::run_turn;
use crate::commands::{classify, complete_command, TokenClass, SLASH_COMMANDS};
use crate::events::AgentEvent;
use crate::provider::{ChatMessage, Llm};
use crate::rekey::{is_linked_worktree, rekey};
use crate::tools::Tools;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::time::interval;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FUN_SPINNER: [&str; 8] = ["✦", "✧", "⋆", "✧", "✦", "✺", "✹", "✺"];
const DIM: Color = Color::DarkGray;
const MAX_INPUT_ROWS: u16 = 8;
const EFFECT_TTL: Duration = Duration::from_millis(900);

// ── a small cursor-tracked, multi-line text buffer ──
// `cursor` is a byte index into `text`, always kept on a char boundary.

#[derive(Default)]
struct Editor {
    text: String,
    cursor: usize,
}

impl Editor {
    fn text(&self) -> &str {
        &self.text
    }
    fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
    }
    /// Replace the whole buffer (used by Tab completion); cursor to the end.
    fn set(&mut self, s: String) {
        self.cursor = s.len();
        self.text = s;
    }
    fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
    }
    fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
    }
    fn backspace(&mut self) {
        if self.cursor > 0 {
            let p = self.prev(self.cursor);
            self.text.replace_range(p..self.cursor, "");
            self.cursor = p;
        }
    }
    fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let n = self.next(self.cursor);
            self.text.replace_range(self.cursor..n, "");
        }
    }
    fn left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self.prev(self.cursor);
        }
    }
    fn right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor = self.next(self.cursor);
        }
    }
    fn home(&mut self) {
        self.cursor = self.text[..self.cursor]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
    }
    fn end(&mut self) {
        self.cursor = self.text[self.cursor..]
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len());
    }
    fn up(&mut self) {
        self.vmove(true);
    }
    fn down(&mut self) {
        self.vmove(false);
    }
    fn prev(&self, i: usize) -> usize {
        let mut j = i - 1;
        while !self.text.is_char_boundary(j) {
            j -= 1;
        }
        j
    }
    fn next(&self, i: usize) -> usize {
        let mut j = i + 1;
        while j < self.text.len() && !self.text.is_char_boundary(j) {
            j += 1;
        }
        j
    }
    /// (row, column) of the cursor, both 0-based, column counted in chars.
    fn row_col(&self) -> (u16, u16) {
        let before = &self.text[..self.cursor];
        let row = before.bytes().filter(|&b| b == b'\n').count() as u16;
        let col = before.rsplit('\n').next().unwrap_or("").chars().count() as u16;
        (row, col)
    }
    /// Move the cursor up/down one line, keeping the target column where possible.
    fn vmove(&mut self, up: bool) {
        let (row, col) = self.row_col();
        let lines: Vec<&str> = self.text.split('\n').collect();
        let target = if up {
            if row == 0 {
                return;
            }
            (row - 1) as usize
        } else {
            if row as usize + 1 >= lines.len() {
                return;
            }
            (row + 1) as usize
        };
        let mut off = 0usize;
        for r in 0..target {
            off += lines[r].len() + 1; // + '\n'
        }
        let line = lines[target];
        let tcol = (col as usize).min(line.chars().count());
        let byte_in_line = line
            .char_indices()
            .nth(tcol)
            .map(|(b, _)| b)
            .unwrap_or(line.len());
        self.cursor = off + byte_in_line;
    }
}

/// Rows the input area needs (logical lines, capped).
fn input_rows(text: &str) -> u16 {
    (text.split('\n').count().max(1) as u16).min(MAX_INPUT_ROWS)
}

/// Messages into the UI event loop.
enum UiMsg {
    Agent(AgentEvent),
    /// A turn finished: its full message history (feeds the next turn).
    TurnComplete(Vec<ChatMessage>),
}

/// What a keystroke means, resolved so the async loop can act (some actions await).
enum Action {
    None,
    Quit,
    ClearInput,
    Char(char),
    Backspace,
    Delete,
    Newline,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    Complete,
    AbortTurn,
    Submit(String),
    ScrollUp,
    ScrollDown,
    PageUp,
    PageDown,
}

fn key_to_action(k: KeyEvent, running: bool, input: &str) -> Action {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let alt = k.modifiers.contains(KeyModifiers::ALT);
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);
    match k.code {
        // These work during a turn too (abort / scroll).
        KeyCode::Char('c') if ctrl => {
            if running {
                Action::AbortTurn
            } else if input.is_empty() {
                Action::Quit
            } else {
                Action::ClearInput
            }
        }
        KeyCode::Char('d') if ctrl => Action::Quit,
        KeyCode::PageUp => Action::PageUp,
        KeyCode::PageDown => Action::PageDown,
        KeyCode::Up if ctrl => Action::ScrollUp,
        KeyCode::Down if ctrl => Action::ScrollDown,
        // Below here: ignored while a turn runs.
        _ if running => Action::None,
        // Newline chords for multi-line input (Enter alone submits).
        KeyCode::Enter if alt || shift || ctrl => Action::Newline,
        KeyCode::Char('j') if ctrl => Action::Newline,
        KeyCode::Enter => Action::Submit(input.trim().to_string()),
        KeyCode::Tab => Action::Complete,
        KeyCode::Backspace => Action::Backspace,
        KeyCode::Delete => Action::Delete,
        KeyCode::Left => Action::Left,
        KeyCode::Right => Action::Right,
        KeyCode::Up => Action::Up,
        KeyCode::Down => Action::Down,
        KeyCode::Home => Action::Home,
        KeyCode::End => Action::End,
        KeyCode::Char(c) if !ctrl => Action::Char(c),
        _ => Action::None,
    }
}

fn dim_line(s: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(s.into(), Style::default().fg(DIM)))
}

fn assistant_lines(text: &str) -> Vec<Line<'static>> {
    text.lines()
        .map(|l| {
            Line::from(vec![
                Span::styled("● ", Style::default().fg(DIM)),
                Span::raw(l.to_string()),
            ])
        })
        .collect()
}

/// Build the styled input lines: a dim prompt + the command token colored by class + plain remainder.
fn input_lines(input: &str) -> Text<'static> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut raw = input.split('\n');
    let first = raw.next().unwrap_or("");
    let (token, rest, class) = classify(first, SLASH_COMMANDS);
    let mut spans = vec![Span::styled("› ", Style::default().fg(DIM))];
    match class {
        TokenClass::Plain => spans.push(Span::raw(token)),
        TokenClass::Exact => spans.push(Span::styled(
            token,
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        TokenClass::Prefix => spans.push(Span::styled(token, Style::default().fg(Color::Cyan))),
        TokenClass::Unknown => spans.push(Span::styled(token, Style::default().fg(Color::Red))),
    }
    if !rest.is_empty() {
        spans.push(Span::raw(rest));
    }
    lines.push(Line::from(spans));
    for line in raw {
        lines.push(Line::from(vec![
            Span::styled("  ", Style::default().fg(DIM)),
            Span::raw(line.to_string()),
        ]));
    }
    Text::from(lines)
}

fn fmt_ms(ms: u128) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

fn max_scroll(lines: usize, viewport: u16) -> u16 {
    lines.saturating_sub(viewport as usize) as u16
}

fn pulse_color(frame: usize, running: bool) -> Color {
    if running {
        match frame % 6 {
            0 | 3 => Color::Cyan,
            1 | 4 => Color::Blue,
            _ => Color::Magenta,
        }
    } else {
        match frame % 4 {
            0 | 2 => Color::DarkGray,
            _ => Color::Gray,
        }
    }
}

fn sparkle(frame: usize) -> &'static str {
    match frame % 6 {
        0 => "✦",
        1 => "✧",
        2 => "⋆",
        3 => "·",
        4 => "⋆",
        _ => "✧",
    }
}

/// Spawn a turn: clone history + append the user message, run it in the background, forward its events
/// as `UiMsg::Agent`, and send `TurnComplete` with the final history when it's done. Returns the abort
/// handle so Ctrl-C can cancel it (which drops the user turn — history is only committed on completion).
fn spawn_turn(
    text: String,
    history: &[ChatMessage],
    llm: Arc<Llm>,
    tools: Arc<Tools>,
    ui: UnboundedSender<UiMsg>,
) -> tokio::task::AbortHandle {
    let mut msgs = history.to_vec();
    msgs.push(ChatMessage::user(text));
    let handle = tokio::spawn(async move {
        let (atx, mut arx) = unbounded_channel::<AgentEvent>();
        let ui_forward = ui.clone();
        let drain = async move {
            while let Some(ev) = arx.recv().await {
                let _ = ui_forward.send(UiMsg::Agent(ev));
            }
        };
        let run = async {
            let _ = run_turn(&llm, &tools, &mut msgs, &atx, true).await;
            drop(atx); // close the channel so the drain finishes
        };
        tokio::join!(run, drain);
        let _ = ui.send(UiMsg::TurnComplete(msgs));
    });
    handle.abort_handle()
}

pub async fn run(
    model_id: String,
    root: String,
    system: String,
    llm: Llm,
    tools: Tools,
    notices: Vec<String>,
) -> anyhow::Result<()> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
    // Ask for progressive keyboard reporting so Shift/Ctrl/Alt+Enter are distinguishable where the
    // terminal supports it (kitty/ghostty/wezterm/newer iTerm2); a no-op elsewhere.
    let _ = execute!(
        stdout,
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    );
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let llm = Arc::new(llm);
    let tools = Arc::new(tools);
    let mut messages: Vec<ChatMessage> = vec![ChatMessage::system(system.clone())];
    let mut transcript: Vec<Line<'static>> = vec![
        dim_line(format!("agentj · {model_id} · {root}")),
        dim_line("Enter submits · Alt/Shift/Ctrl+Enter (or Ctrl-J) = newline · ←/→/↑/↓ move cursor · PageUp/Dn or Ctrl+↑/↓ scroll · /task <pr|branch> · Ctrl-C interrupts · Ctrl-D or /exit quits"),
    ];
    for n in &notices {
        transcript.push(dim_line(format!("! {n}")));
    }
    let mut editor = Editor::default();
    let mut running = false;
    let mut spinner = 0usize;
    let mut pulse = 0usize;
    let mut status = String::new();
    let mut current_tool = String::new();
    let mut since = Instant::now();
    let mut effect_until: Option<Instant> = None;
    let mut effect_label = String::new();
    let mut turn_abort: Option<tokio::task::AbortHandle> = None;
    let mut scroll = 0u16;
    let mut follow = true; // stick to the bottom until the user scrolls up

    let (ui_tx, mut ui_rx) = unbounded_channel::<UiMsg>();
    let (in_tx, mut in_rx) = unbounded_channel::<Event>();
    std::thread::spawn(move || loop {
        match crossterm::event::read() {
            Ok(ev) => {
                if in_tx.send(ev).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    });
    let mut ticker = interval(Duration::from_millis(120));

    let mut quit = false;
    while !quit {
        terminal.draw(|f| {
            let area = f.area();
            let in_h = input_rows(editor.text());
            let rows = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(1),
                Constraint::Length(in_h),
            ])
            .split(area);

            // Transcript (with a bottom divider). Auto-follow the tail unless the user scrolled up.
            let viewport = rows[0].height.saturating_sub(1); // minus the border row
            let max = max_scroll(transcript.len(), viewport);
            if follow {
                scroll = max;
            }
            scroll = scroll.min(max);
            let accent = pulse_color(pulse, running);
            f.render_widget(
                Paragraph::new(Text::from(transcript.clone()))
                    .block(
                        Block::default()
                            .borders(Borders::BOTTOM)
                            .border_style(Style::default().fg(accent)),
                    )
                    .scroll((scroll, 0)),
                rows[0],
            );

            // Status line.
            let effect_active = effect_until.is_some_and(|until| until > Instant::now());
            let status_line = if running {
                let elapsed = since.elapsed().as_secs();
                let base = if pulse % 5 == 0 {
                    FUN_SPINNER[spinner % FUN_SPINNER.len()]
                } else {
                    SPINNER[spinner % SPINNER.len()]
                };
                let label = if status.is_empty() {
                    "thinking".to_string()
                } else {
                    status.clone()
                };
                let mut spans = vec![Span::styled(
                    format!("{base} "),
                    Style::default().fg(accent).add_modifier(Modifier::BOLD),
                )];
                spans.push(Span::raw(format!("{label} · {elapsed}s")));
                if effect_active && !effect_label.is_empty() {
                    spans.push(Span::styled(
                        format!("  {} {}", sparkle(pulse), effect_label),
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ));
                }
                Line::from(spans)
            } else if effect_active && !effect_label.is_empty() {
                Line::from(vec![
                    Span::styled(
                        format!("{} ", sparkle(pulse)),
                        Style::default().fg(Color::Yellow),
                    ),
                    Span::styled(
                        effect_label.clone(),
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                ])
            } else {
                Line::from(vec![Span::styled(
                    format!("{} ready", sparkle(pulse)),
                    Style::default().fg(accent),
                )])
            };
            f.render_widget(Paragraph::new(status_line), rows[1]);

            // Input line(s) + a real cursor.
            f.render_widget(Paragraph::new(input_lines(editor.text())), rows[2]);
            let (crow, ccol) = editor.row_col();
            f.set_cursor_position(Position::new(
                (rows[2].x + 2 + ccol).min(rows[2].x + rows[2].width.saturating_sub(1)),
                (rows[2].y + crow).min(rows[2].y + rows[2].height.saturating_sub(1)),
            ));
        })?;

        tokio::select! {
            _ = ticker.tick() => {
                spinner = spinner.wrapping_add(1);
                pulse = pulse.wrapping_add(1);
                if effect_until.is_some_and(|until| until <= Instant::now()) {
                    effect_until = None;
                    effect_label.clear();
                }
            }
            Some(ev) = in_rx.recv() => {
                match ev {
                    Event::Paste(s) if !running => editor.insert_str(&s),
                    Event::Key(k) if k.kind != KeyEventKind::Release => {
                        match key_to_action(k, running, editor.text()) {
                            Action::None => {}
                            Action::Quit => quit = true,
                            Action::ClearInput => editor.clear(),
                            Action::Char(c) => editor.insert_char(c),
                            Action::Newline => editor.insert_char('\n'),
                            Action::Backspace => editor.backspace(),
                            Action::Delete => editor.delete(),
                            Action::Left => editor.left(),
                            Action::Right => editor.right(),
                            Action::Up => editor.up(),
                            Action::Down => editor.down(),
                            Action::Home => editor.home(),
                            Action::End => editor.end(),
                            Action::ScrollUp => { follow = false; scroll = scroll.saturating_sub(1); }
                            Action::ScrollDown => { scroll = scroll.saturating_add(1); }
                            Action::PageUp => { follow = false; scroll = scroll.saturating_sub(10); }
                            Action::PageDown => { scroll = scroll.saturating_add(10); }
                            Action::Complete => {
                                let c = complete_command(editor.text(), SLASH_COMMANDS);
                                editor.set(c.line);
                                for cand in &c.candidates {
                                    transcript.push(dim_line(format!("  {}  {}", cand.name, cand.summary)));
                                }
                            }
                            Action::AbortTurn => {
                                if let Some(h) = turn_abort.take() { h.abort(); }
                                running = false;
                                status.clear();
                                effect_until = Some(Instant::now() + EFFECT_TTL);
                                effect_label = "interrupted".to_string();
                                transcript.push(dim_line("[interrupted]"));
                                follow = true;
                            }
                            Action::Submit(text) => {
                                editor.clear();
                                follow = true;
                                if text.is_empty() {
                                    // nothing
                                } else if text == "/exit" || text == "/quit" {
                                    quit = true;
                                } else if text == "/task" || text.starts_with("/task ") {
                                    let rest = text["/task".len()..].trim().to_string();
                                    let reference = rest.split_whitespace().next().unwrap_or("").to_string();
                                    if reference.is_empty() {
                                        transcript.push(dim_line("usage: /task <pr-number | branch-name> [task description]"));
                                    } else if !is_linked_worktree(&root) && std::env::var("AGENTJ_ALLOW_PRIMARY").as_deref() != Ok("1") {
                                        transcript.push(dim_line("» /task does a destructive reset to origin and is meant for a dedicated worktree — this looks like the primary checkout. Run agentj in your worktree, or set AGENTJ_ALLOW_PRIMARY=1."));
                                    } else {
                                        transcript.push(dim_line(format!("» re-keying worktree → {reference}")));
                                        let rk = rekey(&root, &reference).await;
                                        for s in &rk.steps { transcript.push(dim_line(format!("  · {s}"))); }
                                        if !rk.ok {
                                            effect_until = Some(Instant::now() + EFFECT_TTL);
                                            effect_label = "re-key failed".to_string();
                                            transcript.push(dim_line(format!("» re-key failed: {}", rk.error.unwrap_or_default())));
                                        } else {
                                            effect_until = Some(Instant::now() + EFFECT_TTL);
                                            effect_label = format!("switched to {}", rk.branch.clone().unwrap_or_default());
                                            transcript.push(dim_line(format!("» clean on {}, synced to origin", rk.branch.clone().unwrap_or_default())));
                                            messages = vec![ChatMessage::system(system.clone())];
                                            let desc = rest[reference.len()..].trim().to_string();
                                            if !desc.is_empty() {
                                                transcript.push(Line::from(format!("› {desc}")));
                                                running = true;
                                                since = Instant::now();
                                                status.clear();
                                                turn_abort = Some(spawn_turn(desc, &messages, llm.clone(), tools.clone(), ui_tx.clone()));
                                            }
                                        }
                                    }
                                } else {
                                    transcript.push(Line::from(format!("› {text}")));
                                    running = true;
                                    since = Instant::now();
                                    status.clear();
                                    effect_until = Some(Instant::now() + EFFECT_TTL);
                                    effect_label = "let's cook".to_string();
                                    turn_abort = Some(spawn_turn(text, &messages, llm.clone(), tools.clone(), ui_tx.clone()));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some(msg) = ui_rx.recv() => {
                match msg {
                    UiMsg::Agent(ev) => match ev {
                        AgentEvent::Message(t) => {
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "new reply".to_string();
                            transcript.extend(assistant_lines(&t));
                        }
                        AgentEvent::ToolStart { name, args, .. } => {
                            current_tool = format!("{name}({args})");
                            status = current_tool.clone();
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = format!("tool: {name}");
                        }
                        AgentEvent::ToolEnd { summary, elapsed_ms, .. } => {
                            transcript.push(dim_line(format!("· {current_tool} — {} {summary}", fmt_ms(elapsed_ms))));
                            status = "thinking".to_string();
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = format!("done in {}", fmt_ms(elapsed_ms));
                        }
                        AgentEvent::Note(t) => transcript.push(dim_line(format!("» {t}"))),
                        AgentEvent::Error(e) => {
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "error".to_string();
                            transcript.push(Line::from(Span::styled(format!("[error] {e}"), Style::default().fg(Color::Red))))
                        }
                        AgentEvent::Done => {
                            running = false;
                            status.clear();
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "all set".to_string();
                        }
                    },
                    UiMsg::TurnComplete(m) => {
                        messages = m;
                        running = false;
                        status.clear();
                        if effect_label.is_empty() {
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "all set".to_string();
                        }
                    }
                }
            }
        }
    }

    let _ = execute!(terminal.backend_mut(), PopKeyboardEnhancementFlags);
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableBracketedPaste
    )?;
    disable_raw_mode()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed(s: &str) -> Editor {
        let mut e = Editor::default();
        e.insert_str(s);
        e
    }

    #[test]
    fn insert_backspace_and_midline_insert() {
        let mut e = Editor::default();
        e.insert_char('a');
        e.insert_char('c');
        e.left(); // cursor between a and c
        e.insert_char('b');
        assert_eq!(e.text(), "abc");
        e.backspace(); // removes 'b'
        assert_eq!(e.text(), "ac");
    }

    #[test]
    fn arrows_move_the_cursor_across_lines() {
        let mut e = ed("abcd\nef"); // cursor at end → (row 1, col 2)
        assert_eq!(e.row_col(), (1, 2));
        e.up(); // same column on the previous line
        assert_eq!(e.row_col(), (0, 2));
        e.insert_char('X'); // "abXcd\nef"
        assert_eq!(e.text(), "abXcd\nef");
        e.down();
        assert_eq!(e.row_col().0, 1);
        e.home();
        assert_eq!(e.row_col(), (1, 0));
        e.end();
        assert_eq!(e.row_col(), (1, 2));
    }

    #[test]
    fn enter_submits_while_chords_insert_newlines() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let plain = |c| KeyEvent::new(c, KeyModifiers::NONE);
        // Plain Enter submits (the whole bug).
        assert!(
            matches!(key_to_action(plain(KeyCode::Enter), false, "hi"), Action::Submit(s) if s == "hi")
        );
        // Shift+Enter and Ctrl-J insert a newline.
        assert!(matches!(
            key_to_action(
                KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT),
                false,
                "hi"
            ),
            Action::Newline
        ));
        assert!(matches!(
            key_to_action(
                KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL),
                false,
                "hi"
            ),
            Action::Newline
        ));
        // Arrows move the cursor.
        assert!(matches!(
            key_to_action(plain(KeyCode::Left), false, "hi"),
            Action::Left
        ));
        assert!(matches!(
            key_to_action(plain(KeyCode::Up), false, "hi"),
            Action::Up
        ));
        // Typing is ignored mid-turn, but Ctrl-C still aborts and Ctrl+↑ still scrolls.
        assert!(matches!(
            key_to_action(plain(KeyCode::Char('x')), true, ""),
            Action::None
        ));
        assert!(matches!(
            key_to_action(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                true,
                ""
            ),
            Action::AbortTurn
        ));
        assert!(matches!(
            key_to_action(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL), true, ""),
            Action::ScrollUp
        ));
    }
}
