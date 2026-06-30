// The agent's hands: primitive tools as AI SDK `tool()` objects. v1 runs on the host,
// rooted at `root`; file tools are confined to it via safeResolve. Output is truncated
// *inside* execute so noisy results don't bloat context. Tools never throw — they return
// a string the model can act on.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ClarifyQuestion, Effect, PermissionMode } from "coder-core";
import type { FilterResult, RunSignals } from "../operations/index.ts";
import { availableTasks, cmdOf, detectProjectFacts, loadFactsFile, persistFacts, type ProjectFacts, type ProjectPattern, refreshProjectFacts, resolveCommand, templateArgs, toolchainForPath } from "../project/facts.ts";
import { HostCommandRunner, type CommandRunner } from "../sandbox/index.ts";
import { safeResolve } from "../tools/index.ts";

export interface ToolDeps {
  /** Repository root; everything is relative to it. */
  root: string;
  /** Aborts in-flight bash when the run is cancelled. */
  signal?: AbortSignal;
  /** Where UNTRUSTED code runs (test/build/scripts/bash — the repo's own code). Defaults to the
   *  host; set to a container sandbox to isolate it. */
  runner?: CommandRunner;
  /** Where TRUSTED, host-authed declared commands run (e.g. `gh pr checks` needs your host auth).
   *  Always the host — so enabling the sandbox doesn't break the forge/CI workflow. Defaults host. */
  hostRunner?: CommandRunner;
  /** Filter applied to bash output before it enters context (e.g. test-log summary). */
  bashFilter?: (output: string) => FilterResult;
  /** Sink for filter signals + tokens kept out of context; read by the runner. */
  signals?: RunSignals;
  /** Permission policy: tool + args → allow / ask / deny. Absent ⇒ allow (full-auto). */
  decide?: (tool: string, input: unknown) => PermissionMode;
  /** Asks the client to approve a tool (used when `decide` returns "ask"). Resolves
   *  true=allow, false=deny. Absent ⇒ an "ask" can't be answered, so it proceeds. */
  requestPermission?: (tool: string, preview: string) => Promise<boolean>;
  /** A command's process group started (pgid) or ended (null) — for per-session resource sampling. */
  onCommand?: (pgid: number | null) => void;
  /** coder asked the user structured clarification questions (via the ask_user tool). The runner
   *  surfaces them to the client and ends the turn — never answers them itself. */
  onAsk?: (questions: ClarifyQuestion[]) => void;
  /** coder recorded a durable project pattern (via the remember tool) — surfaced as a visible line. */
  onRemember?: (pattern: ProjectPattern) => void;
  /** coder declared a runnable project command (via declare_command) — surfaced as a visible line. */
  onDeclare?: (task: string, command: string) => void;
}

const BASH_TIMEOUT_MS = 120_000;

/** Effect of each primitive tool. A subagent role filters the toolset by this (the investigator
 *  gets read + verify, never write), and the permission policy gates by it. `script` is verify —
 *  it runs the project's own checks; `bash` is write — arbitrary execution. */
export const TOOL_EFFECTS: Record<string, Effect> = {
  read_file: "read",
  list_dir: "read",
  glob: "read",
  grep: "read",
  script: "verify",
  ask_user: "read", // poses questions; available to every role (investigator included)
  remember: "write", // records a durable project pattern; not for the read-only investigator
  declare_command: "write", // persists a runnable project command to facts.json
  run_code: "write", // runs an arbitrary program (like bash) — keeps intermediate results out of context
  write_file: "write",
  edit_file: "write",
  bash: "write",
};

/** A subagent role is exactly the set of effects it may use. The investigator is read + verify —
 *  it can observe and run checks, but has no write tools at all. */
export const ROLE_EFFECTS = {
  investigate: new Set<Effect>(["read", "verify"]),
  full: new Set<Effect>(["read", "verify", "write"]),
} as const;

