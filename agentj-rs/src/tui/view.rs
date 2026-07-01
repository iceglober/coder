//! Rendering: turns `App` state into the three-region ratatui layout (transcript / status / input),
//! plus the transcript/input line builders and their cached row-count bookkeeping.

use super::app::App;
use super::editor::Editor;
use super::markdown::render_markdown;
use super::theme;
use crate::commands::{classify, TokenClass, SLASH_COMMANDS};
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;
use std::time::Instant;

pub const MAX_INPUT_ROWS: u16 = 8;

pub fn dim_line(s: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(s.into(), theme::dim()))
}

/// An assistant message rendered as markdown, with a single dim bullet on the first line and a
/// two-space indent on the rest so one message reads as one block.
pub fn assistant_block(text: &str) -> Vec<Line<'static>> {
    let mut lines = render_markdown(text);
    if lines.is_empty() {
        lines.push(Line::default());
    }
    for (i, line) in lines.iter_mut().enumerate() {
        let prefix = if i == 0 {
            Span::styled("● ", theme::dim())
        } else {
            Span::raw("  ")
        };
        line.spans.insert(0, prefix);
    }
    lines
}

/// A finished tool call: dim `·` when it succeeded, red `✗` when it failed.
pub fn tool_end_line(tool: &str, ok: bool, elapsed_ms: u128, summary: &str) -> Line<'static> {
    let (glyph, glyph_style) = if ok {
        ("·", theme::dim())
    } else {
        ("✗", theme::err())
    };
    let mut spans = vec![
        Span::styled(format!("{glyph} "), glyph_style),
        Span::styled(tool.to_string(), theme::muted()),
        Span::styled(format!(" — {}", fmt_ms(elapsed_ms)), theme::dim()),
    ];
    if !summary.trim().is_empty() {
        spans.push(Span::styled(format!(" {summary}"), theme::dim()));
    }
    Line::from(spans)
}

/// Build the styled input lines: a dim prompt + the command token colored by class + plain remainder.
pub fn input_lines(input: &str) -> Text<'static> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut raw = input.split('\n');
    let first = raw.next().unwrap_or("");
    let (token, rest, class) = classify(first, SLASH_COMMANDS);
    let mut spans = vec![Span::styled("› ", theme::dim())];
    match class {
        TokenClass::Plain => spans.push(Span::raw(token)),
        TokenClass::Exact => spans.push(Span::styled(token, theme::accent_bold())),
        TokenClass::Prefix => spans.push(Span::styled(token, theme::accent())),
        TokenClass::Unknown => spans.push(Span::styled(token, theme::err())),
    }
    if !rest.is_empty() {
        spans.push(Span::raw(rest));
    }
    lines.push(Line::from(spans));
    for line in raw {
        lines.push(Line::from(vec![
            Span::styled("  ", theme::dim()),
            Span::raw(line.to_string()),
        ]));
    }
    Text::from(lines)
}

pub fn fmt_ms(ms: u128) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

/// Rows the input area needs (logical lines, capped).
pub fn input_rows(text: &str, width: u16) -> u16 {
    let content_width = width.saturating_sub(2).max(1) as usize;
    let rows = text
        .split('\n')
        .map(|line| line.chars().count().max(1).div_ceil(content_width))
        .sum::<usize>()
        .max(1) as u16;
    rows.min(MAX_INPUT_ROWS)
}

pub fn visual_cursor(text: &str, cursor: usize, width: u16) -> (u16, u16) {
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
    lines
        .iter()
        .map(|line| wrapped_rows_for_line(line, width))
        .sum()
}

/// The scrollback buffer: pre-rendered lines plus a cached wrapped-row count so appending and
/// scrolling don't re-measure the whole transcript each frame.
pub struct TranscriptView {
    lines: Vec<Line<'static>>,
    text: Text<'static>,
    total_rows: usize,
    cached_width: u16,
}

impl TranscriptView {
    pub fn new(lines: Vec<Line<'static>>) -> Self {
        let text = Text::from(lines.clone());
        Self {
            lines,
            text,
            total_rows: 0,
            cached_width: 0,
        }
    }

