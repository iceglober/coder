//! The model loop. Non-streaming: call the model, run the tools it asks for, repeat until it stops
//! calling tools (or hits the step cap). Two loop behaviors layered on top:
//!  - **Background jobs (primary loop only):** inject finished/timed-out job nudges each iteration; when
//!    the model goes idle with jobs still running, wait for the next nudge — but only when it has
//!    nothing else to do.
//!  - **Subagents:** a `delegate` tool call is intercepted here (not run through `tools.call`); each
//!    sub-task runs through a fresh `run_turn` with `allow_delegate=false` (depth cap 1). Independent
//!    sub-tasks run in parallel; only their final results re-enter the parent context.

use crate::config::Config;
use crate::events::AgentEvent;
use crate::provider::{ChatMessage, Llm};
use crate::subagent::subagent_prompt;
use crate::tools::{tool_specs, Tools};
use crate::util::first_line;
use async_recursion::async_recursion;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// Everything a turn needs to talk to the model and run tools, bundled so signatures stay small.
#[derive(Clone)]
pub struct Session {
    pub llm: Arc<Llm>,
    pub tools: Arc<Tools>,
    pub cfg: Arc<Config>,
}

/// One subagent's outcome: its batch index, final result text, and whether it succeeded.
struct SubResult {
    index: usize,
    result: String,
    ok: bool,
}

