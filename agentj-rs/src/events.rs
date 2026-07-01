//! Events the agent loop emits to the UI. Port of `events.ts` (AgentEvent).

#[derive(Debug, Clone)]
#[allow(dead_code)] // `id`/`ok` are part of the event protocol; not every consumer reads them yet.
pub enum AgentEvent {
    /// A chunk of assistant text (one per model step).
    Message(String),
    /// A tool call started.
    ToolStart { id: u64, name: String, args: String },
    /// A tool call finished.
    ToolEnd {
        id: u64,
        ok: bool,
        elapsed_ms: u128,
        summary: String,
    },
    /// A subagent (delegate sub-task) started. `id` is its 0-based index in the batch.
    SubagentStart { id: usize, desc: String },
    /// A subagent made progress — its current tool call or the latest message snippet.
    SubagentProgress { id: usize, status: String },
    /// A subagent finished. `ok` is false when it errored or its task panicked.
    SubagentEnd {
        id: usize,
        ok: bool,
        summary: String,
        elapsed_ms: u64,
    },
    /// A supervisor/lifecycle note (auto-continue, hit the cap, …).
    Note(String),
    /// A hard error ended the turn.
    Error(String),
    /// The turn finished (natural completion or clean stop).
    Done,
}
