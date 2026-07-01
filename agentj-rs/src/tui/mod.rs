//! Interactive full-screen ratatui chat: a transcript / status / input layout driven by an event loop
//! over three sources (a 120ms animation ticker, terminal input from a reader thread, and agent events
//! from the turn task). State and transitions live in `app`; rendering in `view`.

mod app;
mod editor;
mod keymap;
mod theme;
mod view;

use crate::agent::{run_turn, Session};
use crate::events::AgentEvent;
use crate::provider::ChatMessage;
use crate::rekey::rekey;
use app::{App, AppEffect, UiMsg};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use keymap::KEYBOARD_FLAGS;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::time::interval;

/// Spawn a turn: clone history + append the user message, run it in the background, forward its events
/// as `UiMsg::Agent`, and send `TurnComplete` with the final history when it's done. Returns the abort
/// handle so Ctrl-C can cancel it (which drops the user turn — history is only committed on completion).
fn spawn_turn(
    text: String,
    history: &[ChatMessage],
    sess: Session,
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
            let _ = run_turn(&sess, &mut msgs, &atx, true).await;
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
    sess: Session,
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
    // terminal supports it (kitty/ghostty/wezterm/newer iTerm2), and chords like Cmd/Ctrl+Backspace
    // are surfaced distinctly instead of collapsing to a plain Backspace byte on PTYs.
    let _ = execute!(stdout, PushKeyboardEnhancementFlags(KEYBOARD_FLAGS));
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let mut app = App::new(&model_id, root, system, &notices);

    let (ui_tx, mut ui_rx) = unbounded_channel::<UiMsg>();
    let (in_tx, mut in_rx) = unbounded_channel::<Event>();
    std::thread::spawn(move || {
        while let Ok(ev) = crossterm::event::read() {
            if in_tx.send(ev).is_err() {
                break;
            }
        }
    });
    let mut ticker = interval(Duration::from_millis(120));

    while !app.quit {
        if app.dirty {
            let width = terminal.size()?.width;
            app.refresh_input(width);
            terminal.draw(|f| view::draw(f, &mut app))?;
            app.dirty = false;
        }

        tokio::select! {
            _ = ticker.tick() => app.on_tick(Instant::now()),
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
                    match app.on_input(ev) {
                        AppEffect::None => {}
                        AppEffect::Quit => app.quit = true,
                        AppEffect::SpawnTurn(text) => {
                            app.turn =
                                Some(spawn_turn(text, &app.messages, sess.clone(), ui_tx.clone()));
                        }
                        AppEffect::Rekey { reference, desc } => {
                            let rk = rekey(&app.root, &reference).await;
                            if let Some(text) = app.apply_rekey_result(rk, desc) {
                                app.turn = Some(spawn_turn(
                                    text,
                                    &app.messages,
                                    sess.clone(),
                                    ui_tx.clone(),
                                ));
                            }
                        }
                    }
                    if app.quit {
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
                    app.on_ui(msg);
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
