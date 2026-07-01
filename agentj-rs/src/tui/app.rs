//! The UI state and the pure(ish) state transitions that drive it. Keystrokes and agent events are
//! folded into `App` here; anything that must `.await` (spawning a turn, `/task` re-key) is deferred to
//! the event loop in `mod.rs` via an `AppEffect` the handler returns.

use super::editor::Editor;
use super::keymap::{key_to_action, Action};
use super::theme;
use super::view::{assistant_block, dim_line, fmt_ms, tool_end_line, InputLayoutCache, TranscriptView};
use crate::commands::{fuzzy_commands, SlashCommand, SLASH_COMMANDS};
use crate::events::AgentEvent;
use crate::provider::{ChatMessage, TokenUsage};
use crate::rekey::{is_linked_worktree, RekeyResult};
use crossterm::event::{Event, KeyEvent, KeyEventKind, MouseEventKind};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tokio::task::AbortHandle;

const EFFECT_TTL: Duration = Duration::from_millis(700);
/// A second Ctrl-C within this window quits.
const DOUBLE_TAP: Duration = Duration::from_secs(2);

const CHEAT_SHEET: &str = "Enter send · Ctrl-J newline · Esc interrupt · / commands · ↑↓/wheel or PageUp/Dn scroll · Ctrl-C×2 quit";

/// The slash token containing the cursor, when the completion popover should consider it: a maximal
/// non-whitespace run ending at the cursor that starts with `/` at the start of the text or right
/// after whitespace (so `a/b` or a mid-word `/` never triggers). Returns (start byte, token so far).
fn slash_token(text: &str, cursor: usize) -> Option<(usize, String)> {
    let before = &text[..cursor];
    let start = before
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let token = &before[start..];
    if token.starts_with('/') {
        Some((start, token.to_string()))
    } else {
        None
    }
}

/// The slash-command completion popover: fuzzy matches for the token being typed.
pub struct Popover {
    pub items: Vec<&'static SlashCommand>,
    pub selected: usize,
    /// Byte offset where the token starts (replaced on accept).
    token_start: usize,
}

/// Messages from the turn task into the UI event loop.
pub enum UiMsg {
    Agent(AgentEvent),
    /// Newly committed history — an assistant reply, a tool-call group, or a nudge — appended as the
    /// turn progresses so an interrupt keeps whatever already applied.
    HistoryDelta(Vec<ChatMessage>),
    /// The turn task finished (natural completion or clean stop).
    TurnDone,
}

/// A running turn: its abort handle plus the job-id watermark captured at spawn, so an interrupt can
/// kill exactly the background jobs this turn started.
pub struct TurnHandle {
    pub abort: AbortHandle,
    pub job_watermark: u64,
}

/// One subagent's row in the tray shown while a delegate batch runs. Finished rows stay in the tray
/// (with their outcome) until the whole batch completes, so checkmarks visibly accumulate.
pub struct SubagentRow {
    pub desc: String,
    /// Latest progress line; after completion, the final result summary.
    pub status: String,
    pub started: Instant,
    /// Progress events seen — the per-agent activity counter.
    pub steps: u64,
    /// When the last progress event arrived (drives the brief activity flash).
    pub last_activity: Instant,
    /// `Some(ok)` once the subagent finished.
    pub done: Option<bool>,
    /// Elapsed frozen at completion.
    pub final_ms: Option<u64>,
}

/// Work the event loop must perform after a state transition (it needs `.await` or the turn task's
/// handles, which `App` doesn't own).
pub enum AppEffect {
    None,
    Quit,
    /// Spawn a turn from the current committed history; the loop stores the handle in `App::turn`.
    SpawnTurn,
    /// Run a `/task` re-key, then feed the result back via `apply_rekey_result`.
    Rekey { reference: String, desc: String },
    /// SIGKILL background jobs started at or after this watermark (an interrupted turn's jobs).
    KillJobsAfter(u64),
}

