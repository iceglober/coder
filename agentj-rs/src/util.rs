//! Small shared helpers.

/// The first non-blank line of `s`, trimmed, capped at `max` characters (not bytes).
/// Pass `usize::MAX` for no cap.
pub fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if max == usize::MAX {
        line.to_string()
    } else {
        line.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_trims_caps_and_skips_blank_lines() {
        assert_eq!(first_line("  \n\n  hello world  \nmore", 5), "hello");
        assert_eq!(first_line("  hello  ", usize::MAX), "hello");
        assert_eq!(first_line("", 10), "");
        assert_eq!(first_line("\n\n", 10), "");
        // char-based cap, not byte-based
        assert_eq!(first_line("héllo", 3), "hél");
    }
}
