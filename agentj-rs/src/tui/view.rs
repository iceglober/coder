//! Rendering: turns `App` state into the three-region ratatui layout (transcript / status / input),
//! plus the transcript/input line builders and their cached row-count bookkeeping.

use super::app::App;
use super::editor::Editor;
use super::theme;
use crate::commands::{classify, TokenClass, SLASH_COMMANDS};
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

pub const MAX_INPUT_ROWS: u16 = 8;

pub fn dim_line(s: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(s.into(), theme::dim()))
}

pub fn assistant_lines(text: &str) -> Vec<Line<'static>> {
    text.lines()
        .map(|l| {
            Line::from(vec![
                Span::styled("● ", theme::dim()),
                Span::raw(l.to_string()),
            ])
        })
        .collect()
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

/// Render one frame from the current `App` state.
pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let in_h = app.input_cache.rows;
    let rows = Layout::vertical([
        Constraint::Min(1),
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
    let accent = theme::pulse_color(app.running);
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

    // Status line.
    let effect_active = app.effect_active();
    let status_line = if app.running {
        let elapsed = app.since.elapsed().as_secs();
        let base = theme::SPINNER[app.spinner % theme::SPINNER.len()];
        let label = if app.status.is_empty() {
            "thinking".to_string()
        } else {
            app.status.clone()
        };
        let mut spans = vec![Span::styled(
            format!("{base} "),
            Style::default().fg(accent).add_modifier(Modifier::BOLD),
        )];
        spans.push(Span::raw(format!("{label} · {elapsed}s")));
        if effect_active && !app.effect_label.is_empty() {
            spans.push(Span::styled(
                format!("  {} {}", theme::sparkle(), app.effect_label),
                theme::muted(),
            ));
        }
        Line::from(spans)
    } else if effect_active && !app.effect_label.is_empty() {
        Line::from(vec![
            Span::styled(format!("{} ", theme::sparkle()), theme::muted()),
            Span::styled(app.effect_label.clone(), theme::muted()),
        ])
    } else {
        Line::from(vec![Span::styled(
            format!("{} ready", theme::sparkle()),
            Style::default().fg(accent),
        )])
    };
    f.render_widget(Paragraph::new(status_line), rows[1]);

    // Input line(s) + a real cursor.
    f.render_widget(
        Paragraph::new(app.input_cache.rendered.clone()).wrap(Wrap { trim: false }),
        rows[2],
    );
    let (crow, ccol) = app.input_cache.cursor;
    f.set_cursor_position(Position::new(
        (rows[2].x + 2 + ccol).min(rows[2].x + rows[2].width.saturating_sub(1)),
        (rows[2].y + crow).min(rows[2].y + rows[2].height.saturating_sub(1)),
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