pub struct App {
    // context for building turns / re-keying
    pub system: String,
    pub root: String,
    pub model_id: String,
    // conversation
    pub messages: Vec<ChatMessage>,
    pub transcript: TranscriptView,
    // input
    pub editor: Editor,
    pub input_cache: InputLayoutCache,
    pub popover: Option<Popover>,
    /// Token the user dismissed with Esc — stays closed until the token changes.
    popover_dismissed: Option<String>,
    // turn state
    pub running: bool,
    pub turn: Option<TurnHandle>,
    pub since: Instant,
    pub status: String,
    pub current_tool: String,
    // live subagents (delegate batch), keyed by index for stable ordering
    pub subagents: BTreeMap<usize, SubagentRow>,
    // session status meter
    pub session_start: Instant,
    pub last_usage: Option<TokenUsage>,
    pub context_window: Option<u64>,
    // animation / effects
    pub spinner: usize,
    pub pulse: usize,
    pub effect_until: Option<Instant>,
    pub effect_label: String,
    pub last_effect_active: bool,
    pub last_ctrl_c: Option<Instant>,
    // scroll
    pub scroll: u16,
    pub follow: bool,
    // loop control
    pub dirty: bool,
    pub quit: bool,
}

impl App {
    pub fn new(
        model_id: &str,
        root: String,
        system: String,
        context_window: Option<u64>,
        notices: &[String],
    ) -> Self {
        let mut transcript = TranscriptView::new(vec![dim_line(CHEAT_SHEET)]);
        for n in notices {
            transcript.push(dim_line(format!("! {n}")));
        }
        Self {
            system: system.clone(),
            root,
            model_id: model_id.to_string(),
            messages: vec![ChatMessage::system(system)],
            transcript,
            editor: Editor::default(),
            input_cache: InputLayoutCache::default(),
            popover: None,
            popover_dismissed: None,
            running: false,
            turn: None,
            since: Instant::now(),
            status: String::new(),
            current_tool: String::new(),
            subagents: BTreeMap::new(),
            session_start: Instant::now(),
            last_usage: None,
            context_window,
            spinner: 0,
            pulse: 0,
            effect_until: None,
            effect_label: String::new(),
            last_effect_active: false,
            last_ctrl_c: None,
            scroll: 0,
            follow: true,
            dirty: true,
            quit: false,
        }
    }

    pub fn refresh_input(&mut self, width: u16) {
        self.input_cache.refresh(&self.editor, width);
    }

    pub fn effect_active(&self) -> bool {
        self.effect_until.is_some_and(|until| until > Instant::now())
    }

    /// Collapse the agent tray: every finished subagent gets a permanent ✓/✗ summary line in the
    /// transcript (still-running rows just vanish — their turn was aborted). Called when a delegate
    /// batch completes, and on turn end/abort as a safety net.
    fn flush_subagent_summaries(&mut self) {
        for (id, row) in std::mem::take(&mut self.subagents) {
            let Some(ok) = row.done else { continue };
            let (glyph, style) = if ok {
                ("✓", theme::ok())
            } else {
                ("✗", theme::err())
            };
            let mut spans = vec![
                Span::styled(format!("{glyph} "), style),
                Span::styled(format!("[{id}] {}", row.desc), theme::muted()),
            ];
            if let Some(ms) = row.final_ms {
                spans.push(Span::styled(format!(" — {}", fmt_ms(ms as u128)), theme::dim()));
            }
            if !row.status.trim().is_empty() {
                spans.push(Span::styled(format!(" · {}", row.status), theme::dim()));
            }
            self.transcript.push(Line::from(spans));
        }
        self.dirty = true;
    }

    /// Push a user prompt line, preceded by a blank line to separate turns visually.
    fn push_user_line(&mut self, text: &str) {
        self.transcript.push(Line::default());
        self.transcript.push(Line::from(vec![
            Span::styled("› ", theme::accent()),
            Span::styled(text.to_string(), Style::default().add_modifier(Modifier::BOLD)),
        ]));
    }

    fn set_effect(&mut self, label: impl Into<String>) {
        self.effect_until = Some(Instant::now() + EFFECT_TTL);
        self.effect_label = label.into();
        self.last_effect_active = true;
        self.dirty = true;
    }

