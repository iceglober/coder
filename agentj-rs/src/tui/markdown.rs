//! A small CommonMark → ratatui renderer for assistant messages. Runs once per message at push time
//! (the transcript stays a flat, pre-rendered line buffer), so styling never happens per frame.
//! Renders structure and emphasis; code-block content is preserved verbatim (no syntax highlighting).

use super::theme;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// Render markdown into styled lines. Never fails — malformed input degrades to plain paragraphs.
pub fn render_markdown(text: &str) -> Vec<Line<'static>> {
    let mut md = Md::default();
    for event in Parser::new_ext(text, Options::empty()) {
        md.event(event);
    }
    md.finish()
}

#[derive(Default)]
struct Md {
    out: Vec<Line<'static>>,
    cur: Vec<Span<'static>>,
    bold: u32,
    italic: u32,
    underline: u32,
    in_heading: bool,
    quote: u32,
    list_stack: Vec<Option<u64>>,
    // code block
    in_code: bool,
    code_buf: String,
    // link
    link_url: Option<String>,
    link_text: String,
}

impl Md {
    fn inline_style(&self) -> Style {
        let mut s = Style::default();
        if self.in_heading {
            s = theme::accent_bold();
        }
        if self.bold > 0 {
            s = s.add_modifier(Modifier::BOLD);
        }
        if self.italic > 0 {
            s = s.add_modifier(Modifier::ITALIC);
        }
        if self.underline > 0 {
            s = s.add_modifier(Modifier::UNDERLINED);
        }
        s
    }

    /// Emit the current spans as a line (prefixed with any blockquote markers). No-op when empty.
    fn flush(&mut self) {
        if self.cur.is_empty() && self.quote == 0 {
            return;
        }
        let mut spans = Vec::new();
        for _ in 0..self.quote {
            spans.push(Span::styled("▏ ", theme::dim()));
        }
        spans.append(&mut self.cur);
        self.out.push(Line::from(spans));
    }

    /// A separating blank line between top-level blocks (collapsed, never leading).
    fn blank(&mut self) {
        if self.out.is_empty() {
            return;
        }
        if self
            .out
            .last()
            .is_some_and(|l| l.spans.iter().all(|s| s.content.trim().is_empty()))
        {
            return;
        }
        self.out.push(Line::default());
    }

