//! The UI state and the pure(ish) state transitions that drive it. Keystrokes and agent events are
//! folded into `App` here; anything that must `.await` (spawning a turn, `/task` re-key) is deferred to
//! the event loop in `mod.rs` via an `AppEffect` the handler returns.

use super::editor::Editor;
use super::keymap::{key_to_action, Action};
use super::view::{assistant_lines, dim_line, fmt_ms, InputLayoutCache, TranscriptView};
use super::theme;
use crate::commands::{complete_command, SLASH_COMMANDS};
use crate::events::AgentEvent;
use crate::provider::ChatMessage;
use crate::rekey::{is_linked_worktree, RekeyResult};
use crossterm::event::{Event, KeyEvent, KeyEventKind, MouseEventKind};
use ratatui::text::{Line, Span};
use std::time::{Duration, Instant};
use tokio::task::AbortHandle;

const EFFECT_TTL: Duration = Duration::from_millis(700);
/// A second Ctrl-C within this window quits.
const DOUBLE_TAP: Duration = Duration::from_secs(2);

const CHEAT_SHEET: &str = "Enter submits · Alt/Shift/Ctrl+Enter (or Ctrl-J) = newline · ⌥←/→ skip words · ⌘←/→ line start/end · ←/→/↑/↓ move cursor · mouse wheel/PageUp/Dn or Ctrl+↑/↓ scroll · /task <pr|branch> · Esc interrupts a turn · Ctrl-C twice (or Ctrl-D / /exit) quits";

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
    // conversation
    pub messages: Vec<ChatMessage>,
    pub transcript: TranscriptView,
    // input
    pub editor: Editor,
    pub input_cache: InputLayoutCache,
    // turn state
    pub running: bool,
    pub turn: Option<TurnHandle>,
    pub since: Instant,
    pub status: String,
    pub current_tool: String,
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
    pub fn new(model_id: &str, root: String, system: String, notices: &[String]) -> Self {
        let mut transcript = TranscriptView::new(vec![
            dim_line(format!("agentj · {model_id} · {root}")),
            dim_line(CHEAT_SHEET),
        ]);
        for n in notices {
            transcript.push(dim_line(format!("! {n}")));
        }
        Self {
            system: system.clone(),
            root,
            messages: vec![ChatMessage::system(system)],
            transcript,
            editor: Editor::default(),
            input_cache: InputLayoutCache::default(),
            running: false,
            turn: None,
            since: Instant::now(),
            status: String::new(),
            current_tool: String::new(),
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
            Action::DeleteToBufferHome => self.edit(|e| e.delete_to_buffer_home()),
            Action::DeleteToLineEnd => self.edit(|e| e.delete_to_line_end()),
            Action::Left => self.edit(|e| e.left()),
            Action::Right => self.edit(|e| e.right()),
            Action::WordLeft => self.edit(|e| e.word_left()),
            Action::WordRight => self.edit(|e| e.word_right()),
            Action::Up => self.edit(|e| e.up()),
            Action::Down => self.edit(|e| e.down()),
            Action::Home => self.edit(|e| e.home()),
            Action::End => self.edit(|e| e.end()),
            Action::ScrollUp => self.scroll_by(-1, true),
            Action::ScrollDown => self.scroll_by(1, false),
            Action::PageUp => self.scroll_by(-10, true),
            Action::PageDown => self.scroll_by(10, false),
            Action::Complete => {
                self.complete();
                AppEffect::None
            }
            Action::AbortTurn => self.abort_turn(),
            Action::CtrlC => self.ctrl_c(),
            Action::Submit(text) => self.submit(text),
        }
    }

    fn edit(&mut self, f: impl FnOnce(&mut Editor)) -> AppEffect {
        f(&mut self.editor);
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

    fn complete(&mut self) {
        let c = complete_command(self.editor.text(), SLASH_COMMANDS);
        let had_candidates = !c.candidates.is_empty();
        self.editor.set(c.line);
        self.dirty = true;
        if had_candidates || self.editor.text() == "/" {
            for cand in SLASH_COMMANDS {
                self.transcript
                    .push(dim_line(format!("  {}  {}", cand.name, cand.summary)));
            }
        }
    }

    fn abort_turn(&mut self) -> AppEffect {
        self.running = false;
        self.status.clear();
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
        self.follow = true;
        self.dirty = true;
        if text.is_empty() {
            AppEffect::None
        } else if text == "/exit" || text == "/quit" {
            AppEffect::Quit
        } else if text == "/task" || text.starts_with("/task ") {
            self.submit_task(&text)
        } else {
            self.transcript.push(Line::from(format!("› {text}")));
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
            self.transcript.push(Line::from(format!("› {desc}")));
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
                self.transcript.extend(assistant_lines(&t));
                self.set_effect("new reply");
            }
            AgentEvent::ToolStart { name, args, .. } => {
                self.current_tool = format!("{name}({args})");
                self.status = self.current_tool.clone();
                self.set_effect(format!("tool: {name}"));
            }
            AgentEvent::ToolEnd {
                summary,
                elapsed_ms,
                ..
            } => {
                self.transcript.push(dim_line(format!(
                    "· {} — {} {summary}",
                    self.current_tool,
                    fmt_ms(elapsed_ms)
                )));
                self.status = "thinking".to_string();
                self.set_effect(format!("done in {}", fmt_ms(elapsed_ms)));
            }
            AgentEvent::SubagentStart { id, desc } => {
                self.transcript.push(dim_line(format!("↳[{id}] {desc}")));
                self.dirty = true;
            }
            AgentEvent::SubagentProgress { id, status } => {
                self.transcript
                    .push(dim_line(format!("↳[{id}] {status}")));
                self.dirty = true;
            }
            AgentEvent::SubagentEnd {
                id,
                ok,
                summary,
                elapsed_ms,
            } => {
                let mark = if ok { "done" } else { "failed" };
                self.transcript.push(dim_line(format!(
                    "↳[{id}] {mark} in {} — {summary}",
                    fmt_ms(elapsed_ms as u128)
                )));
                self.dirty = true;
            }
            AgentEvent::Usage(_) => {} // surfaced in the status line — wired in the visual pass
            AgentEvent::Note(t) => {
                self.transcript.push(dim_line(format!("» {t}")));
                self.dirty = true;
            }
            AgentEvent::Error(e) => {
                self.transcript
                    .push(Line::from(Span::styled(format!("[error] {e}"), theme::err())));
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
        App::new("dummy", ".".to_string(), "sys".to_string(), &[])
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