    /// Advance the spinner/pulse animation and expire a finished effect. Only animates when there's
    /// something to animate, so an idle UI never repaints.
    pub fn on_tick(&mut self, now: Instant) {
        let effect_active = self.effect_until.is_some_and(|until| until > now);
        let had_effect = self.last_effect_active;
        if self.running || effect_active || had_effect {
            self.spinner = self.spinner.wrapping_add(1);
            self.pulse = self.pulse.wrapping_add(1);
            if self.effect_until.is_some_and(|until| until <= now) {
                self.effect_until = None;
                self.effect_label.clear();
            }
            self.last_effect_active = self.effect_until.is_some_and(|until| until > now);
            self.dirty = true;
        }
    }

    pub fn on_input(&mut self, ev: Event) -> AppEffect {
        match ev {
            Event::Paste(s) if !self.running => {
                self.editor.insert_str(&s);
                self.update_popover();
                self.dirty = true;
                AppEffect::None
            }
            Event::Mouse(m) => {
                match m.kind {
                    MouseEventKind::ScrollUp => {
                        self.follow = false;
                        self.scroll = self.scroll.saturating_sub(3);
                        self.dirty = true;
                    }
                    MouseEventKind::ScrollDown => {
                        self.scroll = self.scroll.saturating_add(3);
                        self.dirty = true;
                    }
                    _ => {}
                }
                AppEffect::None
            }
            Event::Resize(_, _) => {
                self.dirty = true;
                AppEffect::None
            }
            Event::Key(k) if k.kind != KeyEventKind::Release => self.on_key(k),
            _ => AppEffect::None,
        }
    }

    fn on_key(&mut self, k: KeyEvent) -> AppEffect {
        // The popover captures navigation/accept/dismiss keys before the normal keymap.
        if self.popover.is_some() && !self.running && k.modifiers.is_empty() {
            match k.code {
                crossterm::event::KeyCode::Up => return self.popover_move(-1),
                crossterm::event::KeyCode::Down => return self.popover_move(1),
                crossterm::event::KeyCode::Tab | crossterm::event::KeyCode::Enter => {
                    return self.popover_accept()
                }
                crossterm::event::KeyCode::Esc => return self.popover_dismiss(),
                _ => {}
            }
        }
        match key_to_action(k, self.running, self.editor.text()) {
            Action::None => AppEffect::None,
            Action::Quit => AppEffect::Quit,
            Action::ClearInput => self.edit(|e| e.clear()),
            Action::Char(c) => self.edit(|e| e.insert_char(c)),
            Action::Newline => self.edit(|e| e.insert_char('\n')),
            Action::Backspace => self.edit(|e| e.backspace()),
            Action::Delete => self.edit(|e| e.delete()),
            Action::DeleteWordLeft => self.edit(|e| e.delete_word_left()),
            Action::DeleteWordRight => self.edit(|e| e.delete_word_right()),
            Action::DeleteToLineHome => self.edit(|e| e.delete_to_line_home()),
            Action::DeleteToLineEnd => self.edit(|e| e.delete_to_line_end()),
            Action::Left => self.edit(|e| e.left()),
            Action::Right => self.edit(|e| e.right()),
            Action::WordLeft => self.edit(|e| e.word_left()),
            Action::WordRight => self.edit(|e| e.word_right()),
            // Single-line input: ↑/↓ scroll the transcript (what mouse wheels send under
            // alternate-scroll); multi-line input: they move the cursor between lines.
            Action::Up if !self.editor.text().contains('\n') => self.scroll_by(-1, true),
            Action::Down if !self.editor.text().contains('\n') => self.scroll_by(1, false),
            Action::Up => self.edit(|e| e.up()),
            Action::Down => self.edit(|e| e.down()),
            Action::Home => self.edit(|e| e.home()),
            Action::End => self.edit(|e| e.end()),
            Action::ScrollUp => self.scroll_by(-1, true),
            Action::ScrollDown => self.scroll_by(1, false),
            Action::PageUp => self.scroll_by(-10, true),
            Action::PageDown => self.scroll_by(10, false),
            Action::Complete => {
                // Tab with no popover open: try to open it for the token under the cursor.
                self.update_popover();
                self.dirty = true;
                AppEffect::None
            }
            Action::AbortTurn => self.abort_turn(),
            Action::CtrlC => self.ctrl_c(),
            Action::Submit(text) => self.submit(text),
        }
    }

    fn edit(&mut self, f: impl FnOnce(&mut Editor)) -> AppEffect {
        f(&mut self.editor);
        self.update_popover();
        self.dirty = true;
        AppEffect::None
    }

