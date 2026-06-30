// Runner — the entry into real work. Owns the agent loop on the Vercel AI SDK (streamText
// drives the multi-step tool cycle) and writes one Ledger receipt per task. It reports
// progress as protocol `ServerEvent`s through an `emit` callback: the headless CLI passes
// none and gets the terminal rendering inline; the SSE server passes one and streams the
// same events to a connected client. Single source of truth, many renderers.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { generateObject, generateText, type LanguageModel, type ModelMessage, stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { z } from "zod";
import type { Effect, Receipt, ServerEvent, Tier } from "coder-core";
import { costOf, preflight, resolveModel, resolveProvider, type Provider } from "./agent/models.ts";
import { connectOne, connectServers } from "./mcp/client.ts";
import { loadMcpServers } from "./mcp/config.ts";
import { loginToServer } from "./mcp/oauth.ts";
import { mcpEffects, mcpToolSet } from "./mcp/tools.ts";
import { DockerSandbox } from "./sandbox/docker.ts";

export type { Provider } from "./agent/models.ts";

/** Where shell commands run: directly on the host, or inside a per-worktree container. */
export type SandboxKind = "host" | "docker";

/** Resolve the sandbox from `CODER_SANDBOX`; default host (no isolation, v1). */
export function resolveSandbox(value = process.env.CODER_SANDBOX): SandboxKind {
  return value === "docker" ? "docker" : "host";
}
import { CHARTER, INVESTIGATOR } from "./agent/prompt.ts";
import { COMMAND_TOOLS, createGate, makeTools, toolsForRole } from "./agent/tools.ts";
import { ensureCatalog } from "./catalog/index.ts";
import { compactHistory } from "./context/compact.ts";
import { detectProjectFacts, renderFacts, renderPatterns } from "./project/facts.ts";
import { Ledger } from "./ledger/index.ts";
import { builtinRegistry } from "./operations/builtins.ts";
import { operationToolSet, RunSignals } from "./operations/index.ts";
import { PermissionPolicy, type Posture, resolvePosture } from "./permission/index.ts";
import { dispatch, type Intent, recognizeIntent } from "./router/index.ts";
import { OUTPUT_CONTRACT } from "./succinctness/index.ts";

export interface RunOnceOptions {
  task: string;
  root: string;
  tier?: Tier;
  modelId?: string;
  /** Where the model runs (vertex, anthropic-direct, or azure); default CODER_PROVIDER. */
  provider?: Provider;
  /** Where shell commands run (host or docker); default CODER_SANDBOX. */
  sandbox?: SandboxKind;
  /** Container image for the docker sandbox; default CODER_SANDBOX_IMAGE. */
  sandboxImage?: string;
  /** Injected model for tests; bypasses API-key/provider resolution. */
  model?: LanguageModel;
  signal?: AbortSignal;
  /** Session id stamped on emitted events. Defaults to "once" (the CLI path). */
  sessionId?: string;
  /** Receives progress events. When provided, the runner stays silent on stdout (the
   *  caller renders); when omitted, the runner renders to the terminal itself. */
  emit?: (event: ServerEvent) => void;
  /** Approval gate for mutating tools (write/edit/bash). When omitted, they auto-run
   *  (the headless default — there's no client to ask). */
  requestPermission?: (tool: string, preview: string) => Promise<boolean>;
  /** Ask whether to authorize an MCP server that needs OAuth, mid-run. Returning true runs the
   *  browser flow in-session and makes the server's tools available this turn. Interactive callers
   *  (TUI / classic) provide it; headless/server runs omit it and just warn. */
  confirmMcpAuth?: (server: string) => Promise<boolean>;
  /** Prior conversation, so the model has context across turns. Empty/absent = fresh. */
  history?: ModelMessage[];
  /** A command's process group started (pgid) or ended (null) — for per-session resource monitoring. */
  onCommand?: (pgid: number | null) => void;
  /** Permission posture (auto | ask | auto-edit | plan); default CODER_PERMISSION_MODE. */
  permissionMode?: Posture;
  /** Override the base system role (default CHARTER). Used to run a focused subagent
   *  in its own isolated context. */
  system?: string;
  /** Run as the read-only investigator subagent: INVESTIGATOR role + a read+verify toolset (no
   *  write tools — it can run checks but not edit). Produces a diagnosis/verdict; its exploration
   *  stays in its own context. */
  investigate?: boolean;
}

export interface RunOnceResult {
  ok: boolean;
  finishReason?: string;
  receipt?: Receipt;
  error?: string;
  /** Full conversation after this turn (prior history + this user turn + the response).
   *  The caller persists it on the session to give the next turn context. */
  messages?: ModelMessage[];
  /** True when the turn hit the step limit and concluded with a resumable progress note (not a
   *  finished answer). The orchestrator uses it to CONTINUE rather than "apply the diagnosis". */
  cutOff?: boolean;
  /** Files the edit tools changed this turn — surfaced so the user always knows what was modified. */
  changedFiles?: string[];
  /** True when the turn produced a RESOLUTION worth a human sign-off — it changed files, or did real
   *  work and didn't end by asking the user a question. A greeting / clarifying question is not. */
  signoffWorthy?: boolean;
  /** Token budget snapshot for the context meter: `prime` = estimated tokens of the PERSISTENT
   *  (main-agent) context that threads to the next turn; `subagent` = tokens consumed by the
   *  isolated sub-runs THIS turn (ephemeral — they don't persist). */
  usage?: { prime: number; subagent: number };
  /** The turn ended by posing structured clarification questions (ask_user) — surfaced via the
   *  `questions.required` event. The orchestrator stops here; it's never a sign-off resolution. */
  askedUser?: boolean;
}