    pub fn text(&self) -> Text<'static> {
        self.text.clone()
    }

    pub fn ensure_width(&mut self, width: u16) {
        if self.cached_width != width {
            self.cached_width = width;
            self.total_rows = transcript_rows(&self.lines, width);
        }
    }

    pub fn max_scroll(&self, viewport: u16) -> u16 {
        self.total_rows.saturating_sub(viewport as usize) as u16
    }

    pub fn push(&mut self, line: Line<'static>) {
        if self.cached_width != 0 {
            self.total_rows += wrapped_rows_for_line(&line, self.cached_width);
        }
        self.text.lines.push(line.clone());
        self.lines.push(line);
    }

    pub fn extend<I>(&mut self, iter: I)
    where
        I: IntoIterator<Item = Line<'static>>,
    {
        for line in iter {
            self.push(line);
        }
    }
}

pub struct InputLayoutCache {
    revision: u64,
    width: u16,
    pub rows: u16,
    pub rendered: Text<'static>,
    pub cursor: (u16, u16),
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
    pub fn refresh(&mut self, editor: &Editor, width: u16) {
        self.refresh_with_metrics(editor, width, None);
    }

    pub fn refresh_with_metrics(
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

/// Rows the live subagent panel occupies (0 when no subagents are running, capped).
const SUBAGENT_PANEL_MAX: usize = 6;

fn subagent_panel_rows(count: usize) -> u16 {
    count.min(SUBAGENT_PANEL_MAX) as u16
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else if max == 0 {
        String::new()
    } else {
        let keep = max.saturating_sub(1);
        format!("{}…", s.chars().take(keep).collect::<String>())
    }
}

/// One row per running subagent: `⠋ [id] desc · status · 12s`. Overflow past the cap collapses to a
/// final "… and N more" line.
fn subagent_panel(app: &App, now: Instant, width: u16) -> Vec<Line<'static>> {
    let total = app.subagents.len();
    let overflow = total > SUBAGENT_PANEL_MAX;
    let show = if overflow {
        SUBAGENT_PANEL_MAX - 1
    } else {
        total
    };
    let spin = theme::SPINNER[app.spinner % theme::SPINNER.len()];
    let mut lines = Vec::new();
    for (id, row) in app.subagents.iter().take(show) {
        let elapsed = now.saturating_duration_since(row.started).as_secs();
        let head = format!(" {spin} [{id}] ");
        let tail = format!(" · {elapsed}s");
        let budget = (width as usize).saturating_sub(head.chars().count() + tail.chars().count());
        let desc = clip(&row.desc, budget / 2);
        let status_room = budget.saturating_sub(desc.chars().count() + 3); // " · "
        let status = clip(&row.status, status_room);
        lines.push(Line::from(vec![
            Span::styled(format!(" {spin} "), theme::accent()),
            Span::styled(format!("[{id}] "), theme::muted()),
            Span::raw(desc),
            Span::styled(format!(" · {status}"), theme::muted()),
            Span::styled(tail, theme::dim()),
        ]));
    }
    if overflow {
        lines.push(Line::from(Span::styled(
            format!("   … and {} more", total - show),
            theme::dim(),
        )));
    }
    lines
}

fn human_tokens(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

fn fmt_session(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// The context-fill segment (`ctx 34% (12.4k/200k)`), or `None` when the window is unknown.
fn ctx_segment(app: &App) -> Option<(String, bool)> {
    let (u, window) = (app.last_usage?, app.context_window?);
    if window == 0 {
        return None;
    }
    let pct = ((u.prompt_tokens as f64 / window as f64) * 100.0).round() as u64;
    let text = format!(
        "ctx {pct}% ({}/{})",
        human_tokens(u.prompt_tokens),
        human_tokens(window)
    );
    Some((text, pct >= 80))
}

/// Assemble the right-status text, dropping lowest-priority parts until it fits `avail` columns.
/// Display order: model · ctx · elapsed. Drop order (first dropped): model, then elapsed, then ctx.
fn right_status_text(model: &str, ctx: Option<&str>, elapsed: &str, avail: usize) -> String {
    for (with_model, with_elapsed, with_ctx) in
        [(true, true, true), (false, true, true), (false, false, true), (false, false, false)]
    {
        let mut parts: Vec<&str> = Vec::new();
        if with_model {
            parts.push(model);
        }
        if with_ctx {
            if let Some(ctx) = ctx {
                parts.push(ctx);
            }
        }
        if with_elapsed {
            parts.push(elapsed);
        }
        let s = parts.join(" · ");
        if s.chars().count() <= avail {
            return s;
        }
    }
    String::new()
}

/// Left side of the status row: spinner + label while running, else the effect toast or `· ready`.
fn status_left(app: &App) -> Vec<Span<'static>> {
    let accent = theme::pulse_color(app.running);
    let effect_active = app.effect_active();
    if app.running {
        let elapsed = app.since.elapsed().as_secs();
        let base = theme::SPINNER[app.spinner % theme::SPINNER.len()];
        let label = if app.status.is_empty() {
            "thinking".to_string()
        } else {
            app.status.clone()
        };
        let mut spans = vec![
            Span::styled(
                format!("{base} "),
                Style::default().fg(accent).add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!("{label} · {elapsed}s")),
        ];
        if effect_active && !app.effect_label.is_empty() {
            spans.push(Span::styled(
                format!("  {} {}", theme::sparkle(), app.effect_label),
                theme::muted(),
            ));
        }
        spans
    } else if effect_active && !app.effect_label.is_empty() {
        vec![
            Span::styled(format!("{} ", theme::sparkle()), theme::muted()),
            Span::styled(app.effect_label.clone(), theme::muted()),
        ]
    } else {
        vec![Span::styled(
            format!("{} ready", theme::sparkle()),
            Style::default().fg(accent),
        )]
    }
}

fn span_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| s.content.chars().count()).sum()
}

