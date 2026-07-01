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

/// Map a subagent's event into a dim, indexed `↳[i]` progress line for the user (never the model).
fn subagent_line(i: usize, ev: &AgentEvent) -> Option<String> {
    match ev {
        AgentEvent::ToolStart { name, args, .. } => Some(format!("↳[{i}] {name}({args})")),
        AgentEvent::Message(t) => Some(format!("↳[{i}] {}", first_line(t, 80))),
        AgentEvent::Note(t) => Some(format!("↳[{i}] {t}")),
        AgentEvent::Error(e) => Some(format!("↳[{i}] error: {e}")),
        _ => None,
    }
}

/// Run each `{ task, context? }` in `args.tasks` as a subagent, in parallel (bounded), forwarding
/// their steps to `tx` as dim `↳[i]` lines. Returns the labeled results joined together.
async fn run_delegate(sess: &Session, args: &Value, tx: &UnboundedSender<AgentEvent>) -> String {
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
        return "error: delegate needs a non-empty `tasks` array of { task, context? }".to_string();
    }

    let _ = tx.send(AgentEvent::Note(format!(
        "delegating {} sub-task(s) in parallel",
        tasks.len()
    )));
    let sem = Arc::new(Semaphore::new(sess.cfg.max_parallel_subagents));
    let mut set: JoinSet<(usize, String)> = JoinSet::new();

    for (i, (task, context)) in tasks.into_iter().enumerate() {
        let sess = sess.clone();
        let parent = tx.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
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
                while let Some(ev) = arx.recv().await {
                    if let Some(line) = subagent_line(i, &ev) {
                        let _ = fwd.send(AgentEvent::Note(line));
                    }
                }
            };
            let run = async {
                let r = run_turn(&sess, &mut sub_msgs, &atx, false).await;
                drop(atx); // close the channel so the forwarder finishes
                r
            };
            let (result, _) = tokio::join!(run, forward);
            (i, result)
        });
    }

    let mut results: Vec<(usize, String)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(pair) = joined {
            results.push(pair);
        }
    }
    results.sort_by_key(|(i, _)| *i);
    results
        .into_iter()
        .map(|(i, r)| {
            format!(
                "[subagent {i}] {}",
                if r.trim().is_empty() {
                    "(no result)".to_string()
                } else {
                    r
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n---\n")
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
                let result = run_delegate(sess, &args, tx).await;
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
    use crate::tools::tool_specs;

    #[test]
    fn delegate_spec_gated_by_allow_delegate() {
        let with = tool_specs(true);
        let without = tool_specs(false);
        assert!(with.iter().any(|s| s.name == "delegate"));
        assert!(!without.iter().any(|s| s.name == "delegate"));
        // job tools are present in both.
        assert!(without.iter().any(|s| s.name == "job_start"));
    }
}
