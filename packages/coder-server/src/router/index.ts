// Dispatcher — looks at the input and picks the cheapest way to answer:
//   a deterministic operation (0 model tokens), a `/`-command, or the model.
// Model turns start on the cheapest capable tier and escalate only on a real
// verify failure. See docs/PLAN.md.
import { basename, join } from "node:path";
import type { Classification, Tier } from "coder-core";
import { gitState, type GitState } from "../operations/git-state.ts";
import { HostCommandRunner } from "../sandbox/index.ts";

export interface RouteDecision {
  classification: Classification;
  /** Set when classification === "operation": the op to run with zero model tokens. */
  operation?: string;
  /** Set when classification === "command": the `/`-command name. */
  command?: string;
  /** Set when classification === "free-text": the cheapest tier to start at. */
  tier?: Tier;
}

export interface DispatcherDeps {
  /** Names of registered operations, used to match deterministic intents. */
  operationNames: Set<string>;
  /** Whether a free-text intent maps deterministically to an operation. */
  matchOperation(text: string): string | undefined;
}

export function classify(input: string, deps: DispatcherDeps): RouteDecision {
  const trimmed = input.trim();

  if (trimmed.startsWith("/")) {
    return { classification: "command", command: trimmed.slice(1).split(/\s+/)[0] };
  }

  const op = deps.matchOperation(trimmed);
  if (op && deps.operationNames.has(op)) {
    return { classification: "operation", operation: op };
  }

  // Free-text → cheapest tier by default; escalation happens downstream.
  return { classification: "free-text", tier: "cheap" };
}

/**
 * Tier bump on a real verify failure (tests/typecheck failed). A verbosity spike is
 * *not* an escalation trigger — it's only flagged as an uncertainty signal and fed to
 * the Distiller, so we never pay a pricier tier on a noisy proxy. See docs/PLAN.md.
 */
export function escalate(current: Tier): Tier {
  const order: Tier[] = ["cheap", "fast", "mid", "deep"];
  const i = order.indexOf(current);
  return order[Math.min(i + 1, order.length - 1)];
}

// ── Executable dispatch — the zero-token slash-command path ───────────────────
// `recognizeIntent` maps an **explicit** slash command to an op; `dispatch` runs it
// with no model call. We deliberately do NOT guess intent from free-text prose — that
// removes the model's judgment on a hunch and rarely matches real requests. Only a
// command the user typed on purpose (`/git-state`, `/read <file>`) takes the cheap path;
// everything else goes to the model. `dispatch` still escalates when it can't answer
// confidently (ambiguous/missing file, non-git repo).

export interface Intent {
  kind: "git_state" | "read_file";
  /** read_file: the requested filename token (e.g. "readme", "package.json"). */
  arg?: string;
}

/** Map an explicit slash command to an intent. null = let the model handle the input. */
export function recognizeIntent(input: string): Intent | null {
  const raw = input.trim();
  if (!raw.startsWith("/")) return null; // only deliberate slash commands dispatch
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "git-state":
    case "status":
      return { kind: "git_state" };
    case "read":
      return arg ? { kind: "read_file", arg } : null;
    default:
      return null; // unknown command → fall through to the model
  }
}

export interface DispatchContext {
  worktreeRoot: string;
}

export type DispatchResult = { answer: string } | { escalate: true };

/** Run the recognized intent deterministically (no model). Returns `{escalate}` when the
 *  cheap path can't answer confidently (e.g. an ambiguous or missing file, non-git repo). */
export async function dispatch(intent: Intent, ctx: DispatchContext): Promise<DispatchResult> {
  if (intent.kind === "git_state") {
    try {
      return { answer: renderGitState(await gitState.run!({}, ctx)) };
    } catch {
      return { escalate: true }; // not a git repo / git error — let the model figure it out
    }
  }

  const file = await resolveOneFile(ctx.worktreeRoot, intent.arg ?? "");
  if (!file) return { escalate: true }; // 0 or >1 candidates — ambiguous, defer to the model
  try {
    const text = await Bun.file(join(ctx.worktreeRoot, file)).text();
    const clipped = text.length > 100_000 ? `${text.slice(0, 100_000)}\n… [truncated]` : text;
    return { answer: `${file}:\n\n${clipped || "(empty file)"}` };
  } catch {
    return { escalate: true };
  }
}

function renderGitState(s: GitState): string {
  const tracking = s.upstream
    ? ` (tracking ${s.upstream}${s.ahead ? `, ahead ${s.ahead}` : ""}${s.behind ? `, behind ${s.behind}` : ""})`
    : "";
  const head = `On branch ${s.branch}${tracking}.`;
  if (s.clean) return `${head} Working tree clean.`;
  const lines = [head];
  if (s.staged.length) lines.push(`Staged: ${s.staged.join(", ")}`);
  if (s.unstaged.length) lines.push(`Unstaged: ${s.unstaged.join(", ")}`);
  if (s.untracked.length) lines.push(`Untracked: ${s.untracked.join(", ")}`);
  return lines.join("\n");
}

/** Find the single non-ignored file the user meant, by exact path, exact basename, then
 *  basename prefix — each requiring a unique match (case-insensitive). null if ambiguous. */
async function resolveOneFile(root: string, name: string): Promise<string | null> {
  if (!name) return null;
  const want = name.toLowerCase();
  const r = await new HostCommandRunner().run(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (r.exitCode !== 0) return null;
  const files = r.stdout.split("\n").filter(Boolean);

  const exactPath = files.find((f) => f.toLowerCase() === want);
  if (exactPath) return exactPath;
  const exactBase = files.filter((f) => basename(f).toLowerCase() === want);
  if (exactBase.length === 1) return exactBase[0];
  const prefix = files.filter((f) => basename(f).toLowerCase().startsWith(want));
  return prefix.length === 1 ? prefix[0] : null;
}
