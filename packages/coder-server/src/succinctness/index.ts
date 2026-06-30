// Succinctness controller — manages the model's *own* output (half the token bill, and
// trained to inflate). Four defense-in-depth layers (PLAN R13); no single lever is
// reliable. Brevity is enforced structurally, never by "be brief" prompting alone (N9).
import type { Succinctness } from "coder-core";

/** Layer 1 — provider knob. Normalized setting → per-provider output controls. */
export interface ProviderOutputControls {
  /** GPT-5-style verbosity, where supported. */
  verbosity?: "low" | "medium" | "high";
  /** Reasoning effort, tuned alongside verbosity. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Claude terse-style system contract is applied via the output contract layer. */
  terseSystemContract: boolean;
}

export function providerControls(setting: Succinctness): ProviderOutputControls {
  switch (setting) {
    case "low":
      return { verbosity: "low", reasoningEffort: "low", terseSystemContract: true };
    case "high":
      return { verbosity: "high", reasoningEffort: "high", terseSystemContract: false };
    default:
      return { verbosity: "medium", reasoningEffort: "medium", terseSystemContract: true };
  }
}

/** Layer 2 — output contract. Calculated brevity that doesn't muzzle the evidence the
 *  reader needs (see the verdict standard in the charter / docs/accuracy.md). */
export const OUTPUT_CONTRACT = [
  "Lead with the conclusion; reasoning and evidence come after it, not before.",
  "Calculated brevity — the fewest words that fully resolve the task, but never drop the",
  "evidence a reader needs to verify a claim. No filler preamble or postamble.",
  "Plain language: say what actually happens; avoid vague verbs and assumption-ridden jargon.",
].join(" ");

/**
 * Layer 3 — response shaping. Strip prose boilerplate/hedging before display *and*
 * before the turn re-enters history (verbosity compounds across turns).
 * Lossless for code, diffs, and structured payloads — only prose is touched (N9).
 */
export function shapeProse(text: string): string {
  // Never alter fenced code / diffs / structured blocks.
  if (/```|^diff --git|^@@ /m.test(text)) return text;
  return text
    .replace(/^(sure|certainly|of course|great question)[!,.]?\s*/i, "")
    .replace(/\s*(let me know if you('?| wi)ll need anything else.*)$/i, "")
    .trim();
}

/**
 * Layer 4 — measure. verbosity ratio = output ÷ minimal-answer estimate. A spike is
 * flagged as an uncertainty signal and fed to the Distiller — *not* an auto-escalation,
 * so we never pay a pricier tier on a noisy proxy. Computed with no model call; emitted
 * as the OTel metric `gen.output.verbosity`.
 */
export function verbosityRatio(outputTokens: number, minimalEstimate: number): number {
  if (minimalEstimate <= 0) return 1;
  return outputTokens / minimalEstimate;
}

/** Above this ratio, flag the turn as uncertain (a signal, not a cost trigger). */
export const VERBOSITY_SPIKE_THRESHOLD = 2.5;