    fn push_text(&mut self, t: &str) {
        if self.link_url.is_some() {
            self.link_text.push_str(t);
        }
        self.cur.push(Span::styled(t.to_string(), self.inline_style()));
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => {
                if self.in_code {
                    self.code_buf.push_str(&t);
                } else {
                    self.push_text(&t);
                }
            }
            Event::Code(t) => {
                let style = self.inline_style().fg(theme::CODE);
                self.cur.push(Span::styled(t.to_string(), style));
                if self.link_url.is_some() {
                    self.link_text.push_str(&t);
                }
            }
            Event::SoftBreak => self.cur.push(Span::raw(" ")),
            Event::HardBreak => self.flush(),
            Event::Rule => {
                self.blank();
                self.out.push(Line::from(Span::styled("───", theme::dim())));
            }
            Event::TaskListMarker(checked) => {
                let mark = if checked { "[x] " } else { "[ ] " };
                self.cur.push(Span::styled(mark.to_string(), theme::dim()));
            }
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph if self.list_stack.is_empty() && self.quote == 0 => self.blank(),
            Tag::Paragraph => {}
            Tag::Heading { .. } => {
                self.blank();
                self.in_heading = true;
            }
            Tag::BlockQuote(_) => {
                if self.quote == 0 {
                    self.blank();
                }
                self.quote += 1;
            }
            Tag::CodeBlock(_) => {
                // info string (e.g. ```rust) is intentionally dropped
                self.flush();
                self.blank();
                self.in_code = true;
                self.code_buf.clear();
            }
            Tag::List(first) => {
                if !self.cur.is_empty() {
                    self.flush();
                }
                if self.list_stack.is_empty() {
                    self.blank();
                }
                self.list_stack.push(first);
            }
            Tag::Item => {
                let depth = self.list_stack.len().max(1);
                let indent = "  ".repeat(depth);
                let marker = match self.list_stack.last_mut() {
                    Some(Some(n)) => {
                        let m = format!("{n}. ");
                        *n += 1;
                        m
                    }
                    _ => "- ".to_string(),
                };
                self.cur
                    .push(Span::styled(format!("{indent}{marker}"), theme::dim()));
            }
            Tag::Emphasis => self.italic += 1,
            Tag::Strong => self.bold += 1,
            Tag::Link { dest_url, .. } => {
                self.link_url = Some(dest_url.to_string());
                self.link_text.clear();
                self.underline += 1;
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph if self.list_stack.is_empty() => self.flush(),
            TagEnd::Paragraph => {}
            TagEnd::Heading(_) => {
                self.flush();
                self.in_heading = false;
            }
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.quote = self.quote.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                for line in self.code_buf.trim_end_matches('\n').split('\n') {
                    self.out.push(Line::from(vec![
                        Span::styled("  ", theme::dim()),
                        Span::styled(line.to_string(), Style::default().fg(theme::CODE_BLOCK)),
                    ]));
                }
                self.in_code = false;
                self.code_buf.clear();
            }
            TagEnd::Item => self.flush(),
            TagEnd::List(_) => {
                self.list_stack.pop();
            }
            TagEnd::Emphasis => self.italic = self.italic.saturating_sub(1),
            TagEnd::Strong => self.bold = self.bold.saturating_sub(1),
            TagEnd::Link => {
                if let Some(url) = self.link_url.take() {
                    if !url.is_empty() && url != self.link_text {
                        self.cur
                            .push(Span::styled(format!(" ({url})"), theme::dim()));
                    }
                }
                self.underline = self.underline.saturating_sub(1);
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Vec<Line<'static>> {
        self.flush();
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Modifier;

    fn plain(lines: &[Line]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    #[test]
    fn headings_and_paragraphs() {
        let lines = render_markdown("# Title\n\nHello world");
        let text = plain(&lines);
        assert!(text.iter().any(|l| l == "Title"));
        assert!(text.iter().any(|l| l == "Hello world"));
        // heading is accent + bold
        let title = lines.iter().find(|l| l.spans.iter().any(|s| s.content == "Title")).unwrap();
        assert!(title.spans[0].style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn inline_emphasis_and_code() {
        let lines = render_markdown("a **b** `c`");
        let spans: Vec<_> = lines.iter().flat_map(|l| l.spans.iter()).collect();
        assert!(spans
            .iter()
            .any(|s| s.content == "b" && s.style.add_modifier.contains(Modifier::BOLD)));
        assert!(spans
            .iter()
            .any(|s| s.content == "c" && s.style.fg == Some(theme::CODE)));
    }

    #[test]
    fn fenced_code_is_verbatim_and_indented() {
        let lines = render_markdown("```rust\nlet x = 1;\nlet y = 2;\n```");
        let text = plain(&lines);
        // content preserved verbatim, one line each, info string dropped
        assert!(text.iter().any(|l| l == "  let x = 1;"));
        assert!(text.iter().any(|l| l == "  let y = 2;"));
        assert!(!text.iter().any(|l| l.contains("rust")));
    }

    #[test]
    fn nested_list_markers_and_ordering() {
        let lines = render_markdown("1. first\n2. second\n   - deep");
        let text = plain(&lines);
        assert!(text.iter().any(|l| l.contains("1. first")));
        assert!(text.iter().any(|l| l.contains("2. second")));
        assert!(text.iter().any(|l| l.contains("- deep")));
    }

    #[test]
    fn blockquote_prefixed() {
        let lines = render_markdown("> quoted");
        assert!(lines
            .iter()
            .any(|l| l.spans.first().is_some_and(|s| s.content == "▏ ")));
    }

    #[test]
    fn plain_text_survives() {
        let lines = render_markdown("just a sentence");
        assert_eq!(plain(&lines), vec!["just a sentence".to_string()]);
    }
}
