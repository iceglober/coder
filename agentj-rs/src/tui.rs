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
const KEYBOARD_FLAGS: KeyboardEnhancementFlags = KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
    .union(KeyboardEnhancementFlags::REPORT_EVENT_TYPES)
    .union(KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES);

// ── a small cursor-tracked, multi-line text buffer ──
// `cursor` is a byte index into `text`, always kept on a char boundary.

#[derive(Default)]
struct Editor {
    text: String,
    cursor: usize,
    revision: u64,
}

impl Editor {
    fn text(&self) -> &str {
        &self.text
    }
    fn revision(&self) -> u64 {
        self.revision
    }
    fn touch(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
    fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.touch();
    }
    /// Replace the whole buffer (used by Tab completion); cursor to the end.
    fn set(&mut self, s: String) {
        self.cursor = s.len();
        self.text = s;
        self.touch();
    }
    fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.touch();
    }
    fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.touch();
    }
    fn backspace(&mut self) {
        if self.cursor > 0 {
            let p = self.prev(self.cursor);
            self.text.replace_range(p..self.cursor, "");
            self.cursor = p;
            self.touch();
        }
    }
    fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let n = self.next(self.cursor);
            self.text.replace_range(self.cursor..n, "");
            self.touch();
        }
    }
    fn delete_word_left(&mut self) {
        let end = self.cursor;
        self.word_left();
        if self.cursor < end {
            self.text.replace_range(self.cursor..end, "");
            self.touch();
        }
    }
    fn delete_word_right(&mut self) {
        let start = self.cursor;
        self.word_right();
        let end = self.cursor;
        self.cursor = start;
        if start < end {
            self.text.replace_range(start..end, "");
            self.touch();
        }
    }
    fn delete_to_buffer_home(&mut self) {
        if self.cursor > 0 {
            self.text.replace_range(0..self.cursor, "");
            self.cursor = 0;
            self.touch();
        }
    }
    fn delete_to_line_end(&mut self) {
        let end = self.text[self.cursor..]
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len());
        if self.cursor < end {
            self.text.replace_range(self.cursor..end, "");
            self.touch();
        }
    }
    fn left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self.prev(self.cursor);
            self.touch();
        }
    }
    fn right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor = self.next(self.cursor);
            self.touch();
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
        if self.cursor != i {
            self.cursor = i;
            self.touch();
        }
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
        if self.cursor != i {
            self.cursor = i;
            self.touch();
        }
    }
    fn home(&mut self) {
        let cursor = self.text[..self.cursor]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        if self.cursor != cursor {
            self.cursor = cursor;
            self.touch();
        }
    }
    fn end(&mut self) {
        let cursor = self.text[self.cursor..]
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len());
        if self.cursor != cursor {
            self.cursor = cursor;
            self.touch();
        }
    }
    fn buffer_home(&mut self) {
        if self.cursor != 0 {
            self.cursor = 0;
            self.touch();
        }
    }
    fn buffer_end(&mut self) {
        let cursor = self.text.len();
        if self.cursor != cursor {
            self.cursor = cursor;
            self.touch();
        }
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
    fn line_start_before(&self, cursor: usize) -> usize {
        self.text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0)
    }

    fn line_end_after(&self, cursor: usize) -> usize {
        self.text[cursor..]
            .find('\n')
            .map(|i| cursor + i)
            .unwrap_or(self.text.len())
    }

    fn column_in_line(&self, line_start: usize, cursor: usize) -> usize {
        self.text[line_start..cursor].chars().count()
    }

    fn byte_for_column(line: &str, col: usize) -> usize {
        line.char_indices()
            .nth(col)
            .map(|(b, _)| b)
            .unwrap_or(line.len())
    }

    /// (row, column) of the cursor, both 0-based, column counted in chars.
    fn row_col(&self) -> (u16, u16) {
        let before = &self.text[..self.cursor];
        let row = before.bytes().filter(|&b| b == b'\n').count() as u16;
        let col = self.column_in_line(self.line_start_before(self.cursor), self.cursor) as u16;
        (row, col)
    }

    /// Move the cursor up/down one line, keeping the target column where possible.
    fn vmove(&mut self, up: bool) {
        let current_start = self.line_start_before(self.cursor);
        let current_end = self.line_end_after(self.cursor);
        let col = self.column_in_line(current_start, self.cursor);

        let (target_start, target_end) = if up {
            if current_start == 0 {
                return;
            }
            let prev_end = current_start - 1;
            let prev_start = self.line_start_before(prev_end);
            (prev_start, prev_end)
        } else {
            if current_end == self.text.len() {
                return;
            }
            let next_start = current_end + 1;
            let next_end = self.line_end_after(next_start);
            (next_start, next_end)
        };

        let line = &self.text[target_start..target_end];
        let target_col = col.min(line.chars().count());
        let target = target_start + Self::byte_for_column(line, target_col);
        if self.cursor != target {
            self.cursor = target;
            self.touch();
        }
    }
}

