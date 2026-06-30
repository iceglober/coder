// History compaction — the core context-budget move (PLAN §"Context management"): long
// sessions otherwise send an ever-growing prompt, which degrades accuracy (context rot) and
// costs more every turn. When history exceeds a budget, summarize the older turns into one
// compact note and keep the recent turns verbatim. A net token saver: the summary is far
// smaller than what it replaces.
import { type ModelMessage, generateText, type LanguageModel } from "ai";

/** Rough token estimate — no tokenizer, ~4 chars/token over the serialized content. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  return Math.ceil(chars / 4);
}

export interface CompactOptions {
  model: LanguageModel;
  /** Compact when the history estimate exceeds this many tokens. */
  maxTokens: number;
  /** Keep this many most-recent messages verbatim. */
  keepRecent: number;
  signal?: AbortSignal;
}

export interface CompactResult {
  messages: ModelMessage[];
  /** True if compaction actually ran (history was over budget). */
  compacted: boolean;
  before: number;
  after: number;
}

const asText = (m: ModelMessage): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

/**
 * If history is over budget, summarize the older portion into one note and keep the recent
 * turns verbatim. Safe to call every turn — a no-op under budget. On a summarizer error it
 * returns the input unchanged (never drops history silently).
 */
export async function compactHistory(messages: ModelMessage[], opts: CompactOptions): Promise<CompactResult> {
  const before = estimateTokens(messages);
  if (before <= opts.maxTokens || messages.length <= opts.keepRecent + 2) {
    return { messages, compacted: false, before, after: before };
  }
  const split = messages.length - opts.keepRecent;
  const older = messages.slice(0, split);
  const recent = messages.slice(split);
  const transcript = older.map((m) => `${m.role}: ${asText(m)}`).join("\n");
  try {
    const { text } = await generateText({
      model: opts.model,
      abortSignal: opts.signal,
      system:
        "You compress a coding-session transcript so it can stand in for the full text. Preserve facts, decisions, file paths, identifiers, and unresolved threads; drop chit-chat. Be terse.",
      prompt: `Summarize the earlier part of this session:\n\n${transcript}`,
    });
    const summary: ModelMessage = { role: "user", content: `[earlier in this session — compacted]\n${text}` };
    const out = [summary, ...recent];
    return { messages: out, compacted: true, before, after: estimateTokens(out) };
  } catch {
    return { messages, compacted: false, before, after: before }; // safe: keep full history
  }
}
