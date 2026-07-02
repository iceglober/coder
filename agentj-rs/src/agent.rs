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

/// Direct (non-delegate) tool calls in one turn before the single SPEAR re-anchor nudge fires. The
/// prompt's own heuristic is "delegate what you can't name the files for" — this is the backstop
/// when execution sprawls anyway. Advisory, once per turn; primary loop only.
const SPEAR_NUDGE_AFTER: usize = 8;

/// One subagent's outcome: its batch index, final result text, and whether it succeeded.
struct SubResult {
    index: usize,
    result: String,
    ok: bool,
}

/// The label a subagent shows in the tray: the model-supplied `title` when present, else the first
/// sentence of the task (so instruction boilerplate like "Return a tight factual summary…" doesn't
/// ride along), capped for sanity.
fn task_label(task: &str, title: Option<&str>) -> String {
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        return first_line(t, 80);
    }
    let line = first_line(task, 400);
    let sentence = match line.find(". ") {
        Some(i) => line[..=i].trim_end(),
        None => line.as_str(),
    };
    if sentence.chars().count() > 100 {
        format!("{}…", sentence.chars().take(99).collect::<String>())
    } else {
        sentence.to_string()
    }
}

/// Run each `{ task, context? }` in `args.tasks` as a subagent, in parallel (bounded). Each sub-task's
/// progress is forwarded to `tx` as structured `Subagent*` events. Returns the labeled results joined
/// together for the model, plus whether every sub-task succeeded (for the delegate `ToolEnd.ok`).
async fn run_delegate(sess: &Session, args: &Value, tx: &UnboundedSender<AgentEvent>) -> (String, bool) {
    let tasks: Vec<(String, Option<String>, String)> = args
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
                    let label = task_label(&task, t.get("title").and_then(|x| x.as_str()));
                    Some((task, context, label))
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
    // Every subagent shares one seeded system prompt: identity + cwd + the repo's AGENTS.md, so it
    // starts oriented instead of re-deriving the project from scratch.
    let sub_system = crate::prompt::subagent_system_prompt(
        &sess.tools.root.to_string_lossy(),
        sess.cfg.check.as_deref(),
    );
    let sem = Arc::new(Semaphore::new(sess.cfg.max_parallel_subagents));
    let mut set: JoinSet<SubResult> = JoinSet::new();
    let mut task_index: HashMap<tokio::task::Id, usize> = HashMap::new();

    for (i, (task, context, label)) in tasks.into_iter().enumerate() {
        let sess = sess.clone();
        let parent = tx.clone();
        let sem = sem.clone();
        let sub_system = sub_system.clone();
        let handle = set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let _ = parent.send(AgentEvent::SubagentStart { id: i, desc: label });
            let started = Instant::now();
            let prompt = match context {
                Some(c) => format!("{task}\n\nContext:\n{c}"),
                None => task,
            };
            let mut sub_msgs = vec![
                ChatMessage::system(sub_system),
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

/// True when a bash command looks like it runs the project's checks. The configured `check` command
/// wins; otherwise a conservative list of common test/build invocations.
fn is_check_command(cmd: &str, configured: Option<&str>) -> bool {
    if let Some(c) = configured {
        let c = c.trim();
        if !c.is_empty() && cmd.contains(c) {
            return true;
        }
    }
    const HINTS: [&str; 12] = [
        "cargo test", "cargo check", "cargo clippy", "pytest", "go test", "bun test", "npm test",
        "pnpm test", "pnpm -r test", "vitest", "make test", "make check",
    ];
    HINTS.iter().any(|h| cmd.contains(h))
}

/// Once the context is past the compaction threshold, elide the BODIES of older tool results —
/// the last `keep_recent` stay intact, and the messages themselves remain (the OpenAI wire format
/// requires a tool reply per tool_call id). Returns how many results were elided.
fn compact_history(messages: &mut [ChatMessage], keep_recent: usize) -> usize {
    let tool_idxs: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == "tool")
        .map(|(i, _)| i)
        .collect();
    if tool_idxs.len() <= keep_recent {
        return 0;
    }
    let mut elided = 0;
    for &i in &tool_idxs[..tool_idxs.len() - keep_recent] {
        if let Some(c) = &messages[i].content {
            if c.len() > 200 && !c.starts_with("[elided") {
                messages[i].content = Some(format!(
                    "[elided older tool result ({} chars) — re-run the tool if you need it again]",
                    c.len()
                ));
                elided += 1;
            }
        }
    }
    elided
}

/// Tool results older than this many stay verbatim during compaction.
const COMPACT_KEEP_RECENT: usize = 8;

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
    let mut direct_calls = 0usize; // non-delegate tool calls this turn
    let mut used_delegate = false;
    let mut spear_nudged = false;
    let mut edited_since_check = false; // a write/edit landed with no passing check after it
    let mut assess_nudged = false;
    let mut committed_this_turn = false;
    let mut commit_nudged = false;
    let mut last_prompt_tokens: u64 = 0;

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

        // Context compaction: past ~70% of the window, elide older tool-result bodies so long tasks
        // don't hit the wall. The durable (TUI) history keeps full text; this trims the working copy.
        if let Some(window) = sess.cfg.context_window {
            if last_prompt_tokens > window * 7 / 10 {
                let n = compact_history(messages, COMPACT_KEEP_RECENT);
                if n > 0 {
                    let _ = tx.send(AgentEvent::Note(format!(
                        "context compacted — elided {n} older tool results"
                    )));
                }
            }
        }

        // SPEAR re-anchor: once per turn, if direct execution has run long with no delegation, remind
        // the model to check its trajectory against PLAN. Advisory — the model decides what to do.
        if allow_delegate && !spear_nudged && !used_delegate && direct_calls >= SPEAR_NUDGE_AFTER {
            spear_nudged = true;
            let msg = format!(
                "[supervisor: SPEAR check — {direct_calls} direct tool calls this turn and no delegation yet. \
                 If the remaining work is an investigation or splits into independent sub-tasks, hand it to \
                 `delegate` now to keep your context focused; if direct execution is genuinely right for \
                 what's left, continue.]"
            );
            let _ = tx.send(AgentEvent::Note(first_line(&msg, 120)));
            let m = ChatMessage::user(msg);
            commit_delta(vec![m.clone()]);
            messages.push(m);
        }

        let turn = match sess.llm.chat(messages, &specs).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(AgentEvent::Error(e.to_string()));
                return final_text;
            }
        };

        if let Some(usage) = turn.usage {
            last_prompt_tokens = usage.prompt_tokens;
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

            // ASSESS gate: edits landed but no project check has PASSED since the last one — one
            // supervisor nudge before the turn may end. The agent verifies without being asked.
            if edited_since_check && !assess_nudged {
                assess_nudged = true;
                let hint = sess
                    .cfg
                    .check
                    .as_deref()
                    .map(|c| format!(" (`{c}`)"))
                    .unwrap_or_default();
                let msg = format!(
                    "[supervisor: ASSESS check — you edited files this turn but no project check has \
                     passed since the last edit. Run the project's checks{hint} and show the result \
                     before finishing; if a check genuinely doesn't apply, say why in your final report.]"
                );
                let _ = tx.send(AgentEvent::Note(first_line(&msg, 120)));
                let m = ChatMessage::user(msg);
                commit_delta(vec![m.clone()]);
                messages.push(m);
                continue;
            }

            // RESOLVE gate (primary loop): a commit happened but the tree is still dirty — the
            // half-shipped-change failure mode. One nudge listing the stragglers.
            if allow_delegate && committed_this_turn && !commit_nudged {
                commit_nudged = true;
                let root = sess.tools.root.to_string_lossy().to_string();
                if let Ok(o) = crate::exec::run(&["git", "status", "--porcelain"], &root, None).await {
                    let dirty: Vec<&str> = o.stdout.lines().filter(|l| !l.is_empty()).take(15).collect();
                    if o.exit_code == 0 && !dirty.is_empty() {
                        let msg = format!(
                            "[supervisor: RESOLVE check — you committed this turn, but the working tree \
                             still has uncommitted changes:\n{}\nCommit what belongs with your change, \
                             or explain in your final report why these are excluded.]",
                            dirty.join("\n")
                        );
                        let _ = tx.send(AgentEvent::Note(first_line(&msg, 120)));
                        let m = ChatMessage::user(msg);
                        commit_delta(vec![m.clone()]);
                        messages.push(m);
                        continue;
                    }
                }
            }

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
            if is_delegate {
                used_delegate = true;
            } else {
                direct_calls += 1;
            }
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
            // Finishing-gate bookkeeping: edits arm the ASSESS gate; a passing check clears it; a
            // git commit arms the RESOLVE completeness gate.
            if !is_delegate {
                match tc.function.name.as_str() {
                    "write_file" | "edit_file" if ok => edited_since_check = true,
                    "bash" => {
                        if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                            if is_check_command(cmd, sess.cfg.check.as_deref()) && text.contains("[exit 0]") {
                                edited_since_check = false;
                            }
                            // `git -c user=… commit`, `git commit -m`, etc. — any git invocation
                            // with a `commit` word arms the completeness gate.
                            let is_commit = cmd.contains("git")
                                && cmd.split_whitespace().any(|w| w == "commit");
                            if is_commit && text.contains("[exit 0]") {
                                committed_this_turn = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
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
            check: None,
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

    #[test]
    fn task_label_prefers_title_then_first_sentence() {
        assert_eq!(task_label("whatever", Some("Map the crate")), "Map the crate");
        assert_eq!(
            task_label(
                "Map the Rust product in agentj-rs/. Return a tight factual summary with paths.",
                None
            ),
            "Map the Rust product in agentj-rs/."
        );
        // whitespace-only title falls back
        assert_eq!(task_label("Do the thing. And more.", Some("  ")), "Do the thing.");
        // no sentence boundary → capped
        let long = "x".repeat(150);
        assert_eq!(task_label(&long, None).chars().count(), 100);
    }

    #[tokio::test]
    async fn delegate_title_becomes_the_tray_label() {
        let args = serde_json::json!({
            "tasks": [{ "task": "Map the Rust product. Return a summary.", "title": "Map the Rust crate" }]
        })
        .to_string();
        let sess = session(vec![
            ScriptStep::Turn(AssistantTurn {
                content: None,
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "delegate".into(),
                        arguments: args,
                    },
                }],
                finish_reason: "tool_calls".into(),
                usage: None,
            }),
            ScriptStep::Turn(turn_text("sub result")),
            ScriptStep::Turn(turn_text("done")),
        ]);
        let events = run_and_collect(&sess).await;
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentStart { desc, .. } if desc == "Map the Rust crate")));
    }

    fn session_in(root: &str, steps: Vec<ScriptStep>, check: Option<&str>) -> Session {
        let jobs = JobManager::new(root.to_string());
        let tools = Tools::new(PathBuf::from(root), jobs, None);
        let mut cfg = test_cfg();
        cfg.check = check.map(String::from);
        Session {
            llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::from(steps)))),
            tools: Arc::new(tools),
            cfg: Arc::new(cfg),
        }
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentj-agent-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn notes_containing(events: &[AgentEvent], needle: &str) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Note(t) if t.contains(needle)))
            .count()
    }

    #[tokio::test]
    async fn assess_gate_nudges_unverified_edits_once_then_lets_go() {
        let dir = temp_root("assess");
        let sess = session_in(
            dir.to_str().unwrap(),
            vec![
                ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "a.txt", "content": "x" }))),
                ScriptStep::Turn(turn_text("all done")), // tries to finish without checking → nudged
                ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "echo CHECK OK" }))),
                ScriptStep::Turn(turn_text("done, checks pass")),
            ],
            Some("echo CHECK"),
        );
        let events = run_and_collect(&sess).await;
        assert_eq!(notes_containing(&events, "ASSESS check"), 1, "{events:?}");
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Done)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn assess_gate_stays_quiet_when_the_agent_already_verified() {
        let dir = temp_root("assess-ok");
        let sess = session_in(
            dir.to_str().unwrap(),
            vec![
                ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "a.txt", "content": "x" }))),
                ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "echo CHECK OK" }))),
                ScriptStep::Turn(turn_text("done, verified")),
            ],
            Some("echo CHECK"),
        );
        let events = run_and_collect(&sess).await;
        assert_eq!(notes_containing(&events, "ASSESS check"), 0, "{events:?}");
        // read-only turns are never nudged either
        let dir2 = temp_root("assess-ro");
        std::fs::write(dir2.join("r.txt"), "hi").unwrap();
        let sess = session_in(
            dir2.to_str().unwrap(),
            vec![
                ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "r.txt" }))),
                ScriptStep::Turn(turn_text("answer")),
            ],
            None,
        );
        let events = run_and_collect(&sess).await;
        assert_eq!(notes_containing(&events, "ASSESS check"), 0);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[tokio::test]
    async fn resolve_gate_flags_a_partial_commit() {
        let dir = temp_root("resolve");
        let root = dir.to_str().unwrap().to_string();
        crate::exec::run(&["git", "init", "-q"], &root, None).await.unwrap();
        std::fs::write(dir.join("a.txt"), "committed half").unwrap();
        std::fs::write(dir.join("b.txt"), "forgotten half").unwrap();
        const GIT_C: &str = "git -c user.email=t@t -c user.name=t";
        let sess = session_in(
            &root,
            vec![
                ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add a.txt && {GIT_C} commit -qm half") }))),
                ScriptStep::Turn(turn_text("shipped!")), // tree still dirty (b.txt) → nudged
                ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add -A && {GIT_C} commit -qm rest") }))),
                ScriptStep::Turn(turn_text("now fully shipped")),
            ],
            None,
        );
        let events = run_and_collect(&sess).await;
        assert_eq!(notes_containing(&events, "RESOLVE check"), 1, "{events:?}");
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Done)));
        // a clean full commit is not nudged
        let dir2 = temp_root("resolve-ok");
        let root2 = dir2.to_str().unwrap().to_string();
        crate::exec::run(&["git", "init", "-q"], &root2, None).await.unwrap();
        std::fs::write(dir2.join("a.txt"), "everything").unwrap();
        let sess = session_in(
            &root2,
            vec![
                ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add -A && {GIT_C} commit -qm all") }))),
                ScriptStep::Turn(turn_text("shipped")),
            ],
            None,
        );
        let events = run_and_collect(&sess).await;
        assert_eq!(notes_containing(&events, "RESOLVE check"), 0, "{events:?}");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn compaction_elides_old_tool_bodies_and_is_idempotent() {
        let big = "x".repeat(300);
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
        for i in 0..12 {
            msgs.push(ChatMessage {
                role: "tool".into(),
                content: Some(big.clone()),
                tool_calls: vec![],
                tool_call_id: Some(format!("c{i}")),
            });
        }
        assert_eq!(compact_history(&mut msgs, 8), 4);
        assert!(msgs[2].content.as_deref().unwrap().starts_with("[elided"));
        assert!(!msgs[6].content.as_deref().unwrap().starts_with("[elided"), "recent kept");
        assert_eq!(compact_history(&mut msgs, 8), 0, "idempotent");
        // small results and non-tool roles are untouched
        assert_eq!(msgs[0].content.as_deref(), Some("sys"));
    }

    #[test]
    fn check_command_detection() {
        assert!(is_check_command("cargo test --lib", None));
        assert!(is_check_command("cd app && python -m pytest -q", None));
        assert!(!is_check_command("echo hello", None));
        assert!(is_check_command("echo hello", Some("echo hello")));
        assert!(is_check_command("bash -lc 'make verify'", Some("make verify")));
    }

    fn spear_notes(events: &[AgentEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Note(t) if t.contains("SPEAR check")))
            .count()
    }

    #[tokio::test]
    async fn spear_nudge_fires_once_after_sustained_direct_execution() {
        // 10 direct tool calls, no delegation → exactly one advisory nudge (at the threshold), and
        // the nudge enters committed history so the model sees it.
        let mut steps: Vec<ScriptStep> = (0..10)
            .map(|_| ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" }))))
            .collect();
        steps.push(ScriptStep::Turn(turn_text("done")));
        let sess = session(steps);
        let (events, deltas) = run_with_commit(&sess).await;

        assert_eq!(spear_notes(&events), 1, "one nudge, not repeated: {events:?}");
        assert!(deltas.iter().flatten().any(|m| m.role == "user"
            && m.content.as_deref().is_some_and(|c| c.contains("SPEAR check"))));
    }

    #[tokio::test]
    async fn spear_nudge_skipped_when_the_turn_delegates_or_stays_short() {
        // Delegating early suppresses the nudge entirely…
        let mut steps = vec![
            ScriptStep::Turn(turn_delegate(&["investigate"])),
            ScriptStep::Turn(turn_text("subagent result")),
        ];
        steps.extend(
            (0..10).map(|_| {
                ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" })))
            }),
        );
        steps.push(ScriptStep::Turn(turn_text("done")));
        let sess = session(steps);
        let events = run_and_collect(&sess).await;
        assert_eq!(spear_notes(&events), 0, "delegation suppresses the nudge: {events:?}");

        // …and short direct turns never see it.
        let sess = session(vec![
            ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" }))),
            ScriptStep::Turn(turn_text("done")),
        ]);
        let events = run_and_collect(&sess).await;
        assert_eq!(spear_notes(&events), 0);
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