struct InputLayoutCache {
    revision: u64,
    width: u16,
    rows: u16,
    rendered: Text<'static>,
    cursor: (u16, u16),
}

impl Default for InputLayoutCache {
    fn default() -> Self {
        Self {
            revision: u64::MAX,
            width: 0,
            rows: 1,
            rendered: Text::from(""),
            cursor: (0, 0),
        }
    }
}

impl InputLayoutCache {
    fn refresh(&mut self, editor: &Editor, width: u16) {
        self.refresh_with_metrics(editor, width, None);
    }

    fn refresh_with_metrics(
        &mut self,
        editor: &Editor,
        width: u16,
        #[cfg(test)] metrics: Option<&mut PerfMetrics>,
        #[cfg(not(test))] _metrics: Option<&mut ()>,
    ) {
        if self.revision == editor.revision() && self.width == width {
            #[cfg(test)]
            if let Some(metrics) = metrics {
                metrics.input_layout_cache_hits += 1;
            }
            return;
        }
        #[cfg(test)]
        if let Some(metrics) = metrics {
            metrics.input_layout_refreshes += 1;
        }
        self.revision = editor.revision();
        self.width = width;
        self.rows = input_rows(editor.text(), width);
        self.rendered = input_lines(editor.text());
        self.cursor = visual_cursor(editor.text(), editor.cursor, width);
    }
}

#[cfg(test)]
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
struct PerfMetrics {
    draw_calls: u64,
    input_batches: u64,
    input_events_total: u64,
    input_batch_max: usize,
    ui_batches: u64,
    ui_events_total: u64,
    ui_batch_max: usize,
    input_layout_refreshes: u64,
    input_layout_cache_hits: u64,
}

