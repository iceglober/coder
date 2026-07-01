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
    /// A supervisor/lifecycle note (auto-continue, hit the cap, …).
    Note(String),
    /// A hard error ended the turn.
    Error(String),
    /// The turn finished (natural completion or clean stop).
    Done,
}
