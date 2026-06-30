// Client <-> server protocol: the HTTP/SSE contract between the host TUI and the
// sandboxed agent server. Mirrors docs/PLAN.md and the design doc's event taxonomy.

/** HTTP routes the agent server exposes (Bun.serve). */
export const Routes = {
  health: "/health",
  createSession: "/session",
  events: (id: string) => `/session/${id}/events`,
  message: (id: string) => `/session/${id}/message`,
  permission: (id: string, pid: string) => `/session/${id}/permission/${pid}`,
  interrupt: (id: string) => `/session/${id}/interrupt`,
  session: (id: string) => `/session/${id}`,
} as const;

/** Server → client SSE events. */
export type ServerEvent =
  | { type: "message.delta"; sessionId: string; text: string }
  /** A subagent phase opened (investigate/implement) — the tools that follow belong to it, so a
   *  client can group + collapse them under one row. */
  | { type: "phase.start"; sessionId: string; phase: string; label: string }
  /** A subagent phase closed, with its verdict — the collapsed row's summary. */
  | { type: "phase.end"; sessionId: string; phase: string; verdict?: string }
  /** coder needs the user to disambiguate — posed as STRUCTURED multiple-choice (each option may
   *  carry a recommended default), never as a plain-text question. The client renders it like the
   *  sign-off prompt; the user's picks become the next turn's input. */
  | { type: "questions.required"; sessionId: string; questions: ClarifyQuestion[] }
  | { type: "tool.start"; sessionId: string; callId: string; tool: string; args: unknown }
  | { type: "tool.delta"; sessionId: string; callId: string; chunk: string }
  | {
      type: "tool.end";
      sessionId: string;
      callId: string;
      status: "ok" | "error";
      /** Structured/extracted result — never raw spilled output (PLAN R2). */
      result?: unknown;
      /** Wall-clock time the tool ran, ms — for the elapsed-time display. */
      elapsedMs?: number;
      /** Terse outcome for the inline status (e.g. "ok", "exit 1", "12 pass", "not found"). */
      summary?: string;
    }
  | {
      type: "permission.required";
      sessionId: string;
      permissionId: string;
      tool: string;
      preview: string;
    }
  | { type: "cost.update"; sessionId: string; costUsd: number; inputTokens: number; outputTokens: number }
  | { type: "context.meter"; sessionId: string; composition: ContextComposition }
  | { type: "turn.idle"; sessionId: string }
  | { type: "turn.error"; sessionId: string; message: string };

/** Client → server messages. */
export type ClientMessage =
  | { type: "user.message"; text: string }
  | { type: "permission.decision"; permissionId: string; allow: boolean }
  | { type: "interrupt" };

/** Token composition of the assembled context, surfaced by the context meter (PLAN R7/R10). */
export interface ContextComposition {
  system: number;
  tools: number;
  docs: number;
  history: number;
  files: number;
  /** output ÷ minimal-answer estimate for the current turn. */
  verbosityRatio: number;
  total: number;
}

/** A typed, renderable preview attached to a choice so the user SEES it, not just a label.
 *  Extensible — swatches are one variant; code/pseudocode, file-trees, charts, and plain multi-line
 *  text are others. The client renders each kind; unknown kinds degrade to nothing. */
export type ChoicePreview =
  | { kind: "swatches"; colors: string[] } // hex colors → colored blocks
  | { kind: "code"; text: string; lang?: string } // code / pseudocode snippet
  | { kind: "tree"; text: string } // file-structure snippet
  | { kind: "chart"; bars: { label: string; value: number }[] } // simple bar chart
  | { kind: "text"; text: string }; // multi-line descriptive preview

/** One option in a structured clarification question. */
export interface ClarifyOption {
  label: string;
  /** Optional one-line gloss on what choosing this means. */
  description?: string;
  /** The recommended choice — the client preselects it so Enter accepts it. */
  default?: boolean;
  /** Optional rich preview shown under the option (colors, code, a file tree, a chart…). */
  preview?: ChoicePreview;
}

/** A single structured question coder asks to disambiguate a vague task. */
export interface ClarifyQuestion {
  question: string;
  options: ClarifyOption[];
  /** If set, the client auto-selects the default option after this many seconds of no response and
   *  moves on — for proposals that are safe to auto-default (e.g. a facts.json command amendment). */
  timeoutSec?: number;
}

/** Permission policy per tool (reads auto-allow; writes/bash gated). */
export type PermissionMode = "auto" | "ask" | "deny";