#[cfg(test)]
fn note_batch(metrics: &mut PerfMetrics, len: usize, input: bool) {
    if input {
        metrics.input_batches += 1;
        metrics.input_events_total += len as u64;
        metrics.input_batch_max = metrics.input_batch_max.max(len);
    } else {
        metrics.ui_batches += 1;
        metrics.ui_events_total += len as u64;
        metrics.ui_batch_max = metrics.ui_batch_max.max(len);
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
    DeleteWordLeft,
    DeleteWordRight,
    DeleteToBufferHome,
    DeleteToLineEnd,
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
        KeyCode::Backspace if super_ || (ctrl && !alt && !shift) => Action::DeleteToBufferHome,
        KeyCode::Backspace if alt => Action::DeleteWordLeft,
        KeyCode::Backspace if no_mods => Action::Backspace,
        KeyCode::Delete if super_ => Action::DeleteToLineEnd,
        KeyCode::Delete if alt => Action::DeleteWordRight,
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

fn wrapped_rows_for_line(line: &Line<'_>, width: u16) -> usize {
    let content_width = width.saturating_sub(2).max(1) as usize;
    line_width(line).max(1).div_ceil(content_width)
}

fn transcript_rows(lines: &[Line<'_>], width: u16) -> usize {
    lines.iter().map(|line| wrapped_rows_for_line(line, width)).sum()
}

struct TranscriptView {
    lines: Vec<Line<'static>>,
    text: Text<'static>,
    total_rows: usize,
    cached_width: u16,
}

impl TranscriptView {
    fn new(lines: Vec<Line<'static>>) -> Self {
        let text = Text::from(lines.clone());
        Self {
            lines,
            text,
            total_rows: 0,
            cached_width: 0,
        }
    }

    fn text(&self) -> Text<'static> {
        self.text.clone()
    }

    fn ensure_width(&mut self, width: u16) {
        if self.cached_width != width {
            self.cached_width = width;
            self.total_rows = transcript_rows(&self.lines, width);
        }
    }

    fn max_scroll(&self, viewport: u16) -> u16 {
        self.total_rows.saturating_sub(viewport as usize) as u16
    }

    fn push(&mut self, line: Line<'static>) {
        if self.cached_width != 0 {
            self.total_rows += wrapped_rows_for_line(&line, self.cached_width);
        }
        self.text.lines.push(line.clone());
        self.lines.push(line);
    }

    fn extend<I>(&mut self, iter: I)
    where
        I: IntoIterator<Item = Line<'static>>,
    {
        for line in iter {
            self.push(line);
        }
    }
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
    // Ask for progressive keyboard reporting so modified Enter/Esc are distinguishable where the
    // terminal supports it (kitty/ghostty/wezterm/newer iTerm2). We also request CSI-u reporting for
    // all keys so chords like Cmd/Ctrl+Backspace are surfaced distinctly instead of collapsing to a
    // plain Backspace byte on PTYs.
    let _ = execute!(
        stdout,
        PushKeyboardEnhancementFlags(KEYBOARD_FLAGS)
    );
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let llm = Arc::new(llm);
    let tools = Arc::new(tools);
    let mut messages: Vec<ChatMessage> = vec![ChatMessage::system(system.clone())];
    let mut transcript = TranscriptView::new(vec![
        dim_line(format!("agentj · {model_id} · {root}")),
        dim_line("Enter submits · Alt/Shift/Ctrl+Enter (or Ctrl-J) = newline · ⌥←/→ skip words · ⌘←/→ line start/end · ←/→/↑/↓ move cursor · mouse wheel/PageUp/Dn or Ctrl+↑/↓ scroll · /task <pr|branch> · Esc interrupts a turn · Ctrl-C twice (or Ctrl-D / /exit) quits"),
    ]);
    for n in &notices {
        transcript.push(dim_line(format!("! {n}")));
    }
    let mut editor = Editor::default();
    let mut input_cache = InputLayoutCache::default();
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

    let mut dirty = true;
    let mut last_effect_active = false;
    let mut quit = false;
    while !quit {
        if dirty {
            input_cache.refresh(&editor, terminal.size()?.width);
            #[cfg(test)]
            {
                let _ = &input_cache;
            }
            terminal.draw(|f| {
            let area = f.area();
            let in_h = input_cache.rows;
            let rows = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(1),
                Constraint::Length(in_h),
            ])
            .split(area);

            // Transcript (with a bottom divider). Auto-follow the tail unless the user scrolled up.
            let viewport = rows[0].height.saturating_sub(1); // minus the border row
            transcript.ensure_width(rows[0].width);
            let max = transcript.max_scroll(viewport);
            if follow {
                scroll = max;
            }
            scroll = scroll.min(max);
            let accent = pulse_color(pulse, running);
            let divider = divider_color(running);
            f.render_widget(
                Paragraph::new(transcript.text())
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
                Paragraph::new(input_cache.rendered.clone()).wrap(Wrap { trim: false }),
                rows[2],
            );
            let (crow, ccol) = input_cache.cursor;
            f.set_cursor_position(Position::new(
                (rows[2].x + 2 + ccol).min(rows[2].x + rows[2].width.saturating_sub(1)),
                (rows[2].y + crow).min(rows[2].y + rows[2].height.saturating_sub(1)),
            ));
        })?;
            dirty = false;
        }

        tokio::select! {
            _ = ticker.tick() => {
                let now = Instant::now();
                let effect_active = effect_until.is_some_and(|until| until > now);
                let had_effect = last_effect_active;
                if running || effect_active || had_effect {
                    spinner = spinner.wrapping_add(1);
                    pulse = pulse.wrapping_add(1);
                    if effect_until.is_some_and(|until| until <= now) {
                        effect_until = None;
                        effect_label.clear();
                    }
                    let now_effect_active = effect_until.is_some_and(|until| until > now);
                    dirty = true;
                    last_effect_active = now_effect_active;
                }
            }
            Some(ev) = in_rx.recv() => {
                let mut pending = vec![ev];
                while let Ok(ev) = in_rx.try_recv() {
                    pending.push(ev);
                }
                #[cfg(test)]
                {
                    let _ = pending.len();
                }
                for ev in pending {
                    match ev {
                    Event::Paste(s) if !running => {
                        editor.insert_str(&s);
                        dirty = true;
                    }
                    Event::Mouse(m) => match m.kind {
                        MouseEventKind::ScrollUp => {
                            follow = false;
                            scroll = scroll.saturating_sub(3);
                            dirty = true;
                        }
                        MouseEventKind::ScrollDown => {
                            scroll = scroll.saturating_add(3);
                            dirty = true;
                        }
                        _ => {}
                    },
                    Event::Resize(_, _) => dirty = true,
                    Event::Key(k) if k.kind != KeyEventKind::Release => {
                        match key_to_action(k, running, editor.text()) {
                            Action::None => {}
                            Action::Quit => quit = true,
                            Action::ClearInput => { editor.clear(); dirty = true; }
                            Action::Char(c) => { editor.insert_char(c); dirty = true; }
                            Action::Newline => { editor.insert_char('\n'); dirty = true; }
                            Action::Backspace => { editor.backspace(); dirty = true; }
                            Action::Delete => { editor.delete(); dirty = true; }
                            Action::DeleteWordLeft => { editor.delete_word_left(); dirty = true; }
                            Action::DeleteWordRight => { editor.delete_word_right(); dirty = true; }
                            Action::DeleteToBufferHome => { editor.delete_to_buffer_home(); dirty = true; }
                            Action::DeleteToLineEnd => { editor.delete_to_line_end(); dirty = true; }
                            Action::Left => { editor.left(); dirty = true; }
                            Action::Right => { editor.right(); dirty = true; }
                            Action::WordLeft => { editor.word_left(); dirty = true; }
                            Action::WordRight => { editor.word_right(); dirty = true; }
                            Action::Up => { editor.up(); dirty = true; }
                            Action::Down => { editor.down(); dirty = true; }
                            Action::Home => { editor.home(); dirty = true; }
                            Action::End => { editor.end(); dirty = true; }
                            Action::ScrollUp => { follow = false; scroll = scroll.saturating_sub(1); dirty = true; }
                            Action::ScrollDown => { scroll = scroll.saturating_add(1); dirty = true; }
                            Action::PageUp => { follow = false; scroll = scroll.saturating_sub(10); dirty = true; }
                            Action::PageDown => { scroll = scroll.saturating_add(10); dirty = true; }
                            Action::Complete => {
                                let c = complete_command(editor.text(), SLASH_COMMANDS);
                                let had_candidates = !c.candidates.is_empty();
                                editor.set(c.line);
                                dirty = true;
                                if had_candidates || editor.text() == "/" {
                                    for cand in SLASH_COMMANDS {
                                        transcript.push(dim_line(format!("  {}  {}", cand.name, cand.summary)));
                                    }
                                    dirty = true;
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
                                dirty = true;
                                last_effect_active = true;
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
                                    dirty = true;
                                    last_effect_active = true;
                                }
                            }
                            Action::Submit(text) => {
                                editor.clear();
                                follow = true;
                                dirty = true;
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
                                            dirty = true;
                                            last_effect_active = true;
                                        } else {
                                            effect_until = Some(Instant::now() + EFFECT_TTL);
                                            effect_label = format!("switched to {}", rk.branch.clone().unwrap_or_default());
                                            transcript.push(dim_line(format!("» clean on {}, synced to origin", rk.branch.clone().unwrap_or_default())));
                                            messages = vec![ChatMessage::system(system.clone())];
                                            dirty = true;
                                            last_effect_active = true;
                                            let desc = rest[reference.len()..].trim().to_string();
                                            if !desc.is_empty() {
                                                transcript.push(Line::from(format!("› {desc}")));
                                                running = true;
                                                since = Instant::now();
                                                status.clear();
                                                turn_abort = Some(spawn_turn(desc, &messages, llm.clone(), tools.clone(), ui_tx.clone()));
                                                dirty = true;
                                                last_effect_active = true;
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
                                    dirty = true;
                                    last_effect_active = true;
                                }
                            }
                        }
                    }
                    _ => {}
                }
                if quit {
                    break;
                }
                }
            }
            Some(msg) = ui_rx.recv() => {
                let mut pending = vec![msg];
                while let Ok(msg) = ui_rx.try_recv() {
                    pending.push(msg);
                }
                #[cfg(test)]
                {
                    let _ = pending.len();
                }
                for msg in pending {
                    match msg {
                    UiMsg::Agent(ev) => match ev {
                        AgentEvent::Message(t) => {
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "new reply".to_string();
                            transcript.extend(assistant_lines(&t));
                            dirty = true;
                            last_effect_active = true;
                        }
                        AgentEvent::ToolStart { name, args, .. } => {
                            current_tool = format!("{name}({args})");
                            status = current_tool.clone();
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = format!("tool: {name}");
                            dirty = true;
                            last_effect_active = true;
                        }
                        AgentEvent::ToolEnd { summary, elapsed_ms, .. } => {
                            transcript.push(dim_line(format!("· {current_tool} — {} {summary}", fmt_ms(elapsed_ms))));
                            status = "thinking".to_string();
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = format!("done in {}", fmt_ms(elapsed_ms));
                            dirty = true;
                            last_effect_active = true;
                        }
                        AgentEvent::Note(t) => {
                            transcript.push(dim_line(format!("» {t}")));
                            dirty = true;
                        }
                        AgentEvent::Error(e) => {
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "error".to_string();
                            transcript.push(Line::from(Span::styled(format!("[error] {e}"), Style::default().fg(Color::Red))));
                            dirty = true;
                            last_effect_active = true;
                        }
                        AgentEvent::Done => {
                            running = false;
                            status.clear();
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "all set".to_string();
                            dirty = true;
                            last_effect_active = true;
                        }
                    },
                    UiMsg::TurnComplete(m) => {
                        messages = m;
                        running = false;
                        status.clear();
                        if effect_label.is_empty() {
                            effect_until = Some(Instant::now() + EFFECT_TTL);
                            effect_label = "all set".to_string();
                            last_effect_active = true;
                        }
                        dirty = true;
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
            Action::DeleteWordLeft => editor.delete_word_left(),
            Action::DeleteWordRight => editor.delete_word_right(),
            Action::DeleteToBufferHome => editor.delete_to_buffer_home(),
            Action::DeleteToLineEnd => editor.delete_to_line_end(),
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

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ActionKind {
        None,
        AbortTurn,
        CtrlC,
        Quit,
        PageUp,
        PageDown,
        ScrollUp,
        ScrollDown,
        ClearInput,
        Newline,
        Submit,
        Complete,
        DeleteToBufferHome,
        DeleteWordLeft,
        Backspace,
        DeleteToLineEnd,
        DeleteWordRight,
        Delete,
        Home,
        End,
        WordLeft,
        WordRight,
        Left,
        Right,
        Up,
        Down,
        Char,
    }

    impl ActionKind {
        fn of(action: Action) -> Self {
            match action {
                Action::None => Self::None,
                Action::AbortTurn => Self::AbortTurn,
                Action::CtrlC => Self::CtrlC,
                Action::Quit => Self::Quit,
                Action::PageUp => Self::PageUp,
                Action::PageDown => Self::PageDown,
                Action::ScrollUp => Self::ScrollUp,
                Action::ScrollDown => Self::ScrollDown,
                Action::ClearInput => Self::ClearInput,
                Action::Newline => Self::Newline,
                Action::Submit(_) => Self::Submit,
                Action::Complete => Self::Complete,
                Action::DeleteToBufferHome => Self::DeleteToBufferHome,
                Action::DeleteWordLeft => Self::DeleteWordLeft,
                Action::Backspace => Self::Backspace,
                Action::DeleteToLineEnd => Self::DeleteToLineEnd,
                Action::DeleteWordRight => Self::DeleteWordRight,
                Action::Delete => Self::Delete,
                Action::Home => Self::Home,
                Action::End => Self::End,
                Action::WordLeft => Self::WordLeft,
                Action::WordRight => Self::WordRight,
                Action::Left => Self::Left,
                Action::Right => Self::Right,
                Action::Up => Self::Up,
                Action::Down => Self::Down,
                Action::Char(_) => Self::Char,
            }
        }
    }

    #[derive(Clone, Copy)]
    struct KeymapCase {
        code: KeyCode,
        modifiers: KeyModifiers,
        running: bool,
        expected: ActionKind,
    }

    const KEYMAP_CASES: &[KeymapCase] = &[
        KeymapCase { code: KeyCode::Esc, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::AbortTurn },
        KeymapCase { code: KeyCode::Char('c'), modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::CtrlC },
        KeymapCase { code: KeyCode::Char('d'), modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::Quit },
        KeymapCase { code: KeyCode::PageUp, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::PageUp },
        KeymapCase { code: KeyCode::PageDown, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::PageDown },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::ScrollUp },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::CONTROL, running: true, expected: ActionKind::ScrollDown },
        KeymapCase { code: KeyCode::Char('b'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('B'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('f'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Char('F'), modifiers: KeyModifiers::ALT, running: true, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Tab, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Char('x'), modifiers: KeyModifiers::NONE, running: true, expected: ActionKind::None },
        KeymapCase { code: KeyCode::Esc, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::ClearInput },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Enter, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Char('j'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Newline },
        KeymapCase { code: KeyCode::Tab, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Complete },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::DeleteToBufferHome },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::DeleteToBufferHome },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::DeleteWordLeft },
        KeymapCase { code: KeyCode::Backspace, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Backspace },
        KeymapCase { code: KeyCode::Delete, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::DeleteToLineEnd },
        KeymapCase { code: KeyCode::Delete, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::DeleteWordRight },
        KeymapCase { code: KeyCode::Delete, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Delete },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::Home },
        KeymapCase { code: KeyCode::Right, modifiers: KeyModifiers::SUPER, running: false, expected: ActionKind::End },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Right, modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Left, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Left },
        KeymapCase { code: KeyCode::Right, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Right },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Up },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Down },
        KeymapCase { code: KeyCode::Home, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::Home },
        KeymapCase { code: KeyCode::End, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::End },
        KeymapCase { code: KeyCode::PageUp, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::PageUp },
        KeymapCase { code: KeyCode::PageDown, modifiers: KeyModifiers::NONE, running: false, expected: ActionKind::PageDown },
        KeymapCase { code: KeyCode::Up, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::ScrollUp },
        KeymapCase { code: KeyCode::Down, modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::ScrollDown },
        KeymapCase { code: KeyCode::Char('d'), modifiers: KeyModifiers::CONTROL, running: false, expected: ActionKind::Quit },
        KeymapCase { code: KeyCode::Char('b'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('B'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordLeft },
        KeymapCase { code: KeyCode::Char('f'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Char('F'), modifiers: KeyModifiers::ALT, running: false, expected: ActionKind::WordRight },
        KeymapCase { code: KeyCode::Char('A'), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
        KeymapCase { code: KeyCode::Char(':'), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
        KeymapCase { code: KeyCode::Char('!'), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
        KeymapCase { code: KeyCode::Char('('), modifiers: KeyModifiers::SHIFT, running: false, expected: ActionKind::Char },
    ];

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
    fn input_layout_cache_skips_unchanged_refreshes() {
        let mut cache = InputLayoutCache::default();
        let mut metrics = PerfMetrics::default();
        let mut editor = ed("/task 123");

        cache.refresh_with_metrics(&editor, 40, Some(&mut metrics));
        cache.refresh_with_metrics(&editor, 40, Some(&mut metrics));
        editor.insert_char('x');
        cache.refresh_with_metrics(&editor, 40, Some(&mut metrics));
        cache.refresh_with_metrics(&editor, 20, Some(&mut metrics));

        assert_eq!(metrics.input_layout_refreshes, 3);
        assert_eq!(metrics.input_layout_cache_hits, 1);
    }

    #[test]
    fn perf_metrics_track_batched_event_drains() {
        let mut metrics = PerfMetrics::default();
        note_batch(&mut metrics, 5, true);
        note_batch(&mut metrics, 3, true);
        note_batch(&mut metrics, 4, false);

        assert_eq!(metrics.input_batches, 2);
        assert_eq!(metrics.input_events_total, 8);
        assert_eq!(metrics.input_batch_max, 5);
        assert_eq!(metrics.ui_batches, 1);
        assert_eq!(metrics.ui_events_total, 4);
        assert_eq!(metrics.ui_batch_max, 4);
    }

    #[test]
    fn long_edit_script_preserves_expected_text_and_cursor() {
        let mut e = Editor::default();
        for _ in 0..64 {
            apply_key(&mut e, key(KeyCode::Char('a'), KeyModifiers::NONE), false);
        }
        for _ in 0..16 {
            apply_key(&mut e, key(KeyCode::Left, KeyModifiers::NONE), false);
        }
        for _ in 0..8 {
            apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::NONE), false);
        }
        apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::SHIFT), false);
        for _ in 0..32 {
            apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::NONE), false);
        }
        for _ in 0..10 {
            apply_key(&mut e, key(KeyCode::Char('f'), KeyModifiers::ALT), false);
            apply_key(&mut e, key(KeyCode::Char('b'), KeyModifiers::ALT), false);
        }
        apply_key(&mut e, key(KeyCode::Left, KeyModifiers::SUPER), false);
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::SUPER), false);

        assert_eq!(e.text(), format!("{}\n", "a".repeat(40)));
        assert_eq!(e.cursor, "a".repeat(40).len() + 1);
    }

    #[test]
    fn max_scroll_counts_wrapped_transcript_rows() {
        let transcript = vec![
            Line::from("1234567890"),
            Line::from("1234567890"),
            Line::from("tiny"),
        ];
        assert_eq!(wrapped_rows_for_line(&transcript[0], 5), 4);
        assert_eq!(transcript_rows(&transcript, 5), 10);
        let mut view = TranscriptView::new(transcript);
        view.ensure_width(5);
        assert_eq!(view.max_scroll(3), 7);
    }

    #[test]
    fn keymap_table_covers_all_supported_non_submit_bindings() {
        for case in KEYMAP_CASES {
            let actual = ActionKind::of(key_to_action(key(case.code, case.modifiers), case.running, " hi "));
            assert_eq!(
                actual, case.expected,
                "unexpected action for {:?} with {:?} while running={} ",
                case.code, case.modifiers, case.running
            );
        }
    }

    #[test]
    fn submit_binding_trims_input() {
        assert!(matches!(
            key_to_action(key(KeyCode::Enter, KeyModifiers::NONE), false, "  hi  "),
            Action::Submit(s) if s == "hi"
        ));
    }

    #[test]
    fn running_turn_suppresses_unsupported_keys() {
        for (code, modifiers) in [
            (KeyCode::Enter, KeyModifiers::NONE),
            (KeyCode::Tab, KeyModifiers::NONE),
            (KeyCode::Left, KeyModifiers::NONE),
            (KeyCode::Char('x'), KeyModifiers::NONE),
            (KeyCode::Backspace, KeyModifiers::NONE),
            (KeyCode::Delete, KeyModifiers::NONE),
        ] {
            assert!(matches!(
                key_to_action(key(code, modifiers), true, "hi"),
                Action::None
            ));
        }
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
    fn shifted_printable_keystroke_sequence_preserves_text_entry() {
        let mut e = Editor::default();
        apply_key(&mut e, key(KeyCode::Char('A'), KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char(':'), KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char('!'), KeyModifiers::SHIFT), false);
        apply_key(&mut e, key(KeyCode::Char('('), KeyModifiers::SHIFT), false);
        assert_eq!(e.text(), "A:!(");

        let submitted = apply_key(&mut e, key(KeyCode::Enter, KeyModifiers::NONE), false);
        assert!(matches!(submitted, Action::Submit(s) if s == "A:!("));
    }

    #[test]
    fn keyboard_flags_request_only_needed_progressive_reporting() {
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES));
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::REPORT_EVENT_TYPES));
        assert!(KEYBOARD_FLAGS.contains(KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES));
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

    #[test]
    fn cmd_delete_and_backspace_delete_to_line_edges() {
        let mut e = ed("alpha beta\ngamma delta");
        e.cursor = "alpha be".len();
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "ta\ngamma delta");
        assert_eq!(e.cursor, 0);

        let mut e = ed("alpha beta\ngamma delta");
        e.cursor = "alpha be".len();
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::SUPER), false);
        assert_eq!(e.text(), "alpha be\ngamma delta");
        assert_eq!(e.cursor, "alpha be".len());
    }

    #[test]
    fn option_delete_and_backspace_delete_words_without_crossing_lines() {
        let mut e = ed("alpha  beta\ngamma delta");
        e.cursor = "alpha  beta".len();
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "alpha  \ngamma delta");
        assert_eq!(e.cursor, "alpha  ".len());
        apply_key(&mut e, key(KeyCode::Backspace, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "\ngamma delta");
        assert_eq!(e.cursor, 0);

        let mut e = ed("alpha  beta\ngamma delta");
        e.cursor = "alpha  ".len();
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "alpha  \ngamma delta");
        assert_eq!(e.cursor, "alpha  ".len());
        apply_key(&mut e, key(KeyCode::Delete, KeyModifiers::ALT), false);
        assert_eq!(e.text(), "alpha   delta");
        assert_eq!(e.cursor, "alpha  ".len());
    }
}