// The Vertex Gemini-3 provider logs a verbose thoughtSignature warning (with a stack trace)
// on every multi-step tool replay. It injects a documented sentinel so the request still
// succeeds, so the warning is noise — silence it by default (CODER_SDK_WARNINGS=1 to see it).
if (process.env.CODER_SDK_WARNINGS !== "1") {
  (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
}

const MAX_STEPS = Number(process.env.CODER_MAX_STEPS) || 40;
// When a run hits the step ceiling, auto-continue from its progress note within the same turn this
// many times before handing back to the user — so a big task (e.g. fix a PR's conflicts + checks)
// finishes on its own instead of stalling at "try again". 0 disables (CODER_MAX_CONTINUATIONS).
const MAX_CONTINUATIONS = Number(process.env.CODER_MAX_CONTINUATIONS ?? 3);
// At the step limit, don't demand a final verdict (which invites "I was stopped, I have nothing").
// Ask for a RESUMABLE PROGRESS NOTE — it becomes the working memory the next turn (or the
// implementer) continues from, and the "don't repeat" line discourages re-thrashing what was tried.
const PROGRESS_NUDGE =
  "You've hit the step limit — stop calling tools and write a RESUMABLE PROGRESS NOTE so the next session continues exactly here. This is NOT a final verdict; do NOT apologize for stopping. Use these headers:\n" +
  "- Changed: every file you have ALREADY modified this turn (so nothing you did is hidden) — or 'nothing'.\n" +
  "- Established: what you have CONFIRMED (facts with file:line), tagged checked.\n" +
  "- Tried: what you ran or read and what it showed — so the next session does not repeat it.\n" +
  "- Hypothesis: your current best explanation, tagged reasoned/guess.\n" +
  "- Next step: the single most useful thing to do next.\n" +
  "Do not call any tools.";
const PLAN_MODE_NOTE =
  "READ-ONLY MODE: write_file, edit_file, and bash are disabled and WILL be denied — do not attempt them. You CAN still run the project's checks with the `script` tool (test/typecheck/lint) to reproduce and diagnose. Deliver a diagnosis: the cause with file:line, and the exact change you would make, stated clearly as not yet applied.";
// History compaction thresholds. Short sessions never trip this; a long one gets its older
// turns summarized so the prompt stays bounded (accuracy + cost). See context/compact.ts.
const HISTORY_COMPACT_TOKENS = Number(process.env.CODER_HISTORY_COMPACT_TOKENS) || 16000;
const HISTORY_KEEP_RECENT = Number(process.env.CODER_HISTORY_KEEP_RECENT) || 6;

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce a token count to a usable number — Gemini sometimes returns NaN or undefined,
 *  which `?? 0` doesn't catch and which poisons cost (NaN, and NaN→null over JSON). */
function num(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function previewArgs(args: unknown): string {
  const s = (() => {
    try {
      return JSON.stringify(args) ?? "";
    } catch {
      return "";
    }
  })();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A terse outcome for the inline tool status, derived from the tool's result string. */
function terseStatus(result: unknown): string {
  const s = typeof result === "string" ? result : "";
  if (s.startsWith("permission denied")) return "denied";
  if (s.startsWith("error")) return "error";
  if (s.includes("not found")) return "not found";
  if (s.startsWith("no matches")) return "no matches";
  const exit = s.match(/\[exit (\d+)\]/);
  if (exit) return exit[1] === "0" ? "ok" : `exit ${exit[1]}`;
  const tests = s.match(/(\d+) passed, (\d+) failed/);
  if (tests) return tests[2] === "0" ? `${tests[1]} pass` : `${tests[2]} fail`;
  return "ok";
}

export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const tier: Tier = opts.tier ?? "mid";

  await mkdir(join(opts.root, ".coder"), { recursive: true });
  const ledger = new Ledger(join(opts.root, ".coder", "ledger.jsonl"));

  // Zero-token dispatch: explicit slash commands (/git-state, /read <file>) are answered
  // deterministically — no model, no creds, no sandbox. All other input goes to the model.
  const intent = recognizeIntent(opts.task);
  if (intent) {
    const routed = await dispatch(intent, { worktreeRoot: opts.root });
    if ("answer" in routed) return finishDispatched(routed.answer, intent, opts, ledger, tier);
  }

  let model: LanguageModel;
  let modelId: string;
  let provider: Provider | undefined;
  if (opts.model) {
    model = opts.model;
    modelId = opts.modelId ?? "mock";
  } else {
    provider = opts.provider ?? resolveProvider();
    const credError = preflight(provider, opts.modelId);
    if (credError) {
      opts.emit?.({ type: "turn.error", sessionId: opts.sessionId ?? "once", message: credError });
      return { ok: false, error: credError };
    }
    const resolved = resolveModel({ tier, modelId: opts.modelId, provider });
    model = resolved.model;
    modelId = resolved.modelId;
  }

  // Per-worktree container: only shell exec is isolated; file tools act on the bind mount.
  let sandbox: DockerSandbox | undefined;
  if ((opts.sandbox ?? resolveSandbox()) === "docker") {
    sandbox = new DockerSandbox({
      worktreeRoot: opts.root,
      image: opts.sandboxImage ?? process.env.CODER_SANDBOX_IMAGE,
      user: process.env.CODER_SANDBOX_USER, // opt-in non-root
      network: process.env.CODER_SANDBOX_NETWORK, // opt-in, e.g. "none"
    });
    try {
      await sandbox.start();
    } catch (err) {
      const message = `sandbox start failed: ${asMessage(err)}`;
      opts.emit?.({ type: "turn.error", sessionId: opts.sessionId ?? "once", message });
      return { ok: false, error: message };
    }
  }

  // MCP servers (Claude Code's `.mcp.json`): connect once and expose their tools to all phases this
  // turn. (v1 reconnects each turn — connection reuse across turns is a follow-up.)
  const sid = opts.sessionId ?? "once";
  const note = (text: string): void => {
    opts.emit?.({ type: "message.delta", sessionId: sid, text });
    if (!opts.emit) process.stderr.write(`[coder] ${text.trim()}\n`);
  };
  const mcpServers = await loadMcpServers(opts.root);
  const mcp = mcpServers.length ? await connectServers(mcpServers) : undefined;
  if (mcp) {
    // A server needing OAuth: offer an in-session login (interactive callers only) so the user
    // doesn't have to quit and run `coder mcp login`. Decline / no callback → warn and skip it.
    for (const cfg of mcp.needsAuth) {
      const ok = opts.confirmMcpAuth ? await opts.confirmMcpAuth(cfg.name) : false;
      if (!ok) {
        note(`\n⚠ MCP "${cfg.name}" needs authorization — run \`coder mcp login ${cfg.name}\``);
        continue;
      }
      try {
        note(`\n🔑 authorizing ${cfg.name} — finish the login in your browser…`);
        await loginToServer(cfg.name, cfg.url, { onRedirect: (u) => note(`\n  ${u}`) });
        mcp.connections.push(await connectOne(cfg)); // reconnect now-authorized; close() covers it
        note(`\n✓ ${cfg.name} authorized`);
      } catch (err) {
        note(`\n⚠ MCP "${cfg.name}" login failed: ${asMessage(err)}`);
      }
    }
    for (const w of mcp.warnings) note(`\n⚠ ${w}`);
  }
  const mcpTools = mcp ? mcpToolSet(mcp.connections) : undefined;
  const mcpEffectMap = mcp ? mcpEffects(mcp.connections) : undefined;

  try {
    const result = withSignoff(await orchestrate({ ...opts, model, modelId, tier, provider, ledger, runner: sandbox, mcpTools, mcpEffects: mcpEffectMap }));
    // One terminal turn.idle per user turn (sub-runs no longer emit it), after any phase.end.
    if (result.ok) opts.emit?.({ type: "turn.idle", sessionId: opts.sessionId ?? "once" });
    return result;
  } finally {
    await sandbox?.stop();
    await mcp?.close();
  }
}

/** Does this conclusion END by asking the user something (a clarification / "too vague") rather than
 *  resolving the task? Used to (a) skip the sign-off prompt and (b) stop the orchestrator from
 *  running an implementer over a question. */
function endsByAsking(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  return /\?$/.test(t) || /\b(clarif|ambiguous|too vague|need more (info|information|detail)|let me know|what (kind|do you mean)|which would|could you (clarify|specify)|please (specify|clarify))/i.test(t);
}

/** Turn-start steer derived from recent sign-offs — this is what makes a rejection PAY OFF. */
function rejectionSteerFor(streak: number): string {
  if (streak <= 0) return "";
  if (streak >= 2)
    return `⚠️ The user has REJECTED your last ${streak} attempts in a row. If this turn continues that work, STOP — the same class of fix is not working, so do NOT ship another variation of it. CHANGE STRATEGY: reproduce the problem a different way, ask the user a focused structured question (ask_user), or step back and re-find the root cause. And do not claim success you cannot verify.`;
  return `⚠️ The user REJECTED your previous attempt. If this turn continues that work, do NOT repeat the same approach — find a genuinely different one, or ask. The conversation above shows what you already tried.`;
}

/** Rough token estimate (~4 chars/token) for the context meter — good enough for a budget gauge. */
function estTokens(messages: ModelMessage[] | undefined): number {
  if (!messages) return 0;
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  return Math.round(chars / 4);
}

/** Flag whether the turn is a RESOLUTION worth a human sign-off: it changed files, or it did real
 *  work (≥1 tool call) and didn't end by asking the user a question. A greeting or a clarifying
 *  question is not a resolution — prompting for a verdict there is noise. */
function withSignoff(result: RunOnceResult): RunOnceResult {
  if (!result.ok) return result;
  const changed = (result.changedFiles?.length ?? 0) > 0;
  const tools = result.receipt?.effort.toolCalls ?? 0;
  // Asking the user (structured questions) is never a resolution to sign off on.
  return { ...result, signoffWorthy: !result.askedUser && (changed || (tools > 0 && !endsByAsking(lastAssistantText(result.messages)))) };
}

/** The last assistant text in a message list (the subagent's verdict/report). */
function lastAssistantText(messages?: ModelMessage[]): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages?.[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    const t = m.content
      .filter((p) => (p as { type: string }).type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    if (t) return t;
  }
  return undefined;
}

/** Cheap classification: does this task need an investigation phase, or a direct action?
 *  Sees the recent session so a follow-up ("resolve the threads on that PR") routes to a
 *  direct action on the known entity, not a fresh codebase bug-hunt. */
async function triage(args: StreamArgs): Promise<"investigate" | "direct" | "diagnose"> {
  try {
    const recent = lastAssistantText(args.history)?.slice(0, 1200);
    const { object } = await generateObject({
      model: args.model,
      schema: z.object({ mode: z.enum(["investigate", "direct", "diagnose"]) }),
      system: "Route a coding task to a strategy. Reply with the classification only.",
      prompt: `${recent ? `Recent session (for resolving references like "that PR" / "the threads"):\n${recent}\n\n` : ""}Task: """${args.task}"""\n\n"investigate" = the user wants a CHANGE that first needs understanding existing code: a bug to FIX, or a feature whose correct location isn't obvious. "diagnose" = the user wants only to UNDERSTAND or be TOLD something, with NO code change — explain/report/find the cause of X, "why/where does X happen", an audit, or an explicit "investigate but don't modify anything". If the task asks to report/diagnose/explain and does NOT ask for a fix (or forbids changes), it is "diagnose", not "investigate". "direct" = a clearly-localized edit, a follow-up/action on something already in the session (a PR, a file just changed), a simple question answerable without deep investigation, OR an AMBIGUOUS / open-ended request ("clean up the docs", "improve X") that should be clarified or bounded before any work — never sent off to investigate-and-sweep. Classify.`,
      abortSignal: args.signal,
    });
    return object.mode;
  } catch {
    return "direct"; // never block the turn on triage (also the mock/test path)
  }
}

/**
 * Orchestrator. Triage the task: a "direct" task runs as-is; an "investigate" task gets a
 * read-only investigator subagent (its exploration stays in its own isolated context) whose
 * compact verdict then drives an implementer pass. The orchestrator keeps only the verdict +
 * report — never the subagents' raw transcripts — which is the aggressive context protection.
 */
const banner = (s: string) => process.stderr.write(`\n\x1b[1;36m▸ ${s}\x1b[0m\n`);

/**
 * Run a phase to completion. If it hits the step ceiling (cutOff), continue from its own resumable
 * progress note within the same turn — up to MAX_CONTINUATIONS — so the user doesn't have to keep
 * typing "try again". The note is the handoff (context stays small); the original task is restated.
 */
async function runToCompletion(args: StreamArgs, onTokens: (n: number) => void): Promise<RunOnceResult> {
  const sid = args.sessionId ?? "once";
  let res = await runStream(args);
  onTokens(res.receipt?.totalTokens ?? 0);
  let conts = 0;
  while (res.ok && res.cutOff && conts < MAX_CONTINUATIONS) {
    conts += 1;
    banner(`continuing past the step limit (${conts}/${MAX_CONTINUATIONS})`);
    args.emit?.({ type: "message.delta", sessionId: sid, text: `\n↻ step limit hit — continuing (${conts}/${MAX_CONTINUATIONS})\n` });
    const note = lastAssistantText(res.messages) ?? "";
    res = await runStream({
      ...args,
      task: `Continue this task from your own RESUMABLE PROGRESS NOTE below. Do NOT repeat work already done — pick up at "Next step", finish the task, and verify.\n\nPROGRESS NOTE:\n${note}\n\nORIGINAL TASK: ${args.task}`,
    });
    onTokens(res.receipt?.totalTokens ?? 0);
  }
  return res;
}

async function orchestrate(args: StreamArgs): Promise<RunOnceResult> {
  const emit = args.emit;
  const sid = args.sessionId ?? "once";
  const prior = args.history ?? []; // already-compact prior turns — carried forward for continuity
  let subagent = 0; // tokens burned by the (ephemeral) sub-runs this turn — for the context meter
  const meter = (result: RunOnceResult): RunOnceResult => ({ ...result, usage: { prime: estTokens(result.messages), subagent } });
  // Triage only on real runs; an injected model (tests) has no provider → run direct.
  const mode = args.investigate ? "investigate" : args.provider ? await triage(args) : "direct";
  if (mode === "direct") {
    // A direct action is a subagent too: run it, then keep ONLY its compact result in history —
    // never the tool transcript. phase.start/end let a client collapse its tools under one row.
    if (args.provider) banner("triage: direct — acting on it");
    emit?.({ type: "phase.start", sessionId: sid, phase: "direct", label: "working" });
    const res = await runToCompletion(args, (n) => {
      subagent += n;
    });
    emit?.({ type: "phase.end", sessionId: sid, phase: "direct", verdict: lastAssistantText(res.messages) });
    if (!res.ok) return res;
    return meter({ ...res, messages: [...prior, { role: "user", content: args.task }, { role: "assistant", content: lastAssistantText(res.messages) ?? "" }] });
  }

  banner(mode === "diagnose" ? "triage: diagnose — read-only, report only (no fix)" : "triage: investigate — read-only investigator (diagnosing, no edits)");
  // Keep args.history (the compact prior-turn verdicts/reports — the working memory) so the
  // investigator can resolve references like "that PR". Its own exploration stays isolated:
  // orchestrate returns only the compact verdict, never the subagent's raw transcript.
  // phase.start/end bracket the run so a client can collapse its tools under one verdict row.
  emit?.({ type: "phase.start", sessionId: sid, phase: "investigate", label: "investigating" });
  const inv = await runStream({ ...args, investigate: true });
  subagent += inv.receipt?.totalTokens ?? 0;
  emit?.({ type: "phase.end", sessionId: sid, phase: "investigate", verdict: lastAssistantText(inv.messages) });
  if (!inv.ok || args.investigate) return inv; // forced-investigate (--investigate) returns the verdict

  const verdict = lastAssistantText(inv.messages) ?? "";
  const posture = args.permissionMode ?? resolvePosture();
  // Stop at the diagnosis when there's nothing to implement: a DIAGNOSE-only task (the user wanted a
  // report, not a change — don't run an implementer that edits anyway), read-only/plan mode, no
  // verdict, or the investigation ended by ASKING the user to clarify (an implementer would just
  // re-ask). Surface the verdict/question as the turn's answer instead.
  if (mode === "diagnose" || posture === "plan" || !verdict || endsByAsking(verdict) || inv.askedUser) {
    return meter({ ...inv, messages: [...prior, { role: "user", content: args.task }, { role: "assistant", content: verdict || "(asked the user to clarify)" }] });
  }

  // If the investigation finished, apply its diagnosis; if it was cut off at the step limit, its
  // output is a progress note — CONTINUE from it (verify the hypothesis, finish, then fix).
  const implTask = inv.cutOff
    ? `A prior investigation ran out of step budget partway through. Below is its RESUMABLE PROGRESS NOTE — continue from it: don't repeat what it already tried, verify its hypothesis, finish the diagnosis, then apply the fix and verify.\n\nPROGRESS NOTE:\n${verdict}\n\nORIGINAL TASK: ${args.task}`
    : `A prior investigation diagnosed this task. Apply the fix it describes — re-read only the files it names, make the change, and verify if practical.\n\nDIAGNOSIS:\n${verdict}\n\nORIGINAL TASK: ${args.task}`;
  banner(inv.cutOff ? "implement: continuing the cut-off investigation" : "implement: applying the fix from the diagnosis");
  emit?.({ type: "phase.start", sessionId: sid, phase: "implement", label: inv.cutOff ? "continuing" : "implementing" });
  const impl = await runToCompletion({ ...args, task: implTask }, (n) => {
    subagent += n;
  }); // keeps args.history for continuity; auto-continues if the implementer also hits the ceiling
  emit?.({ type: "phase.end", sessionId: sid, phase: "implement", verdict: lastAssistantText(impl.messages) });
  const report = lastAssistantText(impl.messages) ?? "";
  const changed = impl.changedFiles?.length ? `\n📝 changed: ${impl.changedFiles.join(", ")}` : "";
  return meter({
    ...impl,
    messages: [...prior, { role: "user", content: args.task }, { role: "assistant", content: `${verdict}\n\n${report}${changed}`.trim() }],
  });
}

/** Emit/render a deterministic dispatch answer and record an op-hit receipt (no model). */
async function finishDispatched(
  answer: string,
  intent: Intent,
  opts: RunOnceOptions,
  ledger: Ledger,
  tier: Tier,
): Promise<RunOnceResult> {
  const sessionId = opts.sessionId ?? "once";
  if (opts.emit) {
    opts.emit({ type: "message.delta", sessionId, text: answer });
    opts.emit({ type: "cost.update", sessionId, costUsd: 0, inputTokens: 0, outputTokens: 0 });
    opts.emit({ type: "turn.idle", sessionId });
  } else {
    process.stdout.write(`${answer}\n`);
    process.stdout.write(`\n— operation:${intent.kind} · $0.0000 · opHit\n`);
  }
  const at = new Date().toISOString();
  const receipt: Receipt = {
    id: crypto.randomUUID(),
    taskClass: intent.kind,
    tier,
    finishReason: "operation",
    opHit: true,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    tokensAvoided: 0,
    effort: { turns: 0, toolCalls: 0, filesRead: 0, filesWritten: 0, repeatedCalls: 0, timeouts: 0, toolMs: 0 },
    verdict: "unknown",
    startedAt: at,
    endedAt: at,
  };
  await ledger.record(receipt);
  return { ok: true, finishReason: "operation", receipt };
}

interface StreamArgs extends RunOnceOptions {
  model: LanguageModel;
  modelId: string;
  tier: Tier;
  /** Resolved provider — selects the catalog's pricing key (undefined for mock/tests). */
  provider?: Provider;
  ledger: Ledger;
  runner?: DockerSandbox;
  /** MCP tools (already adapted) injected into every phase's tool set this turn. */
  mcpTools?: ToolSet;
  /** Effects for the MCP tools (default `write`) — feeds role filtering + permission gating. */
  mcpEffects?: Map<string, Effect>;
}

async function runStream(opts: StreamArgs): Promise<RunOnceResult> {
  const { model, modelId, tier, ledger } = opts;
  const sessionId = opts.sessionId ?? "once";
  const headless = !opts.emit;
  const emit = opts.emit ?? (() => {});
  let askedUser = false; // set if the agent posed structured clarification questions this run
  // Role is a TOOLSET, not a posture: the investigator's read-only constraint is that it has no
  // write-effect tools — decoupled from the user's permission posture (which still gates the
  // implementer/direct agent). So the investigator runs under the user's posture and CAN verify.
  const posture = opts.permissionMode ?? resolvePosture();
  const role = opts.investigate ? "investigate" : "full";
  const baseSystem = opts.investigate ? INVESTIGATOR : (opts.system ?? CHARTER);
  // Computed project facts (package manager + task commands) so the agent runs real commands,
  // not guesses (the npm-vs-pnpm class of error). Deterministic, cached per root.
  const facts = await detectProjectFacts(opts.root);
  const factsSlice = renderFacts(facts);
  // Learned project patterns — a compact pointer index (read on demand), so coder reuses what
  // exists instead of re-asking or reinventing. Injected once, kept terse.
  const patternsSlice = renderPatterns(facts);
  // A sign-off PAYS OFF: if the user just rejected, steer this turn away from repeating the rejected
  // approach (and at a streak, force a strategy change) — not just a stats counter.
  const rejectionSteer = rejectionSteerFor(ledger ? await ledger.rejectionStreak() : 0);
  const system = `${baseSystem}\n\n${OUTPUT_CONTRACT}${factsSlice ? `\n\n${factsSlice}` : ""}${patternsSlice ? `\n\n${patternsSlice}` : ""}${rejectionSteer ? `\n\n${rejectionSteer}` : ""}${posture === "plan" ? `\n\n${PLAN_MODE_NOTE}` : ""}`;
  // Load model pricing in parallel with the turn (cached after first run; never blocks if offline).
  const catalogReady = ensureCatalog();

  // Deterministic operations: git_state/find_def as tools; test_summary filters bash output.
  const ops = builtinRegistry();
  const opCtx = { worktreeRoot: opts.root };
  const signals = new RunSignals();
  const bashFilterOp = ops.filterFor("bash");
  const bashFilter = bashFilterOp?.filter ? (out: string) => bashFilterOp.filter!(out) : undefined;
  const opTools = ops.tools();
  // Effects for non-built-in tools (operations + MCP) — drives both the role filter and gating.
  const effects = new Map<string, Effect>([...opTools.map((op) => [op.spec.name, op.spec.effect] as const), ...(opts.mcpEffects ?? [])]);
  const policy = new PermissionPolicy({ mode: posture, effects });
  const allTools = {
    ...makeTools({
      root: opts.root,
      signal: opts.signal,
      runner: opts.runner,
      bashFilter,
      signals,
      decide: (tool, input) => policy.decide(tool, input),
      requestPermission: opts.requestPermission,
      onCommand: opts.onCommand,
      onAsk: (questions) => {
        askedUser = true;
        emit({ type: "questions.required", sessionId, questions });
      },
      onRemember: (p) => {
        // Visible accountability for learning: a change the user can't see is one they can't approve.
        const what = p.ref ? `→ ${p.ref}` : `= ${p.value ?? ""}`;
        const text = `\n🧠 remembered: ${p.key} ${what}`;
        emit({ type: "message.delta", sessionId, text });
        if (headless) process.stdout.write(`${text}\n`);
      },
      onDeclare: (task, command) => {
        const text = `\n📋 declared command: ${task} = ${command}`;
        emit({ type: "message.delta", sessionId, text });
        if (headless) process.stdout.write(`${text}\n`);
      },
    }),
    ...operationToolSet(opTools, opCtx),
    ...(opts.mcpTools ?? {}),
  };
  // The role is a filtered view of the registry by effect — that's the whole definition of the
  // read-only investigator (no write tools), not a separate permission mode. MCP tools default to
  // `write`, so the investigator never gets them.
  const tools = toolsForRole(allTools, role, effects);
  // Wrap each tool's execute to emit tool.start/tool.end AROUND execution, with timing — so a
  // client can show a live indicator that resolves to elapsed + status. (onStepFinish fires only
  // after the whole step, too late for a "running" indicator.) For process-spawning command tools
  // the wrapper ALSO holds the concurrency gate, and emits tool.start only AFTER acquiring it — so
  // the display reflects real (serialized) execution, not the model's parallel request.
  const commandGate = createGate(Math.max(1, Number(process.env.CODER_MAX_PARALLEL_COMMANDS) || 1));
  let callSeq = 0;
  let toolMs = 0; // wall-clock spent inside tools — the time the user waits, which tokens hide
  const liveTools = Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const inner = (t as { execute?: (a: unknown, o: unknown) => Promise<unknown> }).execute;
      if (!inner) return [name, t];
      const observed = async (args: unknown, o: unknown): Promise<unknown> => {
        const callId = `${name}-${++callSeq}`;
        emit({ type: "tool.start", sessionId, callId, tool: name, args });
        const started = Date.now();
        try {
          const result = await inner(args, o);
          const elapsedMs = Date.now() - started;
          toolMs += elapsedMs;
          const summary = terseStatus(result);
          emit({ type: "tool.end", sessionId, callId, status: "ok", result, elapsedMs, summary });
          if (headless) process.stdout.write(`· ${name}(${previewArgs(args)}) — ${fmtMs(elapsedMs)} ${summary}\n`);
          return result;
        } catch (err) {
          const elapsedMs = Date.now() - started;
          toolMs += elapsedMs;
          emit({ type: "tool.end", sessionId, callId, status: "error", elapsedMs, summary: "error" });
          if (headless) process.stdout.write(`· ${name}(${previewArgs(args)}) — ${fmtMs(elapsedMs)} error\n`);
          throw err;
        }
      };
      // Command tools: gate around the whole observed call, so start fires post-acquire (serial).
      const execute = COMMAND_TOOLS.has(name)
        ? (args: unknown, o: unknown) => commandGate(() => observed(args, o))
        : observed;
      return [name, { ...(t as object), execute }];
    }),
  ) as typeof tools;
  const startedAt = new Date().toISOString();

  // Tool results and per-step usage aren't fullStream parts in AI SDK v4 — they arrive via
  // onStepFinish. Surface them as tool.end + an incremental (cumulative) cost.update so a
  // client sees tools complete and cost tick up live.
  // Keep the prompt bounded: compact older history when a long session exceeds the budget.
  const compaction = await compactHistory(opts.history ?? [], {
    model,
    maxTokens: HISTORY_COMPACT_TOKENS,
    keepRecent: HISTORY_KEEP_RECENT,
    signal: opts.signal,
  });
  if (compaction.compacted) {
    process.stderr.write(`\n${"\x1b[90m"}[context compacted: ~${compaction.before}→${compaction.after} tok]${"\x1b[39m"}\n`);
  }
  const messages: ModelMessage[] = [...compaction.messages, { role: "user", content: opts.task }];
  let cumPrompt = 0;
  let cumCompletion = 0;
  // Effort counters (deterministic) — the always-available half of quality measurement.
  let turns = 0;
  let toolCalls = 0;
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  // Thrash signal: a tool call that exactly repeats an earlier one (same tool + args) bought no
  // new information. Counted, not intervened on — it feeds the receipt (and later the Distiller).
  const seenCalls = new Set<string>();
  let repeatedCalls = 0;
  // Non-streaming agent loop. The Vertex Gemini-3 STREAMING path mangles thoughtSignatures on
  // multi-step tool replay (it degrades or errors the thinking model). ToolLoopAgent.generate()
  // runs the same multi-step loop non-streaming, which round-trips signatures correctly. We
  // render per step via onStepFinish (the step's text + the tool calls it made), not token-by-token.
  const agent = new ToolLoopAgent({ model, instructions: system, tools: liveTools, stopWhen: stepCountIs(MAX_STEPS) });
  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate({
      messages,
      abortSignal: opts.signal,
      onStepFinish: (step) => {
        turns++; // one model call per step
        if (step.text) {
          emit({ type: "message.delta", sessionId, text: step.text });
          if (headless) process.stdout.write(`${step.text}\n`);
        }
        // tool.start/tool.end (with timing) are emitted live by the execute wrapper above; here we
        // only do the post-hoc effort accounting from the step's calls.
        for (const tc of step.toolCalls) {
          toolCalls++;
          const sig = `${tc.toolName}:${(() => {
            try {
              return JSON.stringify(tc.input);
            } catch {
              return "";
            }
          })()}`;
          if (seenCalls.has(sig)) repeatedCalls++;
          else seenCalls.add(sig);
          const path = (tc.input as { path?: string } | null)?.path;
          if (path) {
            if (tc.toolName === "write_file" || tc.toolName === "edit_file") filesWritten.add(path);
            else if (tc.toolName === "read_file") filesRead.add(path);
          }
        }
        // Vertex/Gemini sometimes omits token counts; default to 0 so cost never becomes NaN.
        cumPrompt += num(step.usage.inputTokens);
        cumCompletion += num(step.usage.outputTokens);
        emit({
          type: "cost.update",
          sessionId,
          costUsd: costOf(modelId, { promptTokens: cumPrompt, completionTokens: cumCompletion }, opts.provider),
          inputTokens: cumPrompt,
          outputTokens: cumCompletion,
        });
      },
    });
  } catch (err) {
    if (opts.signal?.aborted) {
      emit({ type: "turn.error", sessionId, message: "aborted" });
      if (headless) process.stdout.write("\n[aborted]\n");
      return { ok: false, error: "aborted" };
    }
    const msg = asMessage(err);
    emit({ type: "turn.error", sessionId, message: msg });
    if (headless) process.stdout.write(`\n[model error] ${msg}\n`);
    return { ok: false, error: msg };
  }

  if (opts.signal?.aborted) {
    emit({ type: "turn.error", sessionId, message: "aborted" });
    if (headless) process.stdout.write("\n[aborted]\n");
    return { ok: false, error: "aborted" };
  }

  let finishReason = result.finishReason;
  const prior = result.response.messages;
  let conclusionMessages: ModelMessage[] = [];
  let extraPrompt = 0;
  let extraCompletion = 0;
  let extraCached = 0;

  // If the loop hit the step ceiling mid-investigation (finishReason "tool-calls" rather
  // than "stop"), the model never got a turn to conclude — the user would see silence.
  // Force one final no-tools synthesis: a resumable progress note, so there's always an answer
  // AND the next turn can continue from it.
  let cutOff = false;
  if (finishReason === "tool-calls" && !opts.signal?.aborted) {
    cutOff = true;
    if (headless) process.stdout.write("\n\x1b[90m[step limit — writing a resumable progress note]\x1b[39m\n");
    const conclude = await generateText({
      model,
      system,
      messages: [...messages, ...prior, { role: "user", content: PROGRESS_NUDGE }],
      abortSignal: opts.signal,
    });
    if (conclude.text) {
      emit({ type: "message.delta", sessionId, text: conclude.text });
      if (headless) process.stdout.write(conclude.text);
    }
    extraPrompt = num(conclude.usage.inputTokens);
    extraCompletion = num(conclude.usage.outputTokens);
    extraCached = num(conclude.usage.inputTokenDetails?.cacheReadTokens);
    conclusionMessages = conclude.response.messages;
    finishReason = "stop";
  }

  // Deterministic accountability: ALWAYS report what was changed, even when the model's conclusion
  // forgets to (the doc-rewrite-with-silent-verdict failure). Computed from the edit tools — the
  // user signs off on the actual changes, so they must be impossible to miss.
  let changedFooter = "";
  if (filesWritten.size > 0) {
    const changed = [...filesWritten];
    changedFooter = `\n📝 changed ${changed.length} file${changed.length > 1 ? "s" : ""}: ${changed.join(", ")}`;
    emit({ type: "message.delta", sessionId, text: changedFooter });
    if (headless) process.stdout.write(`${changedFooter}\n`);
  }

  const updatedHistory = [...messages, ...prior, ...conclusionMessages];
  const rawUsage = result.usage;
  // Loop usage + the forced-conclusion call (if any), folded into one receipt.
  const baseTotal = num(rawUsage.totalTokens) || num(rawUsage.inputTokens) + num(rawUsage.outputTokens);
  const promptTokens = num(rawUsage.inputTokens) + extraPrompt;
  const compRaw = num(rawUsage.outputTokens) + extraCompletion;
  const totalTokens = baseTotal + extraPrompt + extraCompletion;
  // Recover output from total−prompt when the provider drops completionTokens (a
  // truncated/thinking-only Gemini response) so cost isn't under-counted.
  const completionTokens = compRaw || Math.max(0, totalTokens - promptTokens);
  const cachedTokens = num(rawUsage.inputTokenDetails?.cacheReadTokens) + extraCached;
  const usage = { promptTokens, completionTokens, cachedTokens };
  await catalogReady; // ensure pricing is loaded before the receipt's cost (parallel with the turn)
  const costUsd = costOf(modelId, usage, opts.provider);

  // A test run this turn is a *gate* (did we break something), not a correctness score.
  // The correctness signal is the human verdict — not captured here yet, so "unknown".
  const receipt: Receipt = {
    id: crypto.randomUUID(),
    taskClass: "free-text",
    tier,
    modelId,
    finishReason,
    opHit: false,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens,
    cachedTokens,
    costUsd,
    tokensAvoided: signals.tokensAvoided,
    effort: { turns, toolCalls, filesRead: filesRead.size, filesWritten: filesWritten.size, repeatedCalls, timeouts: signals.totalTimeouts, toolMs },
    checks: signals.lastTest ? { tests: signals.lastTest.passed ? "pass" : "fail" } : undefined,
    verdict: "unknown",
    startedAt,
    endedAt: new Date().toISOString(),
  };
  await ledger.record(receipt);

  // cost.update already streamed per step via onStepFinish. turn.idle is emitted ONCE per user turn
  // by runOnce (after any phase.end) — not here, so an orchestrated multi-phase turn closes once.

  if (headless) {
    const acc = signals.lastTest
      ? ` · tests ${signals.lastTest.passed ? "pass" : `FAIL (${signals.lastTest.failed})`}`
      : "";
    const saved = signals.tokensAvoided > 0 ? ` · ~${signals.tokensAvoided} tok avoided` : "";
    const cache = cachedTokens > 0 ? ` · ${Math.round((100 * cachedTokens) / Math.max(1, usage.promptTokens))}% cached` : " · 0% cached";
    const thrash = repeatedCalls > 0 ? ` · ${repeatedCalls} repeat${repeatedCalls > 1 ? "s" : ""}` : "";
    // Surface wall-clock + timeouts — the cost line alone calls a 10-min test-timeout run "cheap".
    const wall = toolMs > 1000 ? ` · ${fmtMs(toolMs)} in tools` : "";
    const timeouts = signals.totalTimeouts > 0 ? ` · ${signals.totalTimeouts} timeout${signals.totalTimeouts > 1 ? "s" : ""}` : "";
    process.stdout.write(
      `\n— ${modelId} · in ${usage.promptTokens} / out ${usage.completionTokens} tok · $${costUsd.toFixed(4)} · ${finishReason}${cache}${acc}${saved}${thrash}${wall}${timeouts}\n`,
    );
  }
  return { ok: true, finishReason, receipt, messages: updatedHistory, cutOff, changedFiles: filesWritten.size ? [...filesWritten] : undefined, askedUser };
}
