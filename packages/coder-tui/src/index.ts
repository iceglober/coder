// coder-tui — the `coder` command. `bin/coder` calls `main()`.
//
//   coder                  interactive chat, in-process (the default)
//   coder --once "<task>"  run one task and exit, in-process
//   coder --serve          host an agent server (HTTP/SSE) for remote/isolated use
//   coder --connect <url>  attach to a running server (chat, or with --once)
//
// In-process is the default: the agent runs in this process and talks straight to the
// terminal — no server, no port. The HTTP server is the opt-in transport for when the
// agent and UI live in different processes (isolated container, remote, multi-client).
import { join } from "node:path";
import { ensureCatalog, Ledger, type LedgerRollup, listModels, lookupModel, refreshProjectFacts, renderFacts, runOnce, startServer } from "coder-server";
import type { Posture, Provider, SandboxKind } from "coder-server";
import { POSTURES } from "coder-server";
import { createWorktree } from "coder-core";
import type { ServerEvent, Tier, Verdict } from "coder-core";
import { AgentClient } from "./client.ts";
import { createLineReader } from "./input.ts";
import { createTurnRenderer, renderCost } from "./render.ts";
import { readUserConfig, writeUserConfig } from "./userConfig.ts";

const VERSION = "0.0.0";

const HELP = `coder — a coding agent that computes over inferring.

USAGE
  coder                     interactive chat, in-process (current repo)
  coder --once "<task>"     run one task and exit
  coder --serve             host an agent server (HTTP/SSE)
  coder --connect <url>     attach to a running server (chat, or with --once)

OPTIONS
  --tier <cheap|fast|mid|deep>      model tier (default: mid; env CODER_TIER)
  --model <id>                      exact model id (overrides tier; env CODER_MODEL)
  --provider <vertex|anthropic|azure>  where the model runs (default: vertex; env CODER_PROVIDER)
  --sandbox <host|docker>           where shell commands run (default: host; env CODER_SANDBOX)
  --mode <auto|ask|auto-edit|plan>  permission posture (default: auto; env CODER_PERMISSION_MODE)
  --port <n>                        (with --serve) listen port (default 4123; env CODER_PORT)
  --bearer <token>                  (--serve/--connect) auth token (default dev; env CODER_BEARER)
  -h, --help                        show this help
  -v, --version                     print version

Auth — vertex (default) runs Gemini: needs GOOGLE_VERTEX_PROJECT with gcloud
application-default credentials. anthropic runs Claude: needs ANTHROPIC_API_KEY.
azure runs Azure AI Foundry's OpenAI-compatible endpoint: needs AZURE_BASE_URL +
AZURE_API_KEY (AZURE_API_VERSION optional) and an explicit --model / CODER_MODEL
(your deployment name — azure has no default model).
--mode auto (default) runs edits and shell without asking; pair with --sandbox
docker when running anything you don't fully trust.`;

const TIERS = new Set<Tier>(["cheap", "fast", "mid", "deep"]);
const PROVIDERS = new Set<Provider>(["anthropic", "vertex", "azure"]);
const SANDBOXES = new Set<SandboxKind>(["host", "docker"]);

interface RunBase {
  tier: Tier;
  modelId?: string;
  provider?: Provider;
  sandbox?: SandboxKind;
  permissionMode?: Posture;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function parseRunOpts(argv: string[]): RunBase {
  const tierArg = flagValue(argv, "--tier") ?? process.env.CODER_TIER;
  const tier: Tier = tierArg && TIERS.has(tierArg as Tier) ? (tierArg as Tier) : "mid";
  const modelId = flagValue(argv, "--model") ?? process.env.CODER_MODEL;
  const providerArg = flagValue(argv, "--provider") ?? process.env.CODER_PROVIDER;
  const provider = providerArg && PROVIDERS.has(providerArg as Provider) ? (providerArg as Provider) : undefined;
  const sandboxArg = flagValue(argv, "--sandbox") ?? process.env.CODER_SANDBOX;
  const sandbox = sandboxArg && SANDBOXES.has(sandboxArg as SandboxKind) ? (sandboxArg as SandboxKind) : undefined;
  const modeArg = flagValue(argv, "--mode") ?? process.env.CODER_PERMISSION_MODE;
  const permissionMode = modeArg && POSTURES.has(modeArg as Posture) ? (modeArg as Posture) : undefined;
  return { tier, modelId, provider, sandbox, permissionMode };
}

async function repoRoot(): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd: ["git", "rev-parse", "--show-toplevel"], stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0 && out.trim()) return out.trim();
  } catch {
    // not a git repo / git missing — fall through
  }
  return process.cwd();
}

const isYes = (s: string | null): boolean => s != null && /^y(es)?$/i.test(s.trim());