    /// Recompute the popover from the token under the cursor. Opens on a `/` token (at start or
    /// after whitespace), filters by fuzzy match, closes when nothing matches or the token is gone.
    fn update_popover(&mut self) {
        let Some((start, token)) = slash_token(self.editor.text(), self.editor.cursor) else {
            self.popover = None;
            self.popover_dismissed = None;
            return;
        };
        if self.popover_dismissed.as_deref() == Some(token.as_str()) {
            self.popover = None;
            return;
        }
        self.popover_dismissed = None;
        let items = fuzzy_commands(&token, SLASH_COMMANDS);
        if items.is_empty() {
            self.popover = None;
            return;
        }
        let selected = self
            .popover
            .as_ref()
            .map(|p| p.selected.min(items.len() - 1))
            .unwrap_or(0);
        self.popover = Some(Popover {
            items,
            selected,
            token_start: start,
        });
    }

    fn popover_move(&mut self, delta: i32) -> AppEffect {
        if let Some(p) = &mut self.popover {
            let n = p.items.len() as i32;
            p.selected = ((p.selected as i32 + delta).rem_euclid(n)) as usize;
            self.dirty = true;
        }
        AppEffect::None
    }

    fn popover_accept(&mut self) -> AppEffect {
        if let Some(p) = self.popover.take() {
            let cmd = p.items[p.selected];
            let insert = if cmd.takes_arg {
                format!("{} ", cmd.name)
            } else {
                cmd.name.to_string()
            };
            self.editor
                .replace_range(p.token_start, self.editor.cursor, &insert);
            // Stay closed for the accepted token (else a no-arg command like /exit would keep
            // reopening and Enter could never submit); any further edit reopens it.
            self.popover_dismissed =
                slash_token(self.editor.text(), self.editor.cursor).map(|(_, t)| t);
            self.dirty = true;
        }
        AppEffect::None
    }

    fn popover_dismiss(&mut self) -> AppEffect {
        if let Some((_, token)) = slash_token(self.editor.text(), self.editor.cursor) {
            self.popover_dismissed = Some(token);
        }
        self.popover = None;
        self.dirty = true;
        AppEffect::None
    }

    fn scroll_by(&mut self, delta: i32, break_follow: bool) -> AppEffect {
        if break_follow {
            self.follow = false;
        }
        self.scroll = if delta < 0 {
            self.scroll.saturating_sub((-delta) as u16)
        } else {
            self.scroll.saturating_add(delta as u16)
        };
        self.dirty = true;
        AppEffect::None
    }

    fn abort_turn(&mut self) -> AppEffect {
        self.running = false;
        self.status.clear();
        self.flush_subagent_summaries();
        self.transcript.push(dim_line("[interrupted]"));
        self.follow = true;
        self.set_effect("interrupted");
        match self.turn.take() {
            Some(t) => {
                t.abort.abort();
                // Orient the model next turn: side effects (edits, commits) may already have applied.
                self.messages.push(ChatMessage::user(
                    "[note: the previous request was interrupted by the user; some tool actions may have already applied]",
                ));
                AppEffect::KillJobsAfter(t.job_watermark)
            }
            None => AppEffect::None,
        }
    }

    fn ctrl_c(&mut self) -> AppEffect {
        let now = Instant::now();
        if self.last_ctrl_c.is_some_and(|t| now.duration_since(t) < DOUBLE_TAP) {
            AppEffect::Quit // second Ctrl-C within the window → quit
        } else {
            self.last_ctrl_c = Some(now);
            self.editor.clear(); // first Ctrl-C also clears any typed input
            self.effect_until = Some(now + DOUBLE_TAP);
            self.effect_label = "press Ctrl-C again to quit".to_string();
            self.last_effect_active = true;
            self.dirty = true;
            AppEffect::None
        }
    }

    fn submit(&mut self, text: String) -> AppEffect {
        self.editor.clear();
        self.update_popover();
        self.follow = true;
        self.dirty = true;
        if text.is_empty() {
            AppEffect::None
        } else if text == "/exit" || text == "/quit" {
            AppEffect::Quit
        } else if text == "/task" || text.starts_with("/task ") {
            self.submit_task(&text)
        } else {
            self.push_user_line(&text);
            self.messages.push(ChatMessage::user(text));
            self.running = true;
            self.since = Instant::now();
            self.status.clear();
            self.set_effect("let's cook");
            AppEffect::SpawnTurn
        }
    }

