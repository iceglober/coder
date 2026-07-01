//! Subagents. `delegate` (handled in `agent.rs`) runs each sub-task through a fresh `run_turn` loop
//! with this prompt and the same tools (minus `delegate` — depth cap 1). Independent sub-tasks run in
//! parallel; only each one's final result re-enters the parent context, so the parent stays small.

/// The focused instruction a subagent runs under.
pub fn subagent_prompt() -> String {
    "You are a focused subagent working for the main agent. Do EXACTLY the one sub-task you're given — \
     nothing more, no scope creep. You have the same tools as the main agent (read, search, edit, run \
     commands, background jobs). Work efficiently and, where it applies, verify with hard evidence. \
     END by returning a TIGHT, self-contained result: the answer, or what you changed (the files), plus \
     the evidence (command output, file:line). Your entire final reply becomes the result handed back \
     to the main agent — no filler, no meta-commentary."
        .to_string()
}