const dim = (s: string): string => `\x1b[90m${s}\x1b[39m`;

/** models.dev catalog key for our provider (where pricing/model lists are indexed). */
const catalogKey = (p?: Provider): string => (p === "anthropic" ? "anthropic" : p === "azure" ? "azure" : "google-vertex");

/** The ledger rollup, formatted for the chat's `/stats`. */
function formatStats(r: LedgerRollup): string {
  const v = r.verdicts;
  const signed = v.accepted + v.rejected + v.abandoned;
  const rate = signed ? `${Math.round((100 * v.accepted) / signed)}% accepted of ${signed} signed` : "none signed off yet";
  const mins = r.toolMs >= 60_000 ? `${(r.toolMs / 60_000).toFixed(1)}m` : `${Math.round(r.toolMs / 1000)}s`;
  const timeouts = r.timeouts > 0 ? ` · ${r.timeouts} timeout${r.timeouts > 1 ? "s" : ""}` : "";
  return dim(
    [
      `  ${r.tasks} tasks · $${r.costUsd.toFixed(4)} · ${r.opHits} op-hits · ~${r.tokensAvoided} tok avoided`,
      `  verdicts: ${v.accepted} accepted · ${v.rejected} rejected · ${v.abandoned} abandoned · ${v.unknown} unknown  (${rate})`,
      `  avg effort: ${r.avgTurns.toFixed(1)} turns · ${r.avgToolCalls.toFixed(1)} tool calls · ${mins} in tools${timeouts}`,
    ].join("\n"),
  );
}

/** Sign-off on the last result: a Verdict to record, null to dismiss, undefined if the
 *  line isn't a sign-off command. (We call it "sign-off", not "prompt" — that's the model's.) */
function parseSignoff(text: string): Verdict | null | undefined {
  switch (text.toLowerCase()) {
    case "/y":
    case "/yes":
    case "/resolved":
      return "accepted";
    case "/n":
    case "/no":
    case "/unresolved":
      return "rejected";
    case "/skip":
      return null;
    default:
      return undefined;
  }
}

// ── In-process (default) ──────────────────────────────────────────────────────

/**
 * Interactive chat, in-process. Each turn runs the agent directly: events drive the
 * renderer, the permission gate prompts y/n on the same input line, and the returned
 * conversation is kept locally so turns build on each other. Ctrl-C aborts the current
 * turn; Ctrl-D / /exit quits.
 */
