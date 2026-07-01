//! A small cursor-tracked, multi-line text buffer for the input line. `cursor` is a byte index into
//! `text`, always kept on a char boundary.

#[derive(Default)]
pub struct Editor {
    text: String,
    pub cursor: usize,
    revision: u64,
}

impl Editor {
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    fn touch(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.touch();
    }
    /// Replace the whole buffer (used by Tab completion); cursor to the end.
    pub fn set(&mut self, s: String) {
        self.cursor = s.len();
        self.text = s;
        self.touch();
    }
    pub fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.touch();
    }
    pub fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.touch();
    }
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let p = self.prev(self.cursor);
            self.text.replace_range(p..self.cursor, "");
            self.cursor = p;
            self.touch();
        }
    }
    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let n = self.next(self.cursor);
            self.text.replace_range(self.cursor..n, "");
            self.touch();
        }
    }
    pub fn delete_word_left(&mut self) {
        let end = self.cursor;
        self.word_left();
        if self.cursor < end {
            self.text.replace_range(self.cursor..end, "");
            self.touch();
        }
    }
    pub fn delete_word_right(&mut self) {
        let start = self.cursor;
        self.word_right();
        let end = self.cursor;
        self.cursor = start;
        if start < end {
            self.text.replace_range(start..end, "");
            self.touch();
        }
    }
    pub fn delete_to_buffer_home(&mut self) {
        if self.cursor > 0 {
            self.text.replace_range(0..self.cursor, "");
            self.cursor = 0;
            self.touch();
        }
    }
    pub fn delete_to_line_end(&mut self) {
        let end = self.text[self.cursor..]
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len());
        if self.cursor < end {
            self.text.replace_range(self.cursor..end, "");
            self.touch();
        }
    }
    pub fn left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self.prev(self.cursor);
            self.touch();
        }
    }
    pub fn right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor = self.next(self.cursor);
            self.touch();
        }
    }
    pub fn word_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let mut i = self.cursor;
        while i > 0 {
            let p = self.prev(i);
            let Some(ch) = self.text[p..i].chars().next() else {
                break;
            };
            if !ch.is_whitespace() {
                break;
            }
            i = p;
        }
        while i > 0 {
            let p = self.prev(i);
            let Some(ch) = self.text[p..i].chars().next() else {
                break;
            };
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
    pub fn word_right(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let mut i = self.cursor;
        while i < self.text.len() {
            let n = self.next(i);
            let Some(ch) = self.text[i..n].chars().next() else {
                break;
            };
            if !ch.is_whitespace() {
                break;
            }
            i = n;
        }
        while i < self.text.len() {
            let n = self.next(i);
            let Some(ch) = self.text[i..n].chars().next() else {
                break;
            };
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
    pub fn home(&mut self) {
        let cursor = self.text[..self.cursor]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        if self.cursor != cursor {
            self.cursor = cursor;
            self.touch();
        }
    }
    pub fn end(&mut self) {
        let cursor = self.text[self.cursor..]
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len());
        if self.cursor != cursor {
            self.cursor = cursor;
            self.touch();
        }
    }
    pub fn up(&mut self) {
        self.vmove(true);
    }
    pub fn down(&mut self) {
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

    // Test-only helpers (no keybinding drives them today).
    #[cfg(test)]
    fn buffer_home(&mut self) {
        if self.cursor != 0 {
            self.cursor = 0;
            self.touch();
        }
    }
    #[cfg(test)]
    fn buffer_end(&mut self) {
        let cursor = self.text.len();
        if self.cursor != cursor {
            self.cursor = cursor;
            self.touch();
        }
    }
    /// (row, column) of the cursor, both 0-based, column counted in chars.
    #[cfg(test)]
    fn row_col(&self) -> (u16, u16) {
        let row = self.text[..self.cursor]
            .bytes()
            .filter(|&b| b == b'\n')
            .count() as u16;
        let col = self.column_in_line(self.line_start_before(self.cursor), self.cursor) as u16;
        (row, col)
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
}
