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
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, MouseEventKind,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Terminal;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::time::interval;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM: Color = Color::DarkGray;
const MAX_INPUT_ROWS: u16 = 8;
const EFFECT_TTL: Duration = Duration::from_millis(700);
/// A second Ctrl-C within this window quits.
const DOUBLE_TAP: Duration = Duration::from_secs(2);

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
    fn delete_to_buffer_home(&mut self) {
        if self.cursor > 0 {
            self.text.replace_range(0..self.cursor, "");
            self.cursor = 0;
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
    fn word_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let mut i = self.cursor;
        while i > 0 {
            let p = self.prev(i);
            let ch = self.text[p..i].chars().next().unwrap();
            if !ch.is_whitespace() {
                break;
            }
            i = p;
        }
        while i > 0 {
            let p = self.prev(i);
            let ch = self.text[p..i].chars().next().unwrap();
            if ch.is_whitespace() {
                break;
            }
            i = p;
        }
        self.cursor = i;
    }
    fn word_right(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let mut i = self.cursor;
        while i < self.text.len() {
            let n = self.next(i);
            let ch = self.text[i..n].chars().next().unwrap();
            if !ch.is_whitespace() {
                break;
            }
            i = n;
        }
        while i < self.text.len() {
            let n = self.next(i);
            let ch = self.text[i..n].chars().next().unwrap();
            if ch.is_whitespace() {
                break;
            }
            i = n;
        }
        self.cursor = i;
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
    fn buffer_home(&mut self) {
        self.cursor = 0;
    }
    fn buffer_end(&mut self) {
        self.cursor = self.text.len();
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
fn input_rows(text: &str, width: u16) -> u16 {
    let content_width = width.saturating_sub(2).max(1) as usize;
    let rows = text
        .split('\n')
        .map(|line| line.chars().count().max(1).div_ceil(content_width))
        .sum::<usize>()
        .max(1) as u16;
    rows.min(MAX_INPUT_ROWS)
}

fn visual_cursor(text: &str, cursor: usize, width: u16) -> (u16, u16) {
    let content_width = width.saturating_sub(2).max(1) as usize;
    let before = &text[..cursor];
    let mut row = 0usize;
    let mut col = 0usize;
    for ch in before.chars() {
        if ch == '\n' {
            row += 1;
            col = 0;
            continue;
        }
        if col == content_width {
            row += 1;
            col = 0;
        }
        col += 1;
    }
    (row as u16, col as u16)
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
    DeleteToBufferHome,
    Newline,
    Left,
    Right,
    WordLeft,
    WordRight,
    Up,
    Down,
    Home,
    End,
    Complete,
    AbortTurn,
    /// Ctrl-C — quit on a double-tap; the loop tracks the timing.
    CtrlC,
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
    let super_ = k.modifiers.contains(KeyModifiers::SUPER);
    let no_mods = k.modifiers.is_empty();
    let alt_char_word = matches!(k.code, KeyCode::Char('b' | 'B' | 'f' | 'F'));
    match k.code {
        // These work during a turn too (interrupt / quit / scroll).
        KeyCode::Esc if running => Action::AbortTurn, // Esc interrupts the running turn
        KeyCode::Char('c') if ctrl => Action::CtrlC,  // twice = quit (loop tracks the double-tap)
        KeyCode::Char('d') if ctrl => Action::Quit,
        KeyCode::PageUp => Action::PageUp,
        KeyCode::PageDown => Action::PageDown,
        KeyCode::Up if ctrl => Action::ScrollUp,
        KeyCode::Down if ctrl => Action::ScrollDown,
        // Below here: ignored while a turn runs, except terminals that encode ⌥←/→ as Esc+b/f.
        _ if running && !alt_char_word => Action::None,
        KeyCode::Esc => Action::ClearInput, // idle: Esc clears the input line
        // Newline chords for multi-line input (Enter alone submits).
        KeyCode::Enter if alt || shift || ctrl => Action::Newline,
        KeyCode::Char('j') if ctrl => Action::Newline,
        KeyCode::Enter => Action::Submit(input.trim().to_string()),
        KeyCode::Tab if no_mods => Action::Complete,
        KeyCode::Backspace if super_ => Action::DeleteToBufferHome,
        KeyCode::Backspace if no_mods => Action::Backspace,
        KeyCode::Delete if no_mods => Action::Delete,
        KeyCode::Left if super_ => Action::Home,
        KeyCode::Right if super_ => Action::End,
        KeyCode::Left if alt => Action::WordLeft,
        KeyCode::Right if alt => Action::WordRight,
        KeyCode::Left if no_mods => Action::Left,
        KeyCode::Right if no_mods => Action::Right,
        KeyCode::Up if no_mods => Action::Up,
        KeyCode::Down if no_mods => Action::Down,
        KeyCode::Home if no_mods => Action::Home,
        KeyCode::End if no_mods => Action::End,
        KeyCode::Char(c) if alt && matches!(c, 'b' | 'B') => Action::WordLeft,
        KeyCode::Char(c) if alt && matches!(c, 'f' | 'F') => Action::WordRight,
        KeyCode::Char(c) if !ctrl && !alt && !super_ => Action::Char(c),
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

fn line_width(line: &Line<'_>) -> usize {
    line.spans
        .iter()
        .map(|span| span.content.chars().count())
        .sum::<usize>()
}

fn transcript_rows(lines: &[Line<'_>], width: u16) -> usize {
    let content_width = width.saturating_sub(2).max(1) as usize;
    lines
        .iter()
        .map(|line| line_width(line).max(1).div_ceil(content_width))
        .sum()
}

fn max_scroll(lines: &[Line<'_>], width: u16, viewport: u16) -> u16 {
    transcript_rows(lines, width).saturating_sub(viewport as usize) as u16
}

fn pulse_color(_frame: usize, running: bool) -> Color {
    if running {
        Color::Cyan
    } else {
        Color::Gray
    }
}

fn divider_color(running: bool) -> Color {
    if running {
        Color::DarkGray
    } else {
        DIM
    }
}

fn sparkle(_frame: usize) -> &'static str {
    "·"
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
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableMouseCapture
    )?;
    // Ask for progressive keyboard reporting so Shift/Ctrl/Alt+Enter are distinguishable where the
    // terminal supports it (kitty/ghostty/wezterm/newer iTerm2); a no-op elsewhere.
    let _ = execute!(
        stdout,
        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES
        )
    );
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let llm = Arc::new(llm);
    let tools = Arc::new(tools);
    let mut messages: Vec<ChatMessage> = vec![ChatMessage::system(system.clone())];
    let mut transcript: Vec<Line<'static>> = vec![
        dim_line(format!("agentj · {model_id} · {root}")),
        dim_line("Enter submits · Alt/Shift/Ctrl+Enter (or Ctrl-J) = newline · ⌥←/→ skip words · ⌘←/→ line start/end · ←/→/↑/↓ move cursor · mouse wheel/PageUp/Dn or Ctrl+↑/↓ scroll · /task <pr|branch> · Esc interrupts a turn · Ctrl-C twice (or Ctrl-D / /exit) quits"),
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
    let mut last_ctrl_c: Option<Instant> = None; // for the Ctrl-C-twice-to-quit gesture
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
            let input_width = area.width;
            let in_h = input_rows(editor.text(), input_width);
            let rows = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(1),
                Constraint::Length(in_h),
            ])
            .split(area);

            // Transcript (with a bottom divider). Auto-follow the tail unless the user scrolled up.
            let viewport = rows[0].height.saturating_sub(1); // minus the border row
            let max = max_scroll(&transcript, rows[0].width, viewport);
            if follow {
                scroll = max;
            }
            scroll = scroll.min(max);
            let accent = pulse_color(pulse, running);
            let divider = divider_color(running);
            f.render_widget(
                Paragraph::new(Text::from(transcript.clone()))
                    .block(
                        Block::default()
                            .borders(Borders::BOTTOM)
                            .border_style(Style::default().fg(divider)),
                    )
                    .wrap(Wrap { trim: false })
                    .scroll((scroll, 0)),
                rows[0],
            );

            // Status line.
            let effect_active = effect_until.is_some_and(|until| until > Instant::now());
            let status_line = if running {
                let elapsed = since.elapsed().as_secs();
                let base = SPINNER[spinner % SPINNER.len()];
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
                        Style::default().fg(Color::Gray),
                    ));
                }
                Line::from(spans)
            } else if effect_active && !effect_label.is_empty() {
                Line::from(vec![
                    Span::styled(
                        format!("{} ", sparkle(pulse)),
                        Style::default().fg(Color::Gray),
                    ),
                    Span::styled(effect_label.clone(), Style::default().fg(Color::Gray)),
                ])
            } else {
                Line::from(vec![Span::styled(
                    format!("{} ready", sparkle(pulse)),
                    Style::default().fg(accent),
                )])
            };
            f.render_widget(Paragraph::new(status_line), rows[1]);

            // Input line(s) + a real cursor.
            f.render_widget(
                Paragraph::new(input_lines(editor.text())).wrap(Wrap { trim: false }),
                rows[2],
            );
            let (crow, ccol) = visual_cursor(editor.text(), editor.cursor, rows[2].width);
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
                    Event::Mouse(m) => match m.kind {
                        MouseEventKind::ScrollUp => {
                            follow = false;
                            scroll = scroll.saturating_sub(3);
                        }
                        MouseEventKind::ScrollDown => {
                            scroll = scroll.saturating_add(3);
                        }
                        _ => {}
                    },
                    Event::Key(k) if k.kind != KeyEventKind::Release => {
                        match key_to_action(k, running, editor.text()) {
                            Action::None => {}
                            Action::Quit => quit = true,
                            Action::ClearInput => editor.clear(),
                            Action::Char(c) => editor.insert_char(c),
                            Action::Newline => editor.insert_char('\n'),
                            Action::Backspace => editor.backspace(),
                            Action::Delete => editor.delete(),
                            Action::DeleteToBufferHome => editor.delete_to_buffer_home(),
                            Action::Left => editor.left(),
                            Action::Right => editor.right(),
                            Action::WordLeft => editor.word_left(),
                            Action::WordRight => editor.word_right(),
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
                                let had_candidates = !c.candidates.is_empty();
                                editor.set(c.line);
                                if had_candidates || editor.text() == "/" {
                                    for cand in SLASH_COMMANDS {
                                        transcript.push(dim_line(format!("  {}  {}", cand.name, cand.summary)));
                                    }
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
                            Action::CtrlC => {
                                let now = Instant::now();
                                if last_ctrl_c.is_some_and(|t| now.duration_since(t) < DOUBLE_TAP) {
                                    quit = true; // second Ctrl-C within the window → quit
                                } else {
                                    last_ctrl_c = Some(now);
                                    editor.clear(); // first Ctrl-C also clears any typed input
                                    effect_until = Some(now + DOUBLE_TAP);
                                    effect_label = "press Ctrl-C again to quit".to_string();
                                }
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
        DisableBracketedPaste,
        DisableMouseCapture
    )?;
    disable_raw_mode()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEventKind};

    fn ed(s: &str) -> Editor {
        let mut e = Editor::default();
        e.insert_str(s);
        e
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn apply_key(editor: &mut Editor, key_event: KeyEvent, running: bool) -> Action {
        let action = key_to_action(key_event, running, editor.text());
        match action {
            Action::ClearInput => editor.clear(),
            Action::Char(c) => editor.insert_char(c),
            Action::Backspace => editor.backspace(),
            Action::Delete => editor.delete(),
            Action::DeleteToBufferHome => editor.delete_to_buffer_home(),
            Action::Newline => editor.insert_char('\n'),
            Action::Left => editor.left(),
            Action::Right => editor.right(),
            Action::WordLeft => editor.word_left(),
            Action::WordRight => editor.word_right(),
            Action::Up => editor.up(),
            Action::Down => editor.down(),
            Action::Home => editor.home(),
            Action::End => editor.end(),
            Action::Submit(_) | Action::None | Action::Quit | Action::Complete | Action::AbortTurn | Action::CtrlC | Action::ScrollUp | Action::ScrollDown | Action::PageUp | Action::PageDown => {}
        }
        action
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
    fn word_and_buffer_motions_work() {
        let mut e = ed("one  two\nthree");
        e.word_left();
        assert_eq!(e.cursor, "one  two\n".len());
        e.word_left();
        assert_eq!(e.cursor, "one  ".len());
        e.word_left();
        assert_eq!(e.cursor, 0);
        e.word_right();
        assert_eq!(e.cursor, "one".len());
        e.word_right();
        assert_eq!(e.cursor, "one  two".len());
        e.buffer_end();
        assert_eq!(e.cursor, e.text().len());
        e.buffer_home();
        assert_eq!(e.cursor, 0);
    }

    #[test]
    fn wrapped_input_rows_and_cursor_are_tracked() {
        assert_eq!(input_rows("abcdef", 5), 2);
        assert_eq!(visual_cursor("abcdef", 6, 5), (1, 3));
        assert_eq!(visual_cursor("ab\ncdef", 6, 5), (1, 3));
    }

    #[test]
    fn mouse_wheel_scrolls_transcript() {
        let mut scroll = 5u16;
        let mut follow = true;

        match MouseEventKind::ScrollUp {
            MouseEventKind::ScrollUp => {
                follow = false;
                scroll = scroll.saturating_sub(3);
            }
            MouseEventKind::ScrollDown => {
                scroll = scroll.saturating_add(3);
            }
            _ => {}
        }
        assert_eq!(scroll, 2);
        assert!(!follow);

        let before = follow;
        match MouseEventKind::ScrollDown {
            MouseEventKind::ScrollUp => {
                follow = false;
                scroll = scroll.saturating_sub(3);
            }
            MouseEventKind::ScrollDown => {
                scroll = scroll.saturating_add(3);
            }
            _ => {}
        }
        assert_eq!(scroll, 5);
        assert_eq!(follow, before);
    }

    #[test]
    fn max_scroll_counts_wrapped_transcript_rows() {
        let transcript = vec![
            Line::from("1234567890"),
            Line::from("1234567890"),
            Line::from("tiny"),
        ];
        assert_eq!(transcript_rows(&transcript, 5), 10);
        assert_eq!(max_scroll(&transcript, 5, 3), 7);
    }

    #[test]
    fn enter_submits_while_chords_insert_newlines() {
        let plain = |c| key(c, KeyModifiers::NONE);
        // Plain Enter submits (the whole bug).
        assert!(
            matches!(key_to_action(plain(KeyCode::Enter), false, "hi"), Action::Submit(s) if s == "hi")
        );
        // Shift+Enter and Ctrl-J insert a newline, but shifted printable chars still type normally.
        assert!(matches!(
            key_to_action(key(KeyCode::Enter, KeyModifiers::SHIFT), false, "hi"),
            Action::Newline
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('j'), KeyModifiers::CONTROL), false, "hi"),
            Action::Newline
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('A'), KeyModifiers::SHIFT), false, "hi"),
            Action::Char('A')
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char(':'), KeyModifiers::SHIFT), false, "hi"),
            Action::Char(':')
        ));
        // Arrows move the cursor; Alt+arrows jump by word; Cmd/Super+arrows jump to line edges.
        assert!(matches!(
            key_to_action(plain(KeyCode::Left), false, "hi"),
            Action::Left
        ));
        assert!(matches!(
            key_to_action(plain(KeyCode::Up), false, "hi"),
            Action::Up
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Left, KeyModifiers::ALT), false, "hi"),
            Action::WordLeft
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Right, KeyModifiers::ALT), false, "hi"),
            Action::WordRight
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Left, KeyModifiers::SUPER), false, "hi"),
            Action::Home
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Right, KeyModifiers::SUPER), false, "hi"),
            Action::End
        ));
        // Typing is ignored mid-turn, but Esc interrupts, Ctrl-C signals quit, and Ctrl+↑ scrolls.
        assert!(matches!(
            key_to_action(plain(KeyCode::Char('x')), true, ""),
            Action::None
        ));
        assert!(matches!(
            key_to_action(plain(KeyCode::Esc), true, ""),
            Action::AbortTurn
        ));
        assert!(matches!(
            key_to_action(plain(KeyCode::Esc), false, "hi"),
            Action::ClearInput
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('c'), KeyModifiers::CONTROL), true, ""),
            Action::CtrlC
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Up, KeyModifiers::CONTROL), true, ""),
            Action::ScrollUp
        ));
    }

    #[test]
    fn key_to_action_mapping_matrix_covers_nontrivial_branches() {
        assert!(matches!(
            key_to_action(key(KeyCode::Char('d'), KeyModifiers::CONTROL), false, "hi"),
            Action::Quit
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::PageUp, KeyModifiers::NONE), false, "hi"),
            Action::PageUp
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::PageDown, KeyModifiers::NONE), false, "hi"),
            Action::PageDown
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Down, KeyModifiers::CONTROL), false, "hi"),
            Action::ScrollDown
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Tab, KeyModifiers::NONE), false, "hi"),
            Action::Complete
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Backspace, KeyModifiers::SUPER), false, "hi"),
            Action::DeleteToBufferHome
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Backspace, KeyModifiers::NONE), false, "hi"),
            Action::Backspace
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Delete, KeyModifiers::NONE), false, "hi"),
            Action::Delete
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Home, KeyModifiers::NONE), false, "hi"),
            Action::Home
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::End, KeyModifiers::NONE), false, "hi"),
            Action::End
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('b'), KeyModifiers::ALT), false, "hi"),
            Action::WordLeft
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('B'), KeyModifiers::ALT), false, "hi"),
            Action::WordLeft
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('f'), KeyModifiers::ALT), false, "hi"),
            Action::WordRight
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('F'), KeyModifiers::ALT), false, "hi"),
            Action::WordRight
        ));
    }

    #[test]
    fn running_turn_allows_only_interrupt_quit_scroll_and_alt_word_aliases() {
        assert!(matches!(
            key_to_action(key(KeyCode::Esc, KeyModifiers::NONE), true, "hi"),
            Action::AbortTurn
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('c'), KeyModifiers::CONTROL), true, "hi"),
            Action::CtrlC
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('d'), KeyModifiers::CONTROL), true, "hi"),
            Action::Quit
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::PageUp, KeyModifiers::NONE), true, "hi"),
            Action::PageUp
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::PageDown, KeyModifiers::NONE), true, "hi"),
            Action::PageDown
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Up, KeyModifiers::CONTROL), true, "hi"),
            Action::ScrollUp
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Down, KeyModifiers::CONTROL), true, "hi"),
            Action::ScrollDown
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('b'), KeyModifiers::ALT), true, "hi"),
            Action::WordLeft
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('f'), KeyModifiers::ALT), true, "hi"),
            Action::WordRight
        ));

        assert!(matches!(
            key_to_action(key(KeyCode::Enter, KeyModifiers::NONE), true, "hi"),
            Action::None
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Tab, KeyModifiers::NONE), true, "hi"),
            Action::None
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Left, KeyModifiers::NONE), true, "hi"),
            Action::None
        ));
        assert!(matches!(
            key_to_action(key(KeyCode::Char('x'), KeyModifiers::NONE), true, "hi"),
            Action::None
        ));
    }

    #[test]
    fn keystroke_sequence_distinguishes_submit_from_multiline_newline_chords() {
        let mut e = Editor::default();
        apply_key(&mut e, key(KeyCode::Char('a'), KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::NONE), false);
        assert_eq!(e.text(), "a\nb");

        let submitted = apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::NONE), false);
        assert!(matches!(submitted, Action::Submit(s) if s == "a\nb"));

        let mut ctrl_j = Editor::default();
        apply_key(&mut ctrl_j, key(KeyCode::Char('x'), KeyModifiers::NONE), false);
        apply_key(&mut ctrl_j, key(KeyCode::Char('j'), KeyModifiers::CONTROL), false);
        apply_key(&mut ctrl_j, key(KeyCode::Char('y'), KeyModifiers::NONE), false);
        assert_eq!(ctrl_j.text(), "x\ny");

        let mut alt_enter = Editor::default();
        apply_key(&mut alt_enter, key(KeyCode::Char('m'), KeyModifiers::NONE), false);
        apply_key(&mut alt_enter, key(KeyCode::Enter, KeyModifiers::ALT), false);
        apply_key(&mut alt_enter, key(KeyCode::Char('n'), KeyModifiers::NONE), false);
        assert_eq!(alt_enter.text(), "m\nn");

        let mut ctrl_enter = Editor::default();
        apply_key(&mut ctrl_enter, key(KeyCode::Char('p'), KeyModifiers::NONE), false);
        apply_key(&mut ctrl_enter, key(KeyCode::Enter, KeyModifiers::CONTROL), false);
        apply_key(&mut ctrl_enter, key(KeyCode::Char('q'), KeyModifiers::NONE), false);
        assert_eq!(ctrl_enter.text(), "p\nq");
    }

    #[test]
    fn alt_word_aliases_match_alt_arrow_word_motion() {
        let mut e = ed("one two three");
        apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::ALT), false);
        assert_eq!(e.cursor, "one two ".len());
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::ALT), false);
        assert_eq!(e.cursor, "one ".len());
        apply_key(&mut e, key(KeyCode::Char('f'), KeyModifiers::ALT), false);
        assert_eq!(e.cursor, "one two".len());
    }

    #[test]
    fn destructive_editing_shortcuts_apply_through_actions() {
        let mut e = ed("abc def");
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "f");
        assert_eq!(e.cursor, 0);

        let mut e = ed("abcd");
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::NONE), false);
        assert_eq!(e.text(), "acd");
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::NONE), false);
        assert_eq!(e.text(), "ad");
    }
}