async function chatLocal(root: string, base: RunBase): Promise<number> {
  const reader = createLineReader();
  const ledger = new Ledger(join(root, ".coder", "ledger.jsonl"));
  const provKey = catalogKey(base.provider);
  let modelId = base.modelId; // mutable: /model switches it for subsequent turns
  let history: Awaited<ReturnType<typeof runOnce>>["messages"];
  let pending: string | undefined; // receipt id of the last result, awaiting a sign-off
  const modelLabel = () => modelId ?? `${base.tier} tier default`;
  console.error(
    `[coder] chat — ${root}\n  model: ${modelLabel()} · type a message; /exit or Ctrl-D to quit.\n  /model · /models · /facts · /y resolved · /n not · /stats\n`,
  );
  try {
    for (;;) {
      const line = await reader.read("> ");
      if (line === null) {
        // Ctrl-C bail on an unsigned result = abandoned (behavioral). Ctrl-D / EOF = no signal.
        if (reader.endReason === "ctrl-c" && pending) {
          await ledger.recordVerdict(pending, "abandoned");
          process.stdout.write(dim("  marked abandoned\n"));
        }
        break;
      }
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") {
        // Deliberate wrap-up: offer one gentle sign-off for the last unsigned result (TTY only).
        if (pending && process.stdin.isTTY) {
          const ans = await reader.read("  sign off the last result? [y]es / [n]o / Enter to skip: ");
          if (isYes(ans)) await ledger.recordVerdict(pending, "accepted");
          else if (ans && /^n/i.test(ans.trim())) await ledger.recordVerdict(pending, "rejected");
        }
        break;
      }

      // Local rollup of the ledger — doesn't hit the model. (/status is the dispatcher's.)
      if (text === "/stats") {
        process.stdout.write(`${formatStats(await ledger.rollup())}\n`);
        continue;
      }

      // Re-detect project toolchains (regenerates .coder/facts.json). Doesn't hit the model.
      if (text === "/facts") {
        const slice = renderFacts(await refreshProjectFacts(root));
        process.stdout.write(slice ? `${slice}\n` : dim("  no toolchains detected\n"));
        continue;
      }

      // Model switcher — list / switch the active model (catalog-backed, persisted).
      if (text === "/models") {
        await ensureCatalog();
        const list = listModels(provKey);
        if (!list.length) process.stdout.write(dim("  catalog unavailable (offline?) — switch anyway with /model <id>\n"));
        else {
          const rows = list.slice(0, 25).map((m) => {
            const price = m.cost ? `$${m.cost.input}/$${m.cost.output} per 1M` : "";
            return dim(`  ${m.id === modelId ? "●" : " "} ${m.id.padEnd(34)} ${price}`);
          });
          const more = list.length > 25 ? ` (showing 25 of ${list.length})` : "";
          process.stdout.write(`${rows.join("\n")}\n${dim(`  switch with /model <id>${more}`)}\n`);
        }
        continue;
      }
      if (text === "/model" || text.startsWith("/model ")) {
        const id = text.slice(6).trim();
        if (!id) {
          process.stdout.write(dim(`  current model: ${modelLabel()}\n`));
          continue;
        }
        modelId = id;
        await writeUserConfig({ model: id });
        await ensureCatalog();
        const info = lookupModel(provKey, id);
        const price = info?.cost ? `$${info.cost.input}/$${info.cost.output} per 1M` : "not in catalog — pricing falls back";
        process.stdout.write(dim(`  → ${id} (${price}) · saved\n`));
        continue;
      }

      // Sign-off on the previous result (the borrowed human verdict). Doesn't hit the model.
      const signoff = parseSignoff(text);
      if (signoff !== undefined) {
        if (!pending) process.stdout.write(dim("  nothing to sign off yet\n"));
        else if (signoff === null) pending = undefined; // /skip — dismiss, leave "unknown"
        else {
          await ledger.recordVerdict(pending, signoff);
          process.stdout.write(dim(`  recorded: ${signoff}\n`));
          pending = undefined;
        }
        continue;
      }

      const ac = new AbortController();
      const onKey = (d: Buffer | string) => {
        if (d.toString().includes("\x03")) ac.abort(); // Ctrl-C aborts the running turn
      };
      const renderer = createTurnRenderer();
      let lastCost: { costUsd: number; inputTokens: number; outputTokens: number } | undefined;

      process.stdin.on("data", onKey);
      let res: Awaited<ReturnType<typeof runOnce>>;
      try {
        res = await runOnce({
          ...base,
          modelId, // mutable via /model, overrides base
          task: text,
          root,
          history,
          signal: ac.signal,
          emit: (e) => {
            if (e.type === "cost.update") lastCost = e;
            else renderer.event(e);
          },
          requestPermission: async (tool, preview) => {
            process.stdin.off("data", onKey); // hand the input line to the reader
            renderer.finish();
            const ans = await reader.read(`  allow ${tool} — ${preview}? [y/N] `);
            process.stdin.on("data", onKey);
            return isYes(ans);
          },
        });
      } finally {
        process.stdin.off("data", onKey);
      }

      renderer.finish();
      // Prefer the receipt's final, accurate totals (includes the forced-conclusion fold +
      // cached tokens) over the last incremental cost.update.
      const r = res.receipt;
      if (r) process.stdout.write(renderCost(r.costUsd, r.inputTokens, r.outputTokens, r.cachedTokens));
      else if (lastCost) process.stdout.write(renderCost(lastCost.costUsd, lastCost.inputTokens, lastCost.outputTokens));
      process.stdout.write("\n");
      if (res.messages) history = res.messages;
      if (!res.ok && res.error && res.error !== "aborted") process.stdout.write(`[coder] ${res.error}\n`);
      // The result is now signable: /y or /n records the verdict against this receipt.
      pending = res.ok ? res.receipt?.id : undefined;
    }
  } finally {
    reader.close();
  }
  console.error("[coder] bye");
  return 0;
}

async function runOnceLocal(root: string, base: RunBase, task: string, investigate = false): Promise<number> {
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  try {
    const res = await runOnce({ task, root, ...base, investigate, signal: ac.signal });
    if (!res.ok && res.error) console.error(`\n[coder] ${res.error}`);
    return res.ok ? 0 : 1;
  } finally {
    process.off("SIGINT", onSig);
  }
}

// ── HTTP transport (--connect) ────────────────────────────────────────────────

/** Consume one turn's events from an already-open stream, rendering as they arrive. */
async function renderTurn(stream: AsyncGenerator<ServerEvent>, client: AgentClient, sessionId: string): Promise<boolean> {
  const renderer = createTurnRenderer();
  let lastCost: { costUsd: number; inputTokens: number; outputTokens: number } | undefined;
  let ok = true;
  for (;;) {
    const { value: event, done } = await stream.next();
    if (done) break;
    if (event.type === "permission.required") {
      process.stdout.write(`\n[auto-approve] ${event.tool}: ${event.preview}\n`);
      await client.decide(sessionId, event.permissionId, true);
      continue;
    }
    if (event.type === "cost.update") {
      lastCost = event;
      continue;
    }
    renderer.event(event);
    if (event.type === "turn.error") ok = false;
    if (event.type === "turn.idle" || event.type === "turn.error") break;
  }
  renderer.finish();
  if (lastCost) process.stdout.write(renderCost(lastCost.costUsd, lastCost.inputTokens, lastCost.outputTokens));
  return ok;
}

