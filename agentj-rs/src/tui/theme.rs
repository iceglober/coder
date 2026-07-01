//! Colors, glyphs, and the small styling helpers the TUI draws with. ANSI-16 only, so the user's
//! terminal palette is respected; no background fills (they read as broken across light/dark themes).

use ratatui::style::{Color, Modifier, Style};

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub const ACCENT: Color = Color::Cyan; // spinner, exact slash command, headings, user prompt glyph
pub const DIM: Color = Color::DarkGray; // chrome: bullets, tool lines, notes, dividers, hints
pub const MUTED: Color = Color::Gray; // secondary text a step above DIM
pub const ERROR: Color = Color::Red; // errors, unknown slash command, ✗

pub fn dim() -> Style {
    Style::default().fg(DIM)
}
pub fn muted() -> Style {
    Style::default().fg(MUTED)
}
pub fn accent() -> Style {
    Style::default().fg(ACCENT)
}
pub fn accent_bold() -> Style {
    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
}
pub fn err() -> Style {
    Style::default().fg(ERROR)
}

/// Accent while a turn is running, gray at rest.
pub fn pulse_color(running: bool) -> Color {
    if running {
        ACCENT
    } else {
        MUTED
    }
}

pub fn divider_color() -> Color {
    DIM
}

pub fn sparkle() -> &'static str {
    "·"
}