    fn submit_task(&mut self, text: &str) -> AppEffect {
        let rest = text["/task".len()..].trim().to_string();
        let reference = rest.split_whitespace().next().unwrap_or("").to_string();
        if reference.is_empty() {
            self.transcript.push(dim_line(
                "usage: /task <pr-number | branch-name> [task description]",
            ));
            AppEffect::None
        } else if !is_linked_worktree(&self.root)
            && std::env::var("AGENTJ_ALLOW_PRIMARY").as_deref() != Ok("1")
        {
            self.transcript.push(dim_line("» /task does a destructive reset to origin and is meant for a dedicated worktree — this looks like the primary checkout. Run agentj in your worktree, or set AGENTJ_ALLOW_PRIMARY=1."));
            AppEffect::None
        } else {
            self.transcript
                .push(dim_line(format!("» re-keying worktree → {reference}")));
            let desc = rest[reference.len()..].trim().to_string();
            AppEffect::Rekey { reference, desc }
        }
    }

    /// Fold a completed `/task` re-key into state. Returns `SpawnTurn` when a task description should
    /// start a turn, else `None`.
    pub fn apply_rekey_result(&mut self, rk: RekeyResult, desc: String) -> AppEffect {
        for s in &rk.steps {
            self.transcript.push(dim_line(format!("  · {s}")));
        }
        if !rk.ok {
            self.transcript.push(dim_line(format!(
                "» re-key failed: {}",
                rk.error.unwrap_or_default()
            )));
            self.set_effect("re-key failed");
            return AppEffect::None;
        }
        let branch = rk.branch.unwrap_or_default();
        self.transcript
            .push(dim_line(format!("» clean on {branch}, synced to origin")));
        self.set_effect(format!("switched to {branch}"));
        self.messages = vec![ChatMessage::system(self.system.clone())];
        if desc.is_empty() {
            AppEffect::None
        } else {
            self.push_user_line(&desc);
            self.messages.push(ChatMessage::user(desc));
            self.running = true;
            self.since = Instant::now();
            self.status.clear();
            self.last_effect_active = true;
            self.dirty = true;
            AppEffect::SpawnTurn
        }
    }

    pub fn on_ui(&mut self, msg: UiMsg) {
        match msg {
            UiMsg::Agent(ev) => self.on_agent(ev),
            UiMsg::HistoryDelta(delta) => {
                self.messages.extend(delta);
            }
            UiMsg::TurnDone => {
                self.running = false;
                self.status.clear();
                self.turn = None;
                self.flush_subagent_summaries();
                if self.effect_label.is_empty() {
                    self.effect_until = Some(Instant::now() + EFFECT_TTL);
                    self.effect_label = "all set".to_string();
                    self.last_effect_active = true;
                }
                self.dirty = true;
            }
        }
    }