/// Run each `{ task, context? }` in `args.tasks` as a subagent, in parallel (bounded). Each sub-task's
/// progress is forwarded to `tx` as structured `Subagent*` events. Returns the labeled results joined
/// together for the model, plus whether every sub-task succeeded (for the delegate `ToolEnd.ok`).
async fn run_delegate(sess: &Session, args: &Value, tx: &UnboundedSender<AgentEvent>) -> (String, bool) {
    let tasks: Vec<(String, Option<String>)> = args
        .get("tasks")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let task = t.get("task").and_then(|x| x.as_str())?.to_string();
                    let context = t
                        .get("context")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                    Some((task, context))
                })
                .collect()
        })
        .unwrap_or_default();
    if tasks.is_empty() {
        return (
            "error: delegate needs a non-empty `tasks` array of { task, context? }".to_string(),
            false,
        );
    }

    let _ = tx.send(AgentEvent::Note(format!(
        "delegating {} sub-task(s) in parallel",
        tasks.len()
    )));
    let sem = Arc::new(Semaphore::new(sess.cfg.max_parallel_subagents));
    let mut set: JoinSet<SubResult> = JoinSet::new();
    let mut task_index: HashMap<tokio::task::Id, usize> = HashMap::new();

    for (i, (task, context)) in tasks.into_iter().enumerate() {
        let sess = sess.clone();
        let parent = tx.clone();
        let sem = sem.clone();
        let handle = set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let desc = first_line(&task, 80);
            let _ = parent.send(AgentEvent::SubagentStart { id: i, desc });
            let started = Instant::now();
            let prompt = match context {
                Some(c) => format!("{task}\n\nContext:\n{c}"),
                None => task,
            };
            let mut sub_msgs = vec![
                ChatMessage::system(subagent_prompt()),
                ChatMessage::user(prompt),
            ];
            let (atx, mut arx) = unbounded_channel::<AgentEvent>();

            let fwd = parent.clone();
            let forward = async move {
                let mut saw_error = false;
                while let Some(ev) = arx.recv().await {
                    let status = match ev {
                        AgentEvent::ToolStart { name, args, .. } => Some(format!("{name}({args})")),
                        AgentEvent::Message(t) => Some(first_line(&t, 80)),
                        AgentEvent::Note(t) => Some(t),
                        AgentEvent::Error(e) => {
                            saw_error = true;
                            Some(format!("error: {e}"))
                        }
                        _ => None,
                    };
                    if let Some(status) = status {
                        let _ = fwd.send(AgentEvent::SubagentProgress { id: i, status });
                    }
                }
                saw_error
            };
            let run = async {
                let r = run_turn(&sess, &mut sub_msgs, &atx, false).await;
                drop(atx); // close the channel so the forwarder finishes
                r
            };
            let (result, saw_error) = tokio::join!(run, forward);
            let ok = !saw_error && !result.trim_start().starts_with("error:");
            let _ = parent.send(AgentEvent::SubagentEnd {
                id: i,
                ok,
                summary: first_line(&result, 80),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
            SubResult {
                index: i,
                result,
                ok,
            }
        });
        task_index.insert(handle.id(), i);
    }

    let mut results: Vec<SubResult> = Vec::new();
    while let Some(joined) = set.join_next_with_id().await {
        match joined {
            Ok((_, sub)) => results.push(sub),
            Err(join_err) => {
                // A subagent task panicked or was cancelled — surface it instead of a silent gap.
                let index = task_index.get(&join_err.id()).copied().unwrap_or(usize::MAX);
                let _ = tx.send(AgentEvent::SubagentEnd {
                    id: index,
                    ok: false,
                    summary: format!("subagent task failed: {join_err}"),
                    elapsed_ms: 0,
                });
                results.push(SubResult {
                    index,
                    result: format!("error: subagent task failed: {join_err}"),
                    ok: false,
                });
            }
        }
    }
    results.sort_by_key(|s| s.index);
    let all_ok = results.iter().all(|s| s.ok);
    let joined = results
        .into_iter()
        .map(|s| {
            format!(
                "[subagent {}] {}",
                s.index,
                if s.result.trim().is_empty() {
                    "(no result)".to_string()
                } else {
                    s.result
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n---\n");
    (joined, all_ok)
}

/// Run one turn. `messages` already includes the system prompt, prior history, and the new user turn.
/// Events stream to `tx`. Returns the model's final assistant text (used as a subagent's result).
#[async_recursion]
pub async fn run_turn(
    sess: &Session,
    messages: &mut Vec<ChatMessage>,
    tx: &UnboundedSender<AgentEvent>,
    allow_delegate: bool,
) -> String {
    let mut specs = tool_specs(allow_delegate);
    specs.extend(sess.tools.mcp_specs()); // MCP tools sit alongside the built-ins (subagents inherit them)
    let mut id: u64 = 0;
    let mut idle_nudges = 0usize;
    let mut final_text = String::new();

    for _ in 0..sess.cfg.max_steps {
        // Background jobs are the primary loop's concern only (subagents don't consume nudges).
        if allow_delegate {
            for n in sess.tools.jobs.drain_nudges().await {
                let _ = tx.send(AgentEvent::Note(first_line(&n, 100)));
                messages.push(ChatMessage::user(n));
            }
        }

        let turn = match sess.llm.chat(messages, &specs).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(AgentEvent::Error(e.to_string()));
                return final_text;
            }
        };

        if let Some(text) = turn.content.clone() {
            if !text.trim().is_empty() {
                let _ = tx.send(AgentEvent::Message(text.clone()));
            }
            final_text = text;
        }
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: turn.content.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_call_id: None,
        });

        if turn.tool_calls.is_empty() {
            // The model went idle. If background jobs are still running and it has nothing else to do,
            // wait for the next nudge and continue — it blocks only when there's nothing else to do.
            if allow_delegate
                && sess.tools.jobs.has_running().await
                && idle_nudges < sess.cfg.max_idle_nudges
            {
                let _ = tx.send(AgentEvent::Note("waiting on a background job…".to_string()));
                match tokio::time::timeout(sess.cfg.idle_wait, sess.tools.jobs.next_nudge()).await {
                    Ok(Some(n)) => {
                        idle_nudges += 1;
                        let _ = tx.send(AgentEvent::Note(first_line(&n, 100)));
                        messages.push(ChatMessage::user(n));
                        continue;
                    }
                    _ => {
                        let _ = tx.send(AgentEvent::Note("still waiting on a background job — ending the turn; job_check it next time.".to_string()));
                    }
                }
            }
            let _ = tx.send(AgentEvent::Done);
            return final_text;
        }

        for tc in &turn.tool_calls {
            id += 1;
            let args: Value = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_else(|_| serde_json::json!({}));

            // `delegate` is intercepted here (not run through tools.call) so it can spawn nested loops.
            if allow_delegate && tc.function.name == "delegate" {
                let _ = tx.send(AgentEvent::ToolStart {
                    id,
                    name: "delegate".to_string(),
                    args: first_line(&tc.function.arguments, 100),
                });
                let start = Instant::now();
                let (result, all_ok) = run_delegate(sess, &args, tx).await;
                let _ = tx.send(AgentEvent::ToolEnd {
                    id,
                    ok: all_ok,
                    elapsed_ms: start.elapsed().as_millis(),
                    summary: first_line(&result, 60),
                });
                messages.push(ChatMessage {
                    role: "tool".into(),
                    content: Some(result),
                    tool_calls: vec![],
                    tool_call_id: Some(tc.id.clone()),
                });
                continue;
            }

            let _ = tx.send(AgentEvent::ToolStart {
                id,
                name: tc.function.name.clone(),
                args: first_line(&tc.function.arguments, 100),
            });
            let start = Instant::now();
            let result = sess.tools.call(&tc.function.name, &args).await;
            let _ = tx.send(AgentEvent::ToolEnd {
                id,
                ok: true,
                elapsed_ms: start.elapsed().as_millis(),
                summary: first_line(&result, 60),
            });
            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(result),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
            });
        }
    }

    let _ = tx.send(AgentEvent::Note(format!(
        "hit the {}-step limit — send another message to continue.",
        sess.cfg.max_steps
    )));
    let _ = tx.send(AgentEvent::Done);
    final_text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::jobs::JobManager;
    use crate::provider::{AssistantTurn, FunctionCall, ScriptStep, ToolCall};
    use crate::tools::{tool_specs, Tools};
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn delegate_spec_gated_by_allow_delegate() {
        let with = tool_specs(true);
        let without = tool_specs(false);
        assert!(with.iter().any(|s| s.name == "delegate"));
        assert!(!without.iter().any(|s| s.name == "delegate"));
        // job tools are present in both.
        assert!(without.iter().any(|s| s.name == "job_start"));
    }

    fn test_cfg() -> Config {
        Config {
            max_steps: 40,
            max_idle_nudges: 6,
            idle_wait: Duration::from_secs(120),
            max_parallel_subagents: 4,
        }
    }

    fn session(steps: Vec<ScriptStep>) -> Session {
        let jobs = JobManager::new(".".to_string());
        let tools = Tools::new(PathBuf::from("."), jobs, None);
        Session {
            llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::from(steps)))),
            tools: Arc::new(tools),
            cfg: Arc::new(test_cfg()),
        }
    }

    fn turn_text(s: &str) -> AssistantTurn {
        AssistantTurn {
            content: Some(s.to_string()),
            tool_calls: vec![],
            finish_reason: "stop".into(),
        }
    }

    fn turn_delegate(tasks: &[&str]) -> AssistantTurn {
        let items: Vec<_> = tasks.iter().map(|t| serde_json::json!({ "task": t })).collect();
        let args = serde_json::json!({ "tasks": items }).to_string();
        AssistantTurn {
            content: None,
            tool_calls: vec![ToolCall {
                id: "call_1".into(),
                kind: "function".into(),
                function: FunctionCall {
                    name: "delegate".into(),
                    arguments: args,
                },
            }],
            finish_reason: "tool_calls".into(),
        }
    }

    async fn run_and_collect(sess: &Session) -> Vec<AgentEvent> {
        let (tx, mut rx) = unbounded_channel::<AgentEvent>();
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
        let _ = run_turn(sess, &mut msgs, &tx, true).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        events
    }

    #[tokio::test]
    async fn delegate_emits_structured_lifecycle_events() {
        let sess = session(vec![
            ScriptStep::Turn(turn_delegate(&["investigate the parser"])),
            ScriptStep::Turn(turn_text("subagent done: the parser is fine")),
            ScriptStep::Turn(turn_text("all wrapped up")),
        ]);
        let events = run_and_collect(&sess).await;

        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::SubagentStart { id: 0, .. })),
            "expected a SubagentStart, got: {events:?}"
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentEnd { id: 0, ok: true, .. })));
        // the delegate call itself reports success
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, .. })));
        // the flattened `↳[i]` Note lines are gone
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::Note(t) if t.contains("↳"))));
    }

    #[tokio::test]
    async fn panicked_subagent_surfaces_as_failed_end() {
        let sess = session(vec![
            ScriptStep::Turn(turn_delegate(&["trigger a crash"])),
            ScriptStep::Panic, // the subagent's model call panics
            ScriptStep::Turn(turn_text("recovered and carried on")),
        ]);
        let events = run_and_collect(&sess).await;

        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::SubagentEnd { ok: false, .. })),
            "a panicked subagent should still report a failed end, got: {events:?}"
        );
        // and the delegate tool call reports failure rather than silently succeeding
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolEnd { ok: false, .. })));
    }

    #[tokio::test]
    async fn model_error_emits_error_event_and_ends_turn() {
        let sess = session(vec![ScriptStep::Err("upstream 503".into())]);
        let events = run_and_collect(&sess).await;
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error(m) if m.contains("upstream 503"))));
        // no Done after a hard error — the turn returns early
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Done)));
    }

    #[tokio::test]
    async fn delegate_reports_failure_when_a_subagent_returns_an_error_result() {
        let sess = session(vec![
            ScriptStep::Turn(turn_delegate(&["do the thing"])),
            ScriptStep::Turn(turn_text("error: could not do the thing")),
            ScriptStep::Turn(turn_text("done")),
        ]);
        let events = run_and_collect(&sess).await;

        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentEnd { ok: false, .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolEnd { ok: false, .. })));
    }
}