async function connect(baseUrl: string, bearer: string): Promise<{ client: AgentClient; sessionId: string } | null> {
  const client = new AgentClient(baseUrl, bearer);
  try {
    return { client, sessionId: await client.createSession() };
  } catch (err) {
    console.error(`[coder] cannot reach server at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** One-shot over a server (--once --connect): send the task, render one turn. */
async function runViaServer(baseUrl: string, bearer: string, task: string): Promise<number> {
  const conn = await connect(baseUrl, bearer);
  if (!conn) return 1;
  const stream = conn.client.events(conn.sessionId);
  await conn.client.sendMessage(conn.sessionId, task);
  const ok = await renderTurn(stream, conn.client, conn.sessionId);
  await stream.return(undefined);
  return ok ? 0 : 1;
}

/** Interactive chat over a server (--connect). NOTE: the server owns mode/sandbox; the
 *  client only sends messages. Approvals are auto-approved here for now (the in-process
 *  path is where interactive approvals live). */
async function chatViaServer(baseUrl: string, bearer: string): Promise<number> {
  const conn = await connect(baseUrl, bearer);
  if (!conn) return 1;
  const { client, sessionId } = conn;
  console.error(`[coder] chat — ${sessionId}\n  type a message; /exit or Ctrl-D to quit.\n`);
  const stream = client.events(sessionId);
  const reader = createLineReader();
  try {
    for (;;) {
      const line = await reader.read("> ");
      if (line === null) break;
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      await client.sendMessage(sessionId, text);
      await renderTurn(stream, client, sessionId);
      process.stdout.write("\n");
    }
  } finally {
    reader.close();
    await stream.return(undefined);
  }
  console.error("[coder] bye");
  return 0;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(VERSION);
    return;
  }

  const bearer = flagValue(argv, "--bearer") ?? process.env.CODER_BEARER ?? "dev";

  // Host an agent server (Bun.serve keeps the process alive after main returns).
  if (argv.includes("--serve")) {
    const port = Number(flagValue(argv, "--port") ?? process.env.CODER_PORT ?? 4123);
    const root = await repoRoot();
    startServer({ port, bearer, worktreeRoot: root });
    console.error(`[coder] server on :${port} — worktree ${root}`);
    return;
  }

  const onceIdx = argv.indexOf("--once");
  const task = onceIdx !== -1 ? argv[onceIdx + 1] : undefined;
  if (onceIdx !== -1 && (!task || task.startsWith("--"))) {
    console.error('[coder] --once needs a task, e.g. coder --once "add a --json flag"');
    process.exitCode = 1;
    return;
  }

  // Attach to a running server (--connect; --server <url> kept as an alias).
  const connectUrl = flagValue(argv, "--connect") ?? flagValue(argv, "--server") ?? process.env.CODER_SERVER;
  if (connectUrl) {
    console.error(`[coder] connected to ${connectUrl}\n`);
    process.exitCode = task ? await runViaServer(connectUrl, bearer, task) : await chatViaServer(connectUrl, bearer);
    return;
  }

  // In-process (default).
  const base = parseRunOpts(argv);
  if (!base.modelId) base.modelId = (await readUserConfig()).model; // persisted choice; flags/env already won
  let root = await repoRoot();
  // `--worktree`: run on a throwaway branch in an isolated git worktree (kept for review; remove when
  // done). Self-contained — no glrs. The work never touches your working tree.
  if (argv.includes("--worktree")) {
    try {
      const wt = await createWorktree(root);
      console.error(`[coder] worktree ${wt.path}`);
      console.error(`[coder] branch ${wt.branch} — review it, then: git -C ${root} worktree remove ${wt.path}\n`);
      root = wt.path;
    } catch (err) {
      console.error(`[coder] --worktree failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (task) {
    process.exitCode = await runOnceLocal(root, base, task, argv.includes("--investigate"));
    return;
  }
  // Interactive chat: the full-screen Ink TUI by default; `--classic` keeps the line-based client.
  if (argv.includes("--classic")) {
    process.exitCode = await chatLocal(root, base);
    return;
  }
  const { runInkChat } = await import("./app.tsx");
  await runInkChat({ root, modelId: base.modelId, provider: base.provider, permissionMode: base.permissionMode });
}