    fn on_agent(&mut self, ev: AgentEvent) {
        match ev {
            AgentEvent::Message(t) => {
                self.transcript.extend(assistant_block(&t));
                self.set_effect("new reply");
            }
            AgentEvent::ToolStart { name, args, .. } => {
                self.current_tool = format!("{name}({args})");
                // The subagent panel is the live status for delegate; don't overwrite it.
                if name != "delegate" {
                    self.status = self.current_tool.clone();
                }
                self.set_effect(format!("tool: {name}"));
            }
            AgentEvent::ToolEnd {
                ok,
                summary,
                elapsed_ms,
                ..
            } => {
                // A finished delegate collapses the agent tray into permanent transcript summaries;
                // its own summary is redundant with those per-agent ✓/✗ lines.
                let is_delegate = self.current_tool.starts_with("delegate(");
                if is_delegate {
                    self.flush_subagent_summaries();
                }
                let shown = if is_delegate { "" } else { summary.as_str() };
                self.transcript
                    .push(tool_end_line(&self.current_tool, ok, elapsed_ms, shown));
                self.status = "thinking".to_string();
                self.set_effect(format!("done in {}", fmt_ms(elapsed_ms)));
            }
            AgentEvent::SubagentStart { id, desc } => {
                let now = Instant::now();
                self.subagents.insert(
                    id,
                    SubagentRow {
                        desc,
                        status: "starting".to_string(),
                        started: now,
                        steps: 0,
                        last_activity: now,
                        done: None,
                        final_ms: None,
                    },
                );
                self.dirty = true;
            }
            AgentEvent::SubagentProgress { id, status } => {
                if let Some(row) = self.subagents.get_mut(&id) {
                    row.status = status;
                    row.steps += 1;
                    row.last_activity = Instant::now();
                }
                self.dirty = true;
            }
            AgentEvent::SubagentEnd {
                id,
                ok,
                summary,
                elapsed_ms,
            } => {
                // Keep the row in the tray with its outcome; the transcript summary lands when the
                // whole batch collapses (flush_subagent_summaries).
                if let Some(row) = self.subagents.get_mut(&id) {
                    row.done = Some(ok);
                    row.final_ms = Some(elapsed_ms);
                    if !summary.trim().is_empty() {
                        row.status = summary;
                    }
                }
                self.dirty = true;
            }
            AgentEvent::Usage(u) => {
                self.last_usage = Some(u);
                self.dirty = true;
            }
            AgentEvent::Note(t) => {
                self.transcript.push(dim_line(format!("» {t}")));
                self.dirty = true;
            }
            AgentEvent::Error(e) => {
                self.transcript
                    .push(Line::from(Span::styled(format!("✗ {e}"), theme::err())));
                self.set_effect("error");
            }
            AgentEvent::Done => {
                self.running = false;
                self.status.clear();
                self.set_effect("all set");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers, MouseButton, MouseEvent};

    fn app() -> App {
        App::new("dummy", ".".to_string(), "sys".to_string(), None, &[])
    }

    fn mouse(kind: MouseEventKind) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn mouse_wheel_scrolls_transcript() {
        let mut a = app();
        a.scroll = 5;
        a.follow = true;

        a.on_input(mouse(MouseEventKind::ScrollUp));
        assert_eq!(a.scroll, 2);
        assert!(!a.follow);

        let before = a.follow;
        a.on_input(mouse(MouseEventKind::ScrollDown));
        assert_eq!(a.scroll, 5);
        assert_eq!(a.follow, before);
        // a non-scroll mouse event is a no-op
        a.on_input(mouse(MouseEventKind::Down(MouseButton::Left)));
        assert_eq!(a.scroll, 5);
    }

    #[test]
    fn submit_plain_text_starts_a_turn() {
        let mut a = app();
        a.editor.insert_str("hello");
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::SpawnTurn));
        assert!(a.running);
        assert!(a.editor.text().is_empty());
        // the user message is committed to history up front (spawn_turn clones it)
        assert!(a
            .messages
            .iter()
            .any(|m| m.role == "user" && m.content.as_deref() == Some("hello")));
    }

    #[tokio::test]
    async fn abort_pushes_interrupt_marker_and_kills_jobs() {
        let mut a = app();
        let abort = tokio::spawn(std::future::pending::<()>()).abort_handle();
        a.turn = Some(TurnHandle {
            abort,
            job_watermark: 7,
        });
        a.running = true;
        let effect = a.abort_turn();
        assert!(matches!(effect, AppEffect::KillJobsAfter(7)));
        assert!(!a.running);
        assert!(a.messages.iter().any(|m| m
            .content
            .as_deref()
            .is_some_and(|c| c.contains("interrupted by the user"))));
    }