/// The full status row: left status + a right-aligned session segment (model · ctx · elapsed).
fn status_line(app: &App, now: Instant, width: u16) -> Line<'static> {
    let mut spans = status_left(app);
    let left_w = span_width(&spans);
    let elapsed = fmt_session(now.saturating_duration_since(app.session_start).as_secs());
    let ctx = ctx_segment(app);
    let ctx_text = ctx.as_ref().map(|(t, _)| t.as_str());
    let avail = (width as usize).saturating_sub(left_w + 1);
    let right = right_status_text(&app.model_id, ctx_text, &elapsed, avail);
    if !right.is_empty() {
        let right_w = right.chars().count();
        let pad = (width as usize).saturating_sub(left_w + right_w);
        let warn = ctx.map(|(_, w)| w).unwrap_or(false) && right.contains("ctx");
        let style = if warn {
            Style::default().fg(theme::WARN)
        } else {
            theme::muted()
        };
        spans.push(Span::raw(" ".repeat(pad)));
        spans.push(Span::styled(right, style));
    }
    Line::from(spans)
}

/// Render one frame from the current `App` state.
pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let in_h = app.input_cache.rows;
    let panel_h = subagent_panel_rows(app.subagents.len());
    let rows = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(panel_h),
        Constraint::Length(1),
        Constraint::Length(in_h),
    ])
    .split(area);

    // Transcript (with a bottom divider). Auto-follow the tail unless the user scrolled up.
    let viewport = rows[0].height.saturating_sub(1); // minus the border row
    app.transcript.ensure_width(rows[0].width);
    let max = app.transcript.max_scroll(viewport);
    if app.follow {
        app.scroll = max;
    }
    app.scroll = app.scroll.min(max);
    f.render_widget(
        Paragraph::new(app.transcript.text())
            .block(
                Block::default()
                    .borders(Borders::BOTTOM)
                    .border_style(Style::default().fg(theme::divider_color())),
            )
            .wrap(Wrap { trim: false })
            .scroll((app.scroll, 0)),
        rows[0],
    );

    // Live subagent panel (only present while a delegate batch runs).
    if panel_h > 0 {
        f.render_widget(
            Paragraph::new(subagent_panel(app, Instant::now(), rows[1].width)),
            rows[1],
        );
    }

    // Status line (left status + right-aligned session segment).
    f.render_widget(
        Paragraph::new(status_line(app, Instant::now(), rows[2].width)),
        rows[2],
    );

    // Input line(s) + a real cursor.
    f.render_widget(
        Paragraph::new(app.input_cache.rendered.clone()).wrap(Wrap { trim: false }),
        rows[3],
    );
    let (crow, ccol) = app.input_cache.cursor;
    f.set_cursor_position(Position::new(
        (rows[3].x + 2 + ccol).min(rows[3].x + rows[3].width.saturating_sub(1)),
        (rows[3].y + crow).min(rows[3].y + rows[3].height.saturating_sub(1)),
    ));
}

