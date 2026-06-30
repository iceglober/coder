// Permission policy — decides allow / ask / deny for each tool call. Replaces the old
// hardcoded gate. Balanced, full-auto by default (the agent acts without asking); a
// posture preset or per-tool override tightens it, and config files + bash command
// patterns layer on later (see docs/PLAN.md + TODOS). The protocol's PermissionMode
// (auto | ask | deny) is the per-decision outcome.
import type { PermissionMode } from "coder-core";
import { TOOL_EFFECTS } from "../agent/tools.ts";

/** Posture preset — the baseline before per-tool/config overrides. */
export type Posture = "auto" | "ask" | "auto-edit" | "plan";

export const POSTURES: ReadonlySet<Posture> = new Set(["auto", "ask", "auto-edit", "plan"]);

export interface PermissionConfig {
  /** Baseline posture. */
  mode?: Posture;
  /** Per-tool overrides (tool name → mode) — win over the posture. */
  tools?: Record<string, PermissionMode>;
}

/** Posture → default mode per effect. `verify` (running the project's checks) is diagnosis, not
 *  mutation — so it's allowed even in `plan` (read-only). `bash` is arbitrary execution, gated
 *  separately from the structured `write` tools and most guarded. */
function postureModes(mode: Posture): Record<"read" | "verify" | "write" | "bash", PermissionMode> {
  switch (mode) {
    case "ask":
      return { read: "auto", verify: "ask", write: "ask", bash: "ask" };
    case "auto-edit":
      return { read: "auto", verify: "auto", write: "auto", bash: "ask" };
    case "plan":
      return { read: "auto", verify: "auto", write: "deny", bash: "deny" };
    default: // "auto"
      return { read: "auto", verify: "auto", write: "auto", bash: "auto" };
  }
}

/** Resolve the posture from CODER_PERMISSION_MODE; default full-auto. */
export function resolvePosture(value = process.env.CODER_PERMISSION_MODE): Posture {
  return value && POSTURES.has(value as Posture) ? (value as Posture) : "auto";
}

/**
 * Decides allow / ask / deny per tool call. Built-in tool classes now; config (per-tool
 * overrides) supported; bash command-pattern matching and config files land in later steps.
 */
export class PermissionPolicy {
  private readonly modes: ReturnType<typeof postureModes>;

  constructor(private readonly config: PermissionConfig = {}) {
    this.modes = postureModes(config.mode ?? "auto");
  }

  /** `_input` is the tool's arguments — used by bash command patterns in a later step. */
  decide(tool: string, _input?: unknown): PermissionMode {
    const override = this.config.tools?.[tool];
    if (override) return override;
    if (tool === "bash" || tool === "run_code") return this.modes.bash; // arbitrary execution — gated on its own
    // `remember`/`declare_command` write .coder/ metadata (patterns + runnable commands), not user
    // source. Keep them frictionless (never prompt) — but still denied in plan/read-only.
    if (tool === "remember" || tool === "declare_command") return this.modes.write === "deny" ? "deny" : "auto";
    const effect = TOOL_EFFECTS[tool];
    if (effect === "write") return this.modes.write;
    if (effect === "verify") return this.modes.verify;
    if (effect === "read") return this.modes.read;
    return "auto"; // deterministic operation tools / unknown — allow
  }
}
