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
            // Generous cap: the tray gives the title the full row width, so keep it intact.
            let desc = first_line(&task, 160);
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
                // Subagents don't commit deltas — only their final result re-enters the parent.
                let r = run_turn(&sess, &mut sub_msgs, &atx, false, None).await;
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
/// Events stream to `tx`. When `commit` is set, each newly appended message (or tool-call group) is
/// also sent through it as a delta, so the UI can fold completed steps into its history as the turn
/// progresses — an interrupted turn then keeps whatever already applied. Returns the model's final
/// assistant text (used as a subagent's result).
#[async_recursion]
pub async fn run_turn(
    sess: &Session,
    messages: &mut Vec<ChatMessage>,
    tx: &UnboundedSender<AgentEvent>,
    allow_delegate: bool,
    commit: Option<&UnboundedSender<Vec<ChatMessage>>>,
) -> String {
    let mut specs = tool_specs(allow_delegate);
    specs.extend(sess.tools.mcp_specs()); // MCP tools sit alongside the built-ins (subagents inherit them)
    let mut idle_nudges = 0usize;
    let mut final_text = String::new();
    let commit_delta = |delta: Vec<ChatMessage>| {
        if let Some(c) = commit {
            let _ = c.send(delta);
        }
    };

    for _ in 0..sess.cfg.max_steps {
        // Background jobs are the primary loop's concern only (subagents don't consume nudges).
        if allow_delegate {
            for n in sess.tools.jobs.drain_nudges() {
                let _ = tx.send(AgentEvent::Note(first_line(&n, 100)));
                let m = ChatMessage::user(n);
                commit_delta(vec![m.clone()]);
                messages.push(m);
            }
        }

        let turn = match sess.llm.chat(messages, &specs).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(AgentEvent::Error(e.to_string()));
                return final_text;
            }
        };

        if let Some(usage) = turn.usage {
            let _ = tx.send(AgentEvent::Usage(usage));
        }
        if turn.finish_reason == "length" {
            let _ = tx.send(AgentEvent::Note(
                "response truncated (finish_reason=length)".to_string(),
            ));
        }

        if let Some(text) = turn.content.clone() {
            if !text.trim().is_empty() {
                let _ = tx.send(AgentEvent::Message(text.clone()));
            }
            final_text = text;
        }
        let assistant = ChatMessage {
            role: "assistant".into(),
            content: turn.content.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_call_id: None,
        };
        messages.push(assistant.clone());

        if turn.tool_calls.is_empty() {
            // A bare assistant reply commits on its own.
            commit_delta(vec![assistant]);
            // The model went idle. If background jobs are still running and it has nothing else to do,
            // wait for the next nudge and continue — it blocks only when there's nothing else to do.
            if allow_delegate
                && sess.tools.jobs.has_running()
                && idle_nudges < sess.cfg.max_idle_nudges
            {
                let _ = tx.send(AgentEvent::Note("waiting on a background job…".to_string()));
                match tokio::time::timeout(sess.cfg.idle_wait, sess.tools.jobs.next_nudge()).await {
                    Ok(n) => {
                        idle_nudges += 1;
                        let _ = tx.send(AgentEvent::Note(first_line(&n, 100)));
                        let m = ChatMessage::user(n);
                        commit_delta(vec![m.clone()]);
                        messages.push(m);
                        continue;
                    }
                    Err(_) => {
                        let _ = tx.send(AgentEvent::Note("still waiting on a background job — ending the turn; job_check it next time.".to_string()));
                    }
                }
            }
            let _ = tx.send(AgentEvent::Done);
            return final_text;
        }

        // Commit the assistant message and all its tool replies together, so an interrupt can't leave
        // a dangling `tool_calls` request without its matching tool responses in the committed history.
        let mut delta = vec![assistant];
        for tc in &turn.tool_calls {
            let args: Value = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_else(|_| serde_json::json!({}));

            // `delegate` is intercepted here (not run through tools.call) so it can spawn nested loops.
            let (name, is_delegate) = if allow_delegate && tc.function.name == "delegate" {
                ("delegate".to_string(), true)
            } else {
                (tc.function.name.clone(), false)
            };
            let _ = tx.send(AgentEvent::ToolStart {
                name,
                args: first_line(&tc.function.arguments, 100),
            });
            let start = Instant::now();
            let (text, ok) = if is_delegate {
                run_delegate(sess, &args, tx).await
            } else {
                let o = sess.tools.call(&tc.function.name, &args).await;
                (o.text, o.ok)
            };
            let _ = tx.send(AgentEvent::ToolEnd {
                ok,
                elapsed_ms: start.elapsed().as_millis(),
                summary: first_line(&text, 60),
            });
            let tool_msg = ChatMessage {
                role: "tool".into(),
                content: Some(text),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
            };
            messages.push(tool_msg.clone());
            delta.push(tool_msg);
        }
        commit_delta(delta);
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
    use crate::provider::{AssistantTurn, FunctionCall, ScriptStep, TokenUsage, ToolCall};
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
            context_window: None,
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
            usage: None,
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
            usage: None,
        }
    }

    fn turn_tool(name: &str, args: serde_json::Value) -> AssistantTurn {
        AssistantTurn {
            content: None,
            tool_calls: vec![ToolCall {
                id: "call_x".into(),
                kind: "function".into(),
                function: FunctionCall {
                    name: name.into(),
                    arguments: args.to_string(),
                },
            }],
            finish_reason: "tool_calls".into(),
            usage: None,
        }
    }

    async fn run_and_collect(sess: &Session) -> Vec<AgentEvent> {
        let (tx, mut rx) = unbounded_channel::<AgentEvent>();
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
        let _ = run_turn(sess, &mut msgs, &tx, true, None).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        events
    }

    /// Run a turn collecting both events and the committed history deltas.
    async fn run_with_commit(sess: &Session) -> (Vec<AgentEvent>, Vec<Vec<ChatMessage>>) {
        let (tx, mut rx) = unbounded_channel::<AgentEvent>();
        let (ctx, mut crx) = unbounded_channel::<Vec<ChatMessage>>();
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
        let _ = run_turn(sess, &mut msgs, &tx, true, Some(&ctx)).await;
        drop(tx);
        drop(ctx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        let mut deltas = Vec::new();
        while let Some(d) = crx.recv().await {
            deltas.push(d);
        }
        (events, deltas)
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
    async fn commit_deltas_preserve_toolcall_reply_pairing() {
        let sess = session(vec![
            ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" }))),
            ScriptStep::Turn(turn_text("done reading")),
        ]);
        let (_events, deltas) = run_with_commit(&sess).await;

        // The assistant message carrying tool_calls and its tool reply land in the SAME delta.
        let paired = deltas.iter().any(|d| {
            d.iter().any(|m| m.role == "assistant" && !m.tool_calls.is_empty())
                && d.iter().any(|m| m.role == "tool")
        });
        assert!(
            paired,
            "assistant tool_calls and its tool reply must commit together: {deltas:?}"
        );
        // The final bare assistant reply commits on its own.
        assert!(deltas
            .iter()
            .any(|d| d.len() == 1 && d[0].role == "assistant" && d[0].tool_calls.is_empty()));
    }

    #[tokio::test]
    async fn usage_event_emitted_per_model_call() {
        let mut turn = turn_text("done");
        turn.usage = Some(TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            cached_tokens: None,
        });
        let sess = session(vec![ScriptStep::Turn(turn)]);
        let events = run_and_collect(&sess).await;
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Usage(u) if u.total_tokens == 120 && u.prompt_tokens == 100
        )));
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
