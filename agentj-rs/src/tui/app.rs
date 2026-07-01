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
    /// A turn finished: its full message history (feeds the next turn).
    TurnComplete(Vec<ChatMessage>),
}

/// Work the event loop must perform after a state transition (it needs `.await` or the turn task's
/// handles, which `App` doesn't own).
pub enum AppEffect {
    None,
    Quit,
    /// Spawn a turn for this user text; the loop stores the resulting abort handle in `App::turn`.
    SpawnTurn(String),
    /// Run a `/task` re-key, then feed the result back via `apply_rekey_result`.
    Rekey { reference: String, desc: String },
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
    pub turn: Option<AbortHandle>,
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
            Action::AbortTurn => {
                self.abort_turn();
                AppEffect::None
            }
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

    fn abort_turn(&mut self) {
        if let Some(h) = self.turn.take() {
            h.abort();
        }
        self.running = false;
        self.status.clear();
        self.transcript.push(dim_line("[interrupted]"));
        self.follow = true;
        self.set_effect("interrupted");
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
            self.running = true;
            self.since = Instant::now();
            self.status.clear();
            self.set_effect("let's cook");
            AppEffect::SpawnTurn(text)
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

    /// Fold a completed `/task` re-key into state. Returns the task description to spawn, if any.
    pub fn apply_rekey_result(&mut self, rk: RekeyResult, desc: String) -> Option<String> {
        for s in &rk.steps {
            self.transcript.push(dim_line(format!("  · {s}")));
        }
        if !rk.ok {
            self.transcript.push(dim_line(format!(
                "» re-key failed: {}",
                rk.error.unwrap_or_default()
            )));
            self.set_effect("re-key failed");
            return None;
        }
        let branch = rk.branch.unwrap_or_default();
        self.transcript
            .push(dim_line(format!("» clean on {branch}, synced to origin")));
        self.set_effect(format!("switched to {branch}"));
        self.messages = vec![ChatMessage::system(self.system.clone())];
        if desc.is_empty() {
            None
        } else {
            self.transcript.push(Line::from(format!("› {desc}")));
            self.running = true;
            self.since = Instant::now();
            self.status.clear();
            self.last_effect_active = true;
            self.dirty = true;
            Some(desc)
        }
    }

    pub fn on_ui(&mut self, msg: UiMsg) {
        match msg {
            UiMsg::Agent(ev) => self.on_agent(ev),
            UiMsg::TurnComplete(m) => {
                self.messages = m;
                self.running = false;
                self.status.clear();
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
        assert!(matches!(effect, AppEffect::SpawnTurn(t) if t == "hello"));
        assert!(a.running);
        assert!(a.editor.text().is_empty());
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