/** Filter a toolset to the effects a role may use — the definition of the read-only investigator.
 *  `extraEffects` supplies effects for tools not in TOOL_EFFECTS (operation tools, keyed by name;
 *  default `read`, since operations are deterministic and mostly observational). */
export function toolsForRole(all: ToolSet, role: keyof typeof ROLE_EFFECTS, extraEffects?: Map<string, Effect>): ToolSet {
  const allow = ROLE_EFFECTS[role];
  const effectOf = (name: string): Effect => TOOL_EFFECTS[name] ?? extraEffects?.get(name) ?? "read";
  return Object.fromEntries(Object.entries(all).filter(([name]) => allow.has(effectOf(name))));
}

/** Keep head + tail of long output, dropping the middle. */
function headTail(text: string, head = 4000, tail = 2000): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} chars omitted] …\n${text.slice(-tail)}`;
}

/** Hard char cap with a trailing note. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated, ${text.length - max} more chars]`;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── run_code: the runtime + the generated preamble (the project's commands as a value-returning run()) ──

/** Which JS runtime to execute a snippet with — detected from the project, never hardcoded. A bun
 *  project runs with `bun`; any other js project with `node`; no js toolchain ⇒ run_code is off. */
function jsRuntime(facts: ProjectFacts): "bun" | "node" | undefined {
  const js = facts.toolchains.find((t) => t.name === "js");
  return js ? (js.variant === "bun" ? "bun" : "node") : undefined;
}

/** name → shell-command (declared commands as raw templates so run() can fill placeholders; plus the
 *  toolchain's test/build/lint). Declared wins over computed. */
function commandsForCode(facts: ProjectFacts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tc of facts.toolchains) for (const [task, cmd] of Object.entries(tc.commands)) out[task] = cmd;
  for (const [name, d] of Object.entries(facts.commands ?? {})) out[name] = cmdOf(d);
  return out;
}

/** Self-contained preamble prepended to the model's snippet. Defines run(name,args)/sh(cmd)/read(path)
 *  that RETURN VALUES (never print), so only the snippet's own console.log reaches context. Portable
 *  node-API JS (runs under bun OR node). `__q` mirrors shellQuote (facts.ts) — pinned by a parity test
 *  — and uses String.fromCharCode(92) for the backslash to avoid generation-time escaping. */
function buildPreamble(root: string, commands: Record<string, string>): string {
  return [
    `import { spawn } from "node:child_process";`,
    `import { readFile } from "node:fs/promises";`,
    `const __ROOT = ${JSON.stringify(root)};`,
    `const __COMMANDS = ${JSON.stringify(commands)};`,
    `const __q = (v) => v === "" ? "" : "'" + String(v).split("'").join("'" + String.fromCharCode(92) + "''") + "'";`,
    `const __fill = (t, a = {}) => t.replace(/\\{(\\w+)\\}/g, (_, n) => __q(a[n] ?? "")).replace(/\\s{2,}/g, " ").trim();`,
    `const __run = (cmd) => new Promise((res) => {`,
    `  const p = spawn("bash", ["-lc", cmd], { cwd: __ROOT });`,
    `  let stdout = "", stderr = "";`,
    `  p.stdout.on("data", (d) => { stdout += d; });`,
    `  p.stderr.on("data", (d) => { stderr += d; });`,
    `  p.on("close", (code) => res({ stdout, stderr, exitCode: code ?? 0 }));`,
    `  p.on("error", (e) => res({ stdout, stderr: String(e), exitCode: 1 }));`,
    `});`,
    `async function run(name, args = {}) {`,
    `  const t = __COMMANDS[name];`,
    `  if (!t) throw new Error("no declared command '" + name + "'. have: " + Object.keys(__COMMANDS).join(", "));`,
    `  return __run(__fill(t, args));`,
    `}`,
    `const sh = (cmd) => __run(cmd);`,
    `const read = (path) => readFile(__ROOT + "/" + path, "utf8");`,
  ].join("\n");
}