    fn type_str(a: &mut App, s: &str) {
        for c in s.chars() {
            a.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
    }

    #[test]
    fn slash_popover_opens_filters_and_accepts() {
        let mut a = app();
        type_str(&mut a, "/");
        let p = a.popover.as_ref().expect("popover opens on /");
        assert_eq!(p.items.len(), SLASH_COMMANDS.len());

        // fuzzy-filters as you type
        type_str(&mut a, "ta");
        let p = a.popover.as_ref().unwrap();
        assert_eq!(p.items[0].name, "/task");

        // Enter accepts the selection instead of submitting
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::None));
        assert_eq!(a.editor.text(), "/task ");
        assert!(!a.running);
        assert!(a.popover.is_none());
    }

    #[test]
    fn accepting_a_no_arg_command_lets_the_next_enter_submit() {
        let mut a = app();
        type_str(&mut a, "/ex");
        // First Enter accepts the completion…
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            AppEffect::None
        ));
        assert_eq!(a.editor.text(), "/exit");
        assert!(a.popover.is_none(), "popover must stay closed after accept");
        // …the second Enter submits (here: /exit quits).
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            AppEffect::Quit
        ));
    }

    #[test]
    fn slash_popover_works_mid_input_but_not_mid_word() {
        let mut a = app();
        type_str(&mut a, "see ");
        type_str(&mut a, "/ex");
        assert!(a.popover.is_some(), "slash after whitespace opens the popover");
        let effect = a.on_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::None));
        assert_eq!(a.editor.text(), "see /exit");

        let mut b = app();
        type_str(&mut b, "a/b");
        assert!(b.popover.is_none(), "slash glued to a word must not open the popover");
    }

    #[test]
    fn slash_popover_arrows_select_and_esc_dismisses_until_token_changes() {
        let mut a = app();
        type_str(&mut a, "/");
        a.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(a.popover.as_ref().unwrap().selected, 1);
        a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(a.popover.as_ref().unwrap().selected, 0);
        a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)); // wraps
        assert_eq!(a.popover.as_ref().unwrap().selected, SLASH_COMMANDS.len() - 1);

        // Esc closes it and keeps it closed for the same token…
        a.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(a.popover.is_none());
        assert!(!a.editor.text().is_empty(), "Esc dismisses the popover, not the input");
        // …but typing more reopens it.
        type_str(&mut a, "t");
        assert!(a.popover.is_some());
    }

    #[test]
    fn plain_up_down_scrolls_single_line_but_moves_cursor_in_multiline() {
        let mut a = app();
        type_str(&mut a, "hello");
        a.scroll = 5;
        a.follow = true;
        a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(a.scroll, 4, "single-line input: ↑ scrolls the transcript");
        assert!(!a.follow);

        let mut b = app();
        type_str(&mut b, "one");
        b.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        type_str(&mut b, "two");
        let before = b.scroll;
        b.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(b.scroll, before, "multi-line input: ↑ moves the cursor, not the scroll");
        assert!(b.editor.cursor < b.editor.text().len());
    }

    fn transcript_text(a: &App) -> String {
        a.transcript
            .text()
            .lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn tray_collapses_into_transcript_summaries_when_the_delegate_batch_lands() {
        use crate::events::AgentEvent;
        let mut a = app();
        a.on_ui(UiMsg::Agent(AgentEvent::ToolStart {
            name: "delegate".to_string(),
            args: "{tasks:…}".to_string(),
        }));
        a.on_ui(UiMsg::Agent(AgentEvent::SubagentStart {
            id: 0,
            desc: "port the tests".to_string(),
        }));
        a.on_ui(UiMsg::Agent(AgentEvent::SubagentProgress {
            id: 0,
            status: "bash(cargo test)".to_string(),
        }));
        assert_eq!(a.subagents[&0].steps, 1);

        a.on_ui(UiMsg::Agent(AgentEvent::SubagentEnd {
            id: 0,
            ok: true,
            summary: "all 4 tests pass".to_string(),
            elapsed_ms: 2000,
        }));
        // Finished but batch still open: row pinned in the tray, no transcript summary yet.
        assert_eq!(a.subagents[&0].done, Some(true));
        assert!(!transcript_text(&a).contains("all 4 tests pass"));

        a.on_ui(UiMsg::Agent(AgentEvent::ToolEnd {
            ok: true,
            elapsed_ms: 2100,
            summary: "[subagent 0] …".to_string(),
        }));
        // Batch landed: tray empty, permanent ✓ summary in the transcript.
        assert!(a.subagents.is_empty());
        let t = transcript_text(&a);
        assert!(t.contains("✓ [0] port the tests"), "transcript: {t}");
        assert!(t.contains("all 4 tests pass"));
    }

    #[test]
    fn exit_command_quits() {
        let mut a = app();
        a.editor.insert_str("/exit");
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::Quit));
    }

    #[test]
    fn double_ctrl_c_quits_within_window() {
        let mut a = app();
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            AppEffect::None
        ));
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            AppEffect::Quit
        ));
    }
}