#[cfg(test)]
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfMetrics {
    pub input_batches: u64,
    pub input_events_total: u64,
    pub input_batch_max: usize,
    pub ui_batches: u64,
    pub ui_events_total: u64,
    pub ui_batch_max: usize,
    pub input_layout_refreshes: u64,
    pub input_layout_cache_hits: u64,
}

#[cfg(test)]
pub fn note_batch(metrics: &mut PerfMetrics, len: usize, input: bool) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ed(s: &str) -> Editor {
        let mut e = Editor::default();
        e.insert_str(s);
        e
    }

    #[test]
    fn wrapped_input_rows_and_cursor_are_tracked() {
        assert_eq!(input_rows("abcdef", 5), 2);
        assert_eq!(visual_cursor("abcdef", 6, 5), (1, 3));
        assert_eq!(visual_cursor("ab\ncdef", 6, 5), (1, 3));
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
    fn right_status_drops_by_priority_as_width_shrinks() {
        let full = right_status_text("gpt-5", Some("ctx 34%"), "12m", 100);
        assert_eq!(full, "gpt-5 · ctx 34% · 12m");
        // too narrow for the model → drop it first, keep ctx + elapsed
        assert_eq!(
            right_status_text("gpt-5", Some("ctx 34%"), "12m", 15),
            "ctx 34% · 12m"
        );
        // narrower still → drop elapsed, keep ctx (highest priority)
        assert_eq!(right_status_text("gpt-5", Some("ctx 34%"), "12m", 10), "ctx 34%");
        // nothing fits
        assert_eq!(right_status_text("gpt-5", Some("ctx 34%"), "12m", 3), "");
        // unknown context window → ctx omitted throughout
        assert_eq!(right_status_text("gpt-5", None, "12m", 100), "gpt-5 · 12m");
    }

    #[test]
    fn tool_end_glyph_reflects_success() {
        let ok = tool_end_line("read_file(x)", true, 1200, "3 lines");
        assert_eq!(ok.spans[0].content, "· ");
        let bad = tool_end_line("edit_file(x)", false, 20, "old_string not found");
        assert_eq!(bad.spans[0].content, "✗ ");
        assert_eq!(bad.spans[0].style.fg, Some(theme::ERROR));
    }

    #[test]
    fn clip_adds_ellipsis_only_when_truncating() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("truncate me", 5), "trun…");
        assert_eq!(clip("x", 0), "");
    }

    #[test]
    fn frame_composes_markdown_status_meter_and_subagent_panel() {
        use super::super::app::{App, UiMsg};
        use crate::events::AgentEvent;
        use crate::provider::TokenUsage;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let mut app = App::new("gpt-5", ".".to_string(), "/repo".to_string(), Some(200_000), &[]);
        app.running = true;
        app.on_ui(UiMsg::Agent(AgentEvent::Message(
            "**bold** and `code`".to_string(),
        )));
        app.on_ui(UiMsg::Agent(AgentEvent::Usage(TokenUsage {
            prompt_tokens: 68_000,
            completion_tokens: 1_000,
            total_tokens: 69_000,
            cached_tokens: None,
        })));
        app.on_ui(UiMsg::Agent(AgentEvent::SubagentStart {
            id: 0,
            desc: "port editor tests".to_string(),
        }));

        let mut term = Terminal::new(TestBackend::new(80, 20)).unwrap();
        app.refresh_input(80);
        term.draw(|f| draw(f, &mut app)).unwrap();
        let rendered: String = term
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();

        assert!(rendered.contains("bold"), "assistant markdown missing");
        assert!(rendered.contains("code"));
        assert!(rendered.contains("● "), "assistant bullet missing");
        assert!(rendered.contains("ctx 34%"), "context meter missing: {rendered}");
        assert!(rendered.contains("gpt-5"), "model name missing from status");
        assert!(
            rendered.contains("port editor tests"),
            "subagent panel row missing"
        );
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
}