/** Tools that spawn a process tree — gated for concurrency by the runner so a model asking for
 *  several at once can't OOM the host (each test runner spawns a worker-per-core). */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(["script", "bash", "run_code"]);

/**
 * A small async gate. The AI SDK runs a step's tool calls in PARALLEL, so a model that asks for
 * several `script("test")`/`bash` at once would spawn that many process trees simultaneously —
 * each test runner spawns a worker-per-core, so a few concurrent suites can OOM the host (no
 * memory isolation on the host path). The runner caps `COMMAND_TOOLS` to `max` at a time (default
 * 1, serial) by acquiring this around their whole execution. Reads stay parallel (cheap).
 */
export function createGate(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * The repo's non-ignored files (tracked + untracked-not-ignored), so glob respects
 * .gitignore without re-implementing it. Host-side (same files the sandbox sees via the
 * bind mount). Returns null when `root` isn't a git repo, so glob can fall back to an fs walk.
 */
async function listRepoFiles(root: string): Promise<string[] | null> {
  const r = await new HostCommandRunner().run(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : null;
}

export function makeTools(deps: ToolDeps): ToolSet {
  const { root, signal } = deps;
  const runner = deps.runner ?? new HostCommandRunner(); // untrusted code (sandbox when enabled)
  const hostRunner = deps.hostRunner ?? new HostCommandRunner(); // trusted declared commands (always host)

  /** Consult the policy for a tool call: allow → proceed, deny → block, ask → prompt the
   *  client (or proceed if there's no one to ask). Returns true to proceed. */
  const allowed = async (toolName: string, input: unknown, preview: string): Promise<boolean> => {
    const mode = deps.decide?.(toolName, input) ?? "auto";
    if (mode === "deny") return false;
    if (mode === "ask" && deps.requestPermission) return deps.requestPermission(toolName, preview);
    return true;
  };

  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file (relative to repo root), returned with line numbers. Large files " +
        "are truncated to keep context small — pass offset/limit (1-based line range) to read a " +
        "specific span. Read only the part you need; grep first to find the right lines.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root"),
        offset: z.number().optional().describe("1-based first line to return (default 1)"),
        limit: z.number().optional().describe("Max lines to return (default 400, ceiling 1200)"),
      }),
      execute: async ({ path, offset, limit }) => {
        try {
          const abs = safeResolve(root, path);
          const file = Bun.file(abs);
          if (!(await file.exists())) return `file not found: ${path}`;
          const buf = new Uint8Array(await file.arrayBuffer());
          if (buf.length === 0) return "(empty file)";
          if (buf.subarray(0, 8000).includes(0)) return `[binary file, ${buf.length} bytes, not shown]`;
          const lines = new TextDecoder().decode(buf).split("\n");
          const total = lines.length;
          const start = Math.max(1, offset ?? 1);
          const span = Math.max(1, Math.min(limit ?? 400, 1200));
          const slice = lines.slice(start - 1, start - 1 + span);
          if (slice.length === 0) return `${path}: ${total} lines; offset ${start} is past the end`;
          const end = start - 1 + slice.length;
          const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
          const note = start > 1 || end < total ? `\n[lines ${start}–${end} of ${total}; pass offset/limit for more]` : "";
          return clip(numbered, 40_000) + note;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    write_file: tool({
      description: "Create or overwrite a file with the given content.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root"),
        content: z.string().describe("Full file content to write"),
      }),
      execute: async ({ path, content }) => {
        try {
          if (!(await allowed("write_file", { path, content }, `write ${path} (${content.length} bytes)`)))
            return `permission denied: write ${path}`;
          const abs = safeResolve(root, path);
          await mkdir(dirname(abs), { recursive: true });
          await Bun.write(abs, content);
          return `wrote ${content.length} bytes to ${path}`;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    edit_file: tool({
      description: "Replace an exact, unique string in a file. old_string must occur exactly once.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root"),
        old_string: z.string().describe("Exact text to replace (must be unique in the file)"),
        new_string: z.string().describe("Replacement text"),
      }),
      execute: async ({ path, old_string, new_string }) => {
        try {
          if (!(await allowed("edit_file", { path }, `edit ${path}`))) return `permission denied: edit ${path}`;
          const abs = safeResolve(root, path);
          const file = Bun.file(abs);
          if (!(await file.exists())) return `file not found: ${path}`;
          const text = await file.text();
          const count = text.split(old_string).length - 1;
          if (count === 0) return `old_string not found in ${path}`;
          if (count > 1) return `old_string is not unique in ${path} (${count} matches) — add more context`;
          await Bun.write(abs, text.replace(old_string, new_string));
          return `edited ${path}`;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    list_dir: tool({
      description: "List the entries of a directory (relative to the repo root). Directories end with /.",
      inputSchema: z.object({ path: z.string().optional().describe("Directory path; defaults to the repo root") }),
      execute: async ({ path }) => {
        try {
          const abs = safeResolve(root, path ?? ".");
          const entries = await readdir(abs, { withFileTypes: true });
          const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
          return clip(names.join("\n"), 8000) || "(empty)";
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    glob: tool({
      description:
        "Find files by glob pattern, relative to the repo root (e.g. '**/*.ts', 'src/**/README*'). " +
        "A pattern with no slash matches at any depth ('*.ts' → all .ts files; 'README*' → every " +
        "README). Respects .gitignore. Prefer this over walking the tree with list_dir to locate a " +
        "file by name.",
      inputSchema: z.object({ pattern: z.string().describe("Glob pattern, relative to the repo root") }),
      execute: async ({ pattern }) => {
        if (pattern.startsWith("/") || pattern.split("/").includes("..")) {
          return "error: pattern must stay within the repo (no leading / or '..')";
        }
        const norm = pattern.includes("/") ? pattern : `**/${pattern}`;
        try {
          const g = new Bun.Glob(norm);
          const tracked = await listRepoFiles(root);
          let hits: string[];
          if (tracked) {
            hits = tracked.filter((f) => g.match(f));
          } else {
            // Not a git repo — walk the filesystem, skipping the usual noise.
            hits = [];
            for await (const f of g.scan({ cwd: root, onlyFiles: true, dot: true })) {
              if (!f.startsWith("node_modules/") && !f.startsWith(".git/")) hits.push(f);
            }
          }
          hits.sort();
          if (hits.length === 0) return "no matches";
          const shown = hits.slice(0, 100).join("\n");
          return shown + (hits.length > 100 ? `\n… (+${hits.length - 100} more)` : "");
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    grep: tool({
      description: "Search file contents with a regex, from the repo root. Returns matching lines with line numbers.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Path to search within; defaults to the whole repo"),
      }),
      execute: async ({ pattern, path }) => {
        const where = path ?? ".";
        try {
          safeResolve(root, where); // confine the search path (reject ../ + symlink escapes)
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
        try {
          let out: string;
          let code: number;
          try {
            const r = await runner.run(
              ["rg", "--line-number", "--no-heading", "--color", "never", pattern, where],
              { cwd: root },
            );
            out = r.stdout;
            code = r.exitCode;
          } catch {
            // ripgrep not installed — fall back to git grep.
            const r = await runner.run(["git", "grep", "-n", "-E", pattern, "--", where], { cwd: root });
            out = r.stdout;
            code = r.exitCode;
          }
          if (code === 1 || out.trim() === "") return "no matches";
          const lines = out.split("\n").filter(Boolean);
          const shown = lines.slice(0, 50).join("\n");
          const more = lines.length > 50 ? `\n… (+${lines.length - 50} more matches)` : "";
          return shown + more;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    script: tool({
      description:
        "Run a named project task using the repo's detected toolchain — test, typecheck, lint, build, format, install, or any package script. The correct package manager/command is chosen for you (never guess npm vs pnpm). PREFER this over bash for these tasks. In a monorepo, a bare `test` runs EVERY package (slow + memory-heavy) — pass a `path` (the relevant package's dir, or a single test file) to scope to just what you need.",
      inputSchema: z.object({
        task: z.string().describe("Task or script name: test, typecheck, lint, build, format, install, or a custom script"),
        path: z
          .string()
          .optional()
          .describe(
            "File or dir the task applies to (defaults to repo root). A DIRECTORY scopes to that package; a single test FILE (e.g. a .test.ts) runs just that file — use it to iterate on one failing test.",
          ),
        args: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Named values for a declared task shown as `name(a, b)` — e.g. for `checks(pr)` (declared `gh pr checks {pr}`) pass {"pr": "2707"}; for `deploy(env, tag)` pass {"env": "...", "tag": "..."}. Omit for the default (e.g. current branch).',
          ),
        testName: z
          .string()
          .optional()
          .describe(
            "For `test` + a test-file `path`: run ONLY the test whose name matches (the runner's -t/-k filter) — the fastest way to iterate on ONE failing test instead of re-running the whole file. Use the exact test name from the failure output.",
          ),
      }),
      execute: async ({ task, path, args, testName }) => {
        try {
          const facts = await detectProjectFacts(root);
          const resolved = resolveCommand(facts, task, path, args, testName);
          if (!resolved) {
            const avail = availableTasks(facts, path).join(", ") || "no toolchain detected";
            return `no '${task}' command${path ? ` @ ${path}` : ""}. Available: ${avail}`;
          }
          // Detail step (two-stage dispatch): if this declared command's placeholders don't match the
          // arg names you passed, say the exact usage instead of silently dropping a wrong arg and
          // running misfilled (the `{pr}` vs `{pr_number}` class of bug).
          const declared = facts.commands?.[task];
          if (declared) {
            const expected = templateArgs(cmdOf(declared));
            const unknown = Object.keys(args ?? {}).filter((p) => !expected.includes(p));
            if (unknown.length) {
              const usage = expected.length ? `, {args: {${expected.map((e) => `"${e}": "…"`).join(", ")}}}` : "";
              return `'${task}' takes ${expected.length ? `args {${expected.join(", ")}}` : "no args"} — you passed {${Object.keys(args ?? {}).join(", ")}}. Call it as script("${task}"${usage}).`;
            }
          }
          const cmd = resolved.command;
          // Guard: if this task already timed out twice, don't burn another 120s — it doesn't finish
          // in this environment (needs setup, or a narrower scope). Refuse with evidence, don't spawn.
          if ((deps.signals?.timedOutBefore(task) ?? 0) >= 2) {
            return `not running '${task}' again — it timed out ${BASH_TIMEOUT_MS / 1000}s twice already, so it doesn't complete in this environment (it likely needs setup, e.g. a running stack, or a narrower scope like a single test file). Work from the results you have; if tests need infra, declare a setup-aware command in .coder/facts.json.`;
          }
          if (!(await allowed("script", { task, path, command: cmd }, `run: ${cmd}`))) return "permission denied: script";
          // Route by trust: a user-DECLARED command (e.g. gh, host-authed) runs on the host; a
          // toolchain command (runs the repo's code) runs in the sandbox when one is enabled.
          const execRunner = resolved.from === "declared" ? hostRunner : runner;
          const { stdout, stderr, exitCode, timedOut } = await execRunner.run(["bash", "-lc", cmd], {
            cwd: root,
            signal,
            timeoutMs: BASH_TIMEOUT_MS,
            onStart: (pgid) => deps.onCommand?.(pgid),
          });
          deps.onCommand?.(null); // command finished — stop attributing resource usage to it
          if (timedOut) deps.signals?.recordTimeout(task); // keyed on the TASK, so retries at any scope count
          const raw = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
          let display = raw;
          if (deps.bashFilter) {
            const f = deps.bashFilter(raw);
            display = f.text;
            if (f.signal) deps.signals?.record(f.signal);
            deps.signals?.avoided(raw.length - display.length);
          }
          const note = timedOut ? `\n[timed out after ${BASH_TIMEOUT_MS / 1000}s]` : "";
          // Steer by evidence (AGENTS.md heuristic #2): if a bare `test` just ran the whole
          // workspace, say so in the result — the lesson lands from what happened, not upfront text.
          const tc = toolchainForPath(facts, path);
          const wholeWorkspace = task === "test" && !path && tc?.workspace?.length ? tc.workspace.length : 0;
          const scope = wholeWorkspace
            ? `note: ran the whole workspace (${wholeWorkspace} packages) — slow + heavy. Pass a path (a package dir or a single test file) to scope next time.\n`
            : "";
          return `${scope}$ ${cmd}\n${headTail(display)}\n[exit ${exitCode}]${note}`.trim();
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    ask_user: tool({
      description:
        "Ask the user to disambiguate an underspecified task by presenting STRUCTURED multiple-choice questions — NEVER write a question as prose. Use this whenever the task can't be acted on without a guess (intent unclear, or a required input like a color palette / target / value is missing). Give each question 2–4 concrete options and mark the single RECOMMENDED one as default. Attach a `preview` so the user SEES each choice, not just a label: `swatches` for colors, `code` for snippets/pseudocode, `tree` for file layouts, `chart` for comparisons, `text` for longer descriptions. After calling this, END your turn immediately — do NOT answer the questions yourself or take any other action; the user replies with their choices next.",
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z.string().describe("The one thing you need decided, phrased plainly."),
              options: z
                .array(
                  z.object({
                    label: z.string().describe("A concise choice (1–6 words)."),
                    description: z.string().optional().describe("One line on what this choice means / its tradeoff."),
                    default: z.boolean().optional().describe("Mark the single recommended option true."),
                    preview: z
                      .discriminatedUnion("kind", [
                        z.object({ kind: z.literal("swatches"), colors: z.array(z.string()).describe("Hex colors, e.g. #1f6f5c.") }),
                        z.object({ kind: z.literal("code"), text: z.string(), lang: z.string().optional() }),
                        z.object({ kind: z.literal("tree"), text: z.string().describe("A file/dir layout snippet.") }),
                        z.object({ kind: z.literal("chart"), bars: z.array(z.object({ label: z.string(), value: z.number() })) }),
                        z.object({ kind: z.literal("text"), text: z.string() }),
                      ])
                      .optional()
                      .describe("Rich preview shown under the option."),
                  }),
                )
                .min(2)
                .max(4),
              timeoutSec: z
                .number()
                .optional()
                .describe("Auto-select the default after N seconds of no response — ONLY for proposals safe to auto-default (e.g. a facts.json command amendment), never for genuine intent forks."),
            }),
          )
          .min(1)
          .max(4)
          .describe("1–4 multiple-choice questions."),
      }),
      execute: async ({ questions }) => {
        deps.onAsk?.(questions as ClarifyQuestion[]);
        return "Questions presented to the user as a structured prompt. END your turn now — do not answer them or take any other action; the user will reply with their choices next.";
      },
    }),

    remember: tool({
      description:
        "Record a DURABLE project pattern you just learned (from the user's answer or from the code) so you never re-ask or reinvent it — a design choice, an architectural/tooling/infra pattern, a convention, a color palette. Use ONLY for facts that recur on future turns, NEVER one-off task details. PREFER `ref` (a pointer to where the truth lives in the source: 'path', 'path#symbol', or 'path:L10-L24') over a copied `value`, so the pattern stays current when the code changes and is read on demand instead of carried in context. Pass exactly one of value/ref. Stored in .coder/facts.json; re-recording the same key updates it.",
      inputSchema: z.object({
        key: z.string().describe("Short stable slug, e.g. 'color-palette', 'error-handling', 'api-routes'."),
        category: z.enum(["design", "architecture", "tooling", "infra", "convention", "other"]).optional().describe("Kind of pattern."),
        value: z.string().optional().describe("A literal durable fact. Omit when using ref."),
        ref: z.string().optional().describe("Pointer to live source ('path', 'path#symbol', 'path:L10-L24') — preferred when the truth lives in code."),
        note: z.string().optional().describe("Why/how you learned it."),
      }),
      execute: async ({ key, category, value, ref, note }) => {
        try {
          if (!value && !ref) return "error: provide either `value` (a literal fact) or `ref` (a pointer to source).";
          if (!(await allowed("remember", { key, value, ref }, `remember ${key}`))) return "permission denied: remember";
          const file = await loadFactsFile(root);
          const patterns = [...(file.patterns ?? [])];
          const fact: ProjectPattern = { key, category, value, ref, note, source: "user" };
          const i = patterns.findIndex((p) => p.key === key);
          if (i >= 0) patterns[i] = fact;
          else patterns.push(fact);
          // Persist the EXISTING computed/overrides/commands verbatim — only patterns change here.
          await persistFacts(root, file.computed ?? { toolchains: [] }, file.overrides ?? {}, file.commands ?? {}, patterns);
          await refreshProjectFacts(root); // drop the cache so the next turn re-reads this pattern
          deps.onRemember?.(fact);
          return `remembered ${key} ${ref ? `→ ${ref}` : `= ${value}`}`;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    declare_command: tool({
      description:
        "Persist HOW to run a project task into .coder/facts.json so it becomes a zero-token, reusable operation (run later via the `script` tool) — onboard like a new dev and write down what you learn. Use when the repo doesn't make a task's command obvious or it needs setup you can't infer (e.g. tests need a database stood up first: `test` → 'docker compose up -d testdb && pnpm test'). Confirm the command with the user (ask_user) before declaring it unless it's already certain. A declared command WINS over the detected one. Re-declaring a task updates it.",
      inputSchema: z.object({
        task: z.string().describe("Task name, e.g. 'test', 'test:integration', 'pr-checks', 'db:up'."),
        command: z.string().describe("The exact shell command to run for it, including any setup (e.g. 'docker compose up -d testdb && pnpm test')."),
        desc: z.string().optional().describe("One line on WHAT this command is for / when to use it (e.g. 'list a PR's CI check status') — this is how you and future runs select it by intent."),
      }),
      execute: async ({ task, command, desc }) => {
        try {
          if (!(await allowed("declare_command", { task, command }, `declare ${task}=${command}`))) return "permission denied: declare_command";
          const file = await loadFactsFile(root);
          const commands = { ...(file.commands ?? {}), [task]: desc ? { cmd: command, desc } : command };
          await persistFacts(root, file.computed ?? { toolchains: [] }, file.overrides ?? {}, commands, file.patterns ?? []);
          await refreshProjectFacts(root); // so `script(task)` resolves it this/next turn
          deps.onDeclare?.(task, command);
          return `declared ${task} = ${command} (now runnable via script("${task}"))`;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    bash: tool({
      description:
        "Run a shell command from the repo root (bash -lc). Use for builds, tests, git, etc. Output is truncated; bounded to 120s.",
      inputSchema: z.object({ command: z.string().describe("Shell command to run") }),
      execute: async ({ command }) => {
        try {
          const key = clip(command, 200); // bash has no task name — key the timeout guard on the command
          if ((deps.signals?.timedOutBefore(key) ?? 0) >= 2) {
            return `not running this command again — it timed out ${BASH_TIMEOUT_MS / 1000}s twice already, so it doesn't complete here. Work from what you have, or change the approach.`;
          }
          if (!(await allowed("bash", { command }, `bash: ${key}`))) return "permission denied: bash";
          const { stdout, stderr, exitCode, timedOut } = await runner.run(["bash", "-lc", command], {
            cwd: root,
            signal,
            timeoutMs: BASH_TIMEOUT_MS,
            onStart: (pgid) => deps.onCommand?.(pgid),
          });
          deps.onCommand?.(null);
          if (timedOut) deps.signals?.recordTimeout(key);
          const raw = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
          // Run a deterministic filter (e.g. test-log summary) before the output hits context.
          let display = raw;
          if (deps.bashFilter) {
            const f = deps.bashFilter(raw);
            display = f.text;
            if (f.signal) deps.signals?.record(f.signal);
            deps.signals?.avoided(raw.length - display.length);
          }
          const body = headTail(display);
          const note = timedOut ? `\n[timed out after ${BASH_TIMEOUT_MS / 1000}s]` : "";
          return `${body}\n[exit ${exitCode}]${note}`.trim();
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    run_code: tool({
      description:
        "Run a short program in this repo to ORCHESTRATE several commands or PROCESS large output (CI logs, test output, scans) instead of many tool calls — only what you PRINT returns, so everything the program reads or runs stays OUT of your context. Predefined helpers (they return values, never print): `run(name, args?)` runs a project command BY INTENT (the declared commands + test/build/lint shown in your facts slice, e.g. `await run('ci-failures',{run:'…'})`), `sh(cmd)` runs a raw shell command, `read(path)` reads a file. Plus the full JS runtime. Use top-level `await`. PRINT ONLY YOUR FINAL RESULT with console.log. Bounded to 120s. For a SINGLE command, prefer `script`/`bash`.",
      inputSchema: z.object({
        code: z.string().describe("An ESM JS snippet. `run`/`sh`/`read` are predefined; use top-level await; console.log ONLY the final result."),
      }),
      execute: async ({ code }) => {
        const key = clip(code, 200);
        let tmp: string | undefined;
        try {
          if ((deps.signals?.timedOutBefore(key) ?? 0) >= 2) {
            return `not running this snippet again — it timed out ${BASH_TIMEOUT_MS / 1000}s twice already. Work from what you have, or change the approach.`;
          }
          if (!(await allowed("run_code", { code }, `run_code: ${clip(code, 120)}`))) return "permission denied: run_code";
          const facts = await detectProjectFacts(root);
          const runtime = jsRuntime(facts);
          if (!runtime) return "run_code unavailable: no JS runtime (bun/node) detected for this project. Use bash/script instead.";
          const source = `${buildPreamble(root, commandsForCode(facts))}\n// ---- user code ----\n${code}\n`;
          tmp = join(root, ".coder", "run", `${randomUUID()}.mjs`);
          await mkdir(dirname(tmp), { recursive: true });
          await writeFile(tmp, source);
          const { stdout, stderr, exitCode, timedOut } = await runner.run([runtime, tmp], {
            cwd: root,
            signal,
            timeoutMs: BASH_TIMEOUT_MS,
            onStart: (pgid) => deps.onCommand?.(pgid),
          });
          deps.onCommand?.(null);
          if (timedOut) deps.signals?.recordTimeout(key);
          // stdout only on success (the snippet already distilled it); add stderr on failure so the model sees the stack.
          const display = exitCode === 0 ? stdout : [stdout, stderr].filter(Boolean).join("\n");
          const note = timedOut ? `\n[timed out after ${BASH_TIMEOUT_MS / 1000}s]` : "";
          return `${headTail(display.trimEnd())}\n[exit ${exitCode}]${note}`.trim();
        } catch (err) {
          return `error: ${asMessage(err)}`;
        } finally {
          if (tmp) await rm(tmp, { force: true }).catch(() => {});
        }
      },
    }),
  };
}
