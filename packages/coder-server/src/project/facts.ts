// Project facts — computed, polyglot toolchain detection. The agent shouldn't guess how to
// run a project's tasks (the npm-vs-pnpm class of error); we compute the exact commands from
// the repo. A repo has one or more *toolchains* (js, python, …), each detected by markers and
// each knowing its canonical task → command. Adding a language = adding one detector; the
// agent-facing surface (TaskKind, the rendered slice) stays language-agnostic.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Canonical, language-agnostic tasks — recognized names, not a closed set. */
export type TaskKind = "install" | "test" | "build" | "lint" | "typecheck" | "format" | "dev";

export interface ToolchainFacts {
  /** Ecosystem, e.g. "js" | "python". (We do NOT split web vs backend — the scripts carry that.) */
  name: string;
  /** The concrete tool, e.g. "pnpm" | "bun" | "uv". */
  variant?: string;
  /** Repo-relative subtree this governs ("." = root). */
  dir: string;
  /** Task → exact command. Open: canonical tasks AND any custom script (migrate, e2e, …). */
  commands: Record<string, string>;
  /** Monorepo packages (dir + name + its own detected test runner). When a task runs for a path
   *  inside one, the command scopes to that package; for a single test FILE, the package's runner
   *  is what makes appending the file safe (bypasses a root wrapper like turbo). */
  workspace?: { dir: string; name: string; runner?: string }[];
  /** The recognized direct test runner this scope's `test` script invokes (vitest/jest/pytest/…).
   *  Present ⇒ appending a single file is safe; absent ⇒ the script is a wrapper (turbo/make) or
   *  unknown, so single-file scoping falls back to the whole task. The cached "variant". */
  runner?: string;
}

/** A durable project pattern coder has learned — a design/architecture/tooling/infra/convention
 *  fact it should reuse, not re-derive or re-ask. Holds EITHER a literal `value` or a `ref` pointer
 *  to live source (preferred when the truth lives in the code, so the pattern never goes stale and
 *  the model reads it on demand instead of carrying it in context). */
export interface ProjectPattern {
  key: string;
  category?: "design" | "architecture" | "tooling" | "infra" | "convention" | "other";
  /** Literal durable fact, e.g. "docs tone: concise, second-person". */
  value?: string;
  /** Pointer to live source: "path", "path#symbol", or "path:L10-L24". Read on demand. */
  ref?: string;
  /** Why/how/when it was learned. */
  note?: string;
  source?: "user" | "inferred";
}

/** A declared command: a shell command string, OR `{cmd, desc}` where `desc` is a one-line note on
 *  what it's for. The description is what lets coder SELECT a command by intent — so the prompt never
 *  hardcodes a command name or a canonical role; the model matches its need to the description. */
export type DeclaredCommand = string | { cmd: string; desc?: string };
export const cmdOf = (d: DeclaredCommand): string => (typeof d === "string" ? d : d.cmd);
export const descOf = (d: DeclaredCommand): string | undefined => (typeof d === "string" ? undefined : d.desc);

export interface ProjectFacts {
  toolchains: ToolchainFacts[];
  /** Repo-level declared commands (any stack), from `.coder/facts.json`'s `commands`. Not computed —
   *  this is where project-specific operations (a CI-checks command, a test-DB setup) live, so coder
   *  stays forge-agnostic: universal toolchain tasks are computed; anything bespoke is DECLARED with a
   *  description and selected by intent — never enumerated as a canonical role or named in the prompt. */
  commands?: Record<string, DeclaredCommand>;
  /** Learned project patterns (human-authored or coder-recorded), preserved across re-detection. */
  patterns?: ProjectPattern[];
}

interface Detector {
  name: string;
  /** Find every instance of this toolchain in the repo and compute its facts. */
  detect(root: string, files: string[]): Promise<ToolchainFacts[]>;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: package.json is external JSON.
async function readJson(path: string): Promise<any | undefined> {
  const t = await readText(path);
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const uniqueDirs = (paths: string[]): string[] => [...new Set(paths.map((p) => dirname(p)))];

// ── JS / TS ───────────────────────────────────────────────────────────────────
// One toolchain, anchored at the root package.json. The variant is the package manager
// (the `packageManager` field wins; lockfile is the fallback). Commands come from the
// package.json scripts run via `<pm> run <script>` — so web (Next/turbo) vs backend (bun)
// is delegated to whatever the author's scripts already do.
const JS_TASK_ALIASES: Record<Exclude<TaskKind, "install">, string[]> = {
  test: ["test"],
  typecheck: ["typecheck", "type-check", "tsc", "check-types"],
  lint: ["lint"],
  build: ["build"],
  format: ["format", "fmt"],
  dev: ["dev", "start"],
};

// Recognized DIRECT test runners. If a `test` script invokes one, we know appending a single file
// as a positional is safe (every one takes a file). A script that does NOT match (turbo/nx/make/
// npm-run-all) is a wrapper — single-file scoping bypasses it via the owning package's runner, or
// falls back to the whole task. This is the parse behind the cached `runner` variant.
const TEST_RUNNERS = ["vitest", "jest", "mocha", "ava", "playwright", "jasmine", "tap", "uvu"];

/** The direct test runner a script body invokes, if recognized. */
export function detectRunner(scriptBody: string | undefined): string | undefined {
  if (!scriptBody) return undefined;
  return TEST_RUNNERS.find((r) => new RegExp(`\\b${r}\\b`).test(scriptBody));
}

function jsVariant(pkg: { packageManager?: string }, files: string[]): string {
  if (typeof pkg.packageManager === "string") return pkg.packageManager.split("@")[0];
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

const jsDetector: Detector = {
  name: "js",
  async detect(root, files) {
    const pkg = await readJson(join(root, "package.json"));
    if (!pkg) return [];
    const variant = jsVariant(pkg, files);
    const scripts: Record<string, string> = pkg.scripts ?? {};
    // Emit every script by its real name (so custom tasks like `migrate` are runnable)…
    const commands: Record<string, string> = { install: `${variant} install` };
    for (const name of Object.keys(scripts)) commands[name] = `${variant} run ${name}`;
    // …plus canonical aliases, so `typecheck` resolves even when the script is named `tsc`.
    for (const [task, names] of Object.entries(JS_TASK_ALIASES)) {
      if (commands[task]) continue;
      const hit = names.find((n) => n in scripts);
      if (hit) commands[task] = `${variant} run ${hit}`;
    }
    const workspace = await jsWorkspace(root, pkg, files);
    const runner = detectRunner(scripts.test); // root's own runner (undefined when it's a wrapper)
    return [{ name: "js", variant, dir: ".", commands, ...(workspace.length ? { workspace } : {}), ...(runner ? { runner } : {}) }];
  },
};

/** The package manager's workspace globs: package.json `workspaces` (npm/yarn/bun) or
 *  pnpm-workspace.yaml `packages:` (pnpm). Empty when the repo isn't a workspace. */
async function jsWorkspaceGlobs(root: string, pkg: { workspaces?: unknown }, files: string[]): Promise<string[]> {
  // pnpm-workspace.yaml is AUTHORITATIVE when present — pnpm ignores package.json `workspaces`, so a
  // stale npm-style field there must NOT shadow it (else a 37-package monorepo looks like 1, and every
  // test scopes to the root turbo wrapper → the whole 120s suite).
  if (files.includes("pnpm-workspace.yaml")) {
    const text = (await readText(join(root, "pnpm-workspace.yaml"))) ?? "";
    const globs: string[] = [];
    let inPackages = false;
    for (const line of text.split("\n")) {
      if (/^packages:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (!inPackages) continue;
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (m) globs.push(m[1].trim());
      else if (/^\S/.test(line)) break; // next top-level key ends the packages list
    }
    if (globs.length) return globs;
  }
  // npm / yarn / bun: the package.json `workspaces` field (array, or `{ packages: [...] }`).
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws as string[];
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    return (ws as { packages: string[] }).packages;
  }
  return [];
}

/** Resolve workspace globs to the member packages present in the repo (dir + name + test runner).
 *  The per-package runner is what handles a turbo/nx root: the file is scoped to the package whose
 *  OWN `test` script is the direct runner, bypassing the root wrapper. */
async function jsWorkspace(root: string, pkg: { workspaces?: unknown }, files: string[]): Promise<{ dir: string; name: string; runner?: string }[]> {
  const globs = await jsWorkspaceGlobs(root, pkg, files);
  if (!globs.length) return [];
  const matchers = globs.map((g) => new Bun.Glob(g.replace(/\/$/, "") + "/package.json"));
  const pkgFiles = files.filter((f) => f.endsWith("/package.json") && matchers.some((m) => m.match(f)));
  const members = await Promise.all(
    pkgFiles.map(async (f) => {
      const member = await readJson(join(root, f));
      if (!member?.name) return undefined;
      const runner = detectRunner(member.scripts?.test);
      return { dir: dirname(f), name: member.name as string, ...(runner ? { runner } : {}) };
    }),
  );
  return members.filter((m): m is { dir: string; name: string; runner?: string } => !!m);
}

/** Scope a task to a workspace package, in the package manager's own syntax. */
function scopeCommand(variant: string, name: string, task: string): string | undefined {
  switch (variant) {
    case "pnpm":
      return `pnpm --filter ${name} run ${task}`;
    case "bun":
      return `bun --filter ${name} run ${task}`;
    case "yarn":
      return `yarn workspace ${name} ${task}`;
    case "npm":
      return `npm run ${task} --workspace ${name}`;
    default:
      return undefined;
  }
}

// ── Python ─────────────────────────────────────────────────────────────────────
// Anchored wherever a pyproject/requirements lives (could be a subpackage). Variant from the
// lockfile next to it; commands only for tools actually referenced (conservative — a wrong
// command is worse than none). Bare .py files with no project file get no commands.
const PY_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"];

async function resolvePython(root: string, dir: string, files: string[]): Promise<ToolchainFacts | undefined> {
  const rel = (f: string) => (dir === "." ? f : `${dir}/${f}`);
  const text = (await readText(join(root, dir, "pyproject.toml"))) ?? (await readText(join(root, dir, "requirements.txt"))) ?? "";
  const has = (s: string) => text.includes(s);
  // The declared tool in pyproject ([tool.uv] etc.) is a stronger signal than a (often
  // gitignored) lockfile — same idea as JS's `packageManager` field.
  const variant =
    has("[tool.uv]") || files.includes(rel("uv.lock"))
      ? "uv"
      : has("[tool.poetry]") || files.includes(rel("poetry.lock"))
        ? "poetry"
        : has("[tool.pdm]") || files.includes(rel("pdm.lock"))
          ? "pdm"
          : "pip";
  const prefix = variant === "uv" ? "uv run " : variant === "poetry" ? "poetry run " : variant === "pdm" ? "pdm run " : "";
  const commands: Record<string, string> = {};
  if (variant === "uv" || variant === "poetry" || variant === "pdm") commands.install = `${variant} sync`;
  const runner = has("pytest") ? "pytest" : undefined;
  if (has("pytest")) commands.test = `${prefix}pytest`;
  if (has("mypy")) commands.typecheck = `${prefix}mypy .`;
  else if (has("pyright")) commands.typecheck = `${prefix}pyright`;
  if (has("ruff")) {
    commands.lint = `${prefix}ruff check .`;
    commands.format = `${prefix}ruff format .`;
  } else if (has("black")) commands.format = `${prefix}black .`;
  return { name: "python", variant, dir, commands, ...(runner ? { runner } : {}) };
}

const pyDetector: Detector = {
  name: "python",
  async detect(root, files) {
    const dirs = uniqueDirs(files.filter((f) => PY_MARKERS.includes(basename(f))));
    const out: ToolchainFacts[] = [];
    for (const dir of dirs) {
      const facts = await resolvePython(root, dir, files);
      if (facts) out.push(facts);
    }
    return out;
  },
};

// ── Go ────────────────────────────────────────────────────────────────────────
// One toolchain per `go.mod` (Go modules are dir-anchored). There's no script manifest — the
// commands are Go's fixed canonical set and the test runner is always `go test` (so `runner` is
// unconditional). `vet` is the always-available linter; build doubles as the typecheck.
const goDetector: Detector = {
  name: "go",
  async detect(_root, files) {
    return uniqueDirs(files.filter((f) => basename(f) === "go.mod")).map((dir) => ({
      name: "go",
      variant: "go",
      dir,
      runner: "go",
      commands: { install: "go mod download", test: "go test ./...", build: "go build ./...", lint: "go vet ./..." },
    }));
  },
};

const DETECTORS: Detector[] = [jsDetector, pyDetector, goDetector];

/** The repo's non-ignored files (gitignore-respecting), repo-relative. Empty when not a git repo. */
async function repoFiles(root: string): Promise<string[]> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Human overrides, keyed by toolchain name → task → command. Win over computed, survive
// re-detection. Edit `.coder/facts.json`'s `overrides` to pin a command coder can't compute.
type Overrides = Record<string, Record<string, string>>;
type Declared = Record<string, DeclaredCommand>;
interface FactsFile {
  computed?: ProjectFacts;
  overrides?: Overrides;
  /** Repo-level declared commands (any stack) — human-authored, preserved across re-detection. */
  commands?: Declared;
  /** Learned project patterns — human-authored or coder-recorded, preserved across re-detection. */
  patterns?: ProjectPattern[];
}

export async function loadFactsFile(root: string): Promise<FactsFile> {
  const f = await readJson(join(root, ".coder", "facts.json"));
  if (!f || typeof f !== "object") return {};
  return {
    computed: f.computed,
    overrides: typeof f.overrides === "object" ? f.overrides : {},
    commands: typeof f.commands === "object" ? f.commands : {},
    patterns: Array.isArray(f.patterns) ? f.patterns : [],
  };
}

export async function persistFacts(
  root: string,
  computed: ProjectFacts,
  overrides: Overrides,
  commands: Declared,
  patterns: ProjectPattern[] = [],
): Promise<void> {
  try {
    await mkdir(join(root, ".coder"), { recursive: true });
    await writeFile(join(root, ".coder", "facts.json"), `${JSON.stringify({ computed, overrides, commands, patterns }, null, 2)}\n`);
  } catch {
    // best-effort: never fail a run over the facts cache file
  }
}

function applyOverrides(facts: ProjectFacts, overrides: Overrides): ProjectFacts {
  return {
    toolchains: facts.toolchains.map((t) => {
      const ov = overrides[t.name];
      return ov ? { ...t, commands: { ...t.commands, ...ov } } : t;
    }),
  };
}

const cache = new Map<string, ProjectFacts>();

/**
 * Detect every toolchain in the repo (cached per root; deterministic, no model). Persists the
 * computed result to `.coder/facts.json` and merges any human `overrides` on top (overrides win).
 */
export async function detectProjectFacts(root: string): Promise<ProjectFacts> {
  const hit = cache.get(root);
  if (hit) return hit;
  const files = await repoFiles(root);
  const toolchains: ToolchainFacts[] = [];
  for (const d of DETECTORS) toolchains.push(...(await d.detect(root, files)));
  const computed: ProjectFacts = { toolchains };
  const file = await loadFactsFile(root);
  const overrides = file.overrides ?? {};
  const declared = file.commands ?? {};
  const patterns = file.patterns ?? [];
  // Only write when the computed facts actually changed — no churn / git-dirty on every run.
  // (overrides + declared commands + patterns are human-authored/recorded, preserved verbatim.)
  if (toolchains.length && JSON.stringify(file.computed) !== JSON.stringify(computed)) {
    await persistFacts(root, computed, overrides, declared, patterns);
  }
  const merged = applyOverrides(computed, overrides);
  if (Object.keys(declared).length) merged.commands = declared;
  if (patterns.length) merged.patterns = patterns;
  cache.set(root, merged);
  return merged;
}

/** Force a re-detect (drops the per-process cache) — backs the `/facts` command. */
export async function refreshProjectFacts(root: string): Promise<ProjectFacts> {
  cache.delete(root);
  return detectProjectFacts(root);
}

/** The toolchain governing `path` — the nearest-ancestor dir wins; root ("." ) if none/undefined.
 *  In a polyglot monorepo this picks python @ packages/doc-pipeline for a file there, js @ root otherwise. */
export function toolchainForPath(facts: ProjectFacts, path?: string): ToolchainFacts | undefined {
  const tcs = facts.toolchains;
  if (!tcs.length) return undefined;
  if (!path) return tcs.find((t) => t.dir === ".") ?? tcs[0];
  const norm = path.replace(/^\.?\//, "");
  const matches = tcs.filter((t) => t.dir === "." || norm === t.dir || norm.startsWith(`${t.dir}/`));
  const specificity = (t: ToolchainFacts) => (t.dir === "." ? 0 : t.dir.length);
  return matches.sort((a, b) => specificity(b) - specificity(a))[0] ?? tcs.find((t) => t.dir === ".") ?? tcs[0];
}

/** Resolve a task to its exact command for `path`: repo-level *declared* commands win (any stack —
 *  e.g. a "checks" command that queries CI), then the toolchain governing the path. Returns the
 *  command and where it came from, or undefined if nothing maps. Backs the `script` tool. */
/** Does the path point at a file (has an extension in its last segment), vs a directory? */
const isFilePath = (p: string): boolean => /[^/]\.[^/.]+$/.test(p);

/**
 * Single-file test command, using the cached `runner` variant. Precedence: a declared
 * `commands["test:file"]` template (`{file}` placeholder) wins; else the owning scope's detected
 * runner makes appending the file as a positional safe — `<pm> [--filter <pkg>] run test -- <file>`
 * for js (file made package-relative), or `<test cmd> <file>` for python. undefined ⇒ no known
 * runner (wrapper/opaque) → caller falls back to the whole task.
 */
/** The flag a runner uses to filter to a single test BY NAME — so you can iterate on one failing test
 *  in seconds instead of re-running the whole file. undefined ⇒ unknown runner, no name filter. */
function testNameFlag(runner: string): string | undefined {
  if (runner === "pytest") return "-k"; // substring match
  if (runner === "vitest" || runner === "jest") return "-t"; // --testNamePattern
  // go is handled in testFileCommand's own branch — `-run` takes an anchored regex + a package dir,
  // not the generic `<cmd> <file> <flag> <name>` shape this helper feeds.
  return undefined;
}

function testFileCommand(facts: ProjectFacts, tc: ToolchainFacts, path: string, testName?: string): { command: string; from: string } | undefined {
  const norm = path.replace(/^\.?\//, "");
  const tmplD = facts.commands?.["test:file"];
  if (tmplD) return { command: cmdOf(tmplD).replaceAll("{file}", shellQuote(norm)), from: "declared" }; // explicit template — name not appended
  if (tc.name === "js") {
    const pkg = tc.workspace
      ?.filter((p) => norm === p.dir || norm.startsWith(`${p.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    const runner = pkg?.runner ?? tc.runner;
    if (!runner || !tc.variant) return undefined; // wrapper/opaque script — fall back to whole task
    const relFile = pkg ? norm.slice(pkg.dir.length + 1) : norm; // --filter runs in the package cwd
    const filter = pkg ? `--filter ${pkg.name} ` : "";
    const flag = testName ? testNameFlag(runner) : undefined;
    const name = flag ? ` ${flag} ${shellQuote(testName as string)}` : "";
    return { command: `${tc.variant} ${filter}run test -- ${shellQuote(relFile)}${name}`, from: `${tc.name}:${runner}` };
  }
  if (tc.name === "python" && tc.runner && tc.commands.test) {
    const relFile = tc.dir === "." ? norm : norm.slice(tc.dir.length + 1);
    const flag = testName ? testNameFlag(tc.runner) : undefined;
    const name = flag ? ` ${flag} ${shellQuote(testName as string)}` : "";
    return { command: `${tc.commands.test} ${shellQuote(relFile)}${name}`, from: `${tc.name}:${tc.runner}` };
  }
  if (tc.name === "go") {
    // Go is PACKAGE-scoped, not file-scoped: run the file's package dir. The single-test filter is
    // `-run <regex>`, so anchor the name (`^Name$`) to match exactly that test.
    const pkgDir = dirname(norm);
    const target = pkgDir === "." ? "." : `./${pkgDir}`;
    const name = testName ? ` -run ${shellQuote(`^${testName}$`)}` : "";
    return { command: `go test${name} ${target}`, from: "go" };
  }
  return undefined;
}

/** Named placeholders a declared command exposes, in order — e.g. `gh pr view {pr} --repo {repo}`
 *  → ["pr", "repo"]. `path` is auto-filled (reserved), so it's not surfaced as a user-supplied arg. */
export function templateArgs(cmd: string): string[] {
  return [...new Set([...cmd.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((n) => n !== "path");
}

/** POSIX single-quote an untrusted value so it's ONE inert shell token — no metacharacter (`;`,
 *  `$()`, `|`, …) can break out of its position. Empty → "" so a missing placeholder just drops
 *  its slot (rather than leaving an empty `''` arg). This is the injection boundary: the template
 *  is user-authored (trusted); the values it interpolates are model-supplied (untrusted). */
export function shellQuote(value: string): string {
  return value === "" ? "" : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A real task/script name — never shell metacharacters. Used to reject an injected `task`. */
const TASK_NAME = /^[\w.:-]+$/;

/** Fill `{name}` placeholders in a declared command: `{path}` from the path, every other name from
 *  `args` (by name), each SHELL-QUOTED. A missing value drops the slot (`gh pr checks {pr}` with no
 *  pr → `gh pr checks`). Any number of named args: `gh pr view {pr} --repo {repo}`. */
function fillTemplate(tmpl: string, path?: string, args?: Record<string, string>): string {
  return tmpl
    .replace(/\{(\w+)\}/g, (_, name: string) => shellQuote((name === "path" ? path : args?.[name]) ?? ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function resolveCommand(facts: ProjectFacts, task: string, path?: string, args?: Record<string, string>, testName?: string): { command: string; from: string } | undefined {
  const declared = facts.commands?.[task]; // a declared key is user-authored; its values are quoted
  if (declared) return { command: fillTemplate(cmdOf(declared), path, args), from: "declared" };
  if (!TASK_NAME.test(task)) return undefined; // task is interpolated below — reject anything but a name
  const tc = toolchainForPath(facts, path);
  if (!tc) return undefined;
  // Single FILE (+ optional single TEST by name) + a test task → run just that via the cached runner
  // variant (tiny output, fast iteration). Falls through to whole-task scoping when the runner is unknown.
  if (task === "test" && path && isFilePath(path)) {
    const scoped = testFileCommand(facts, tc, path, testName);
    if (scoped) return scoped;
  }
  // Monorepo: if `path` is inside a workspace package, scope the command to it (not the whole
  // repo). `install` stays repo-wide. The package owns the script — trust it, or it errors clearly.
  if (path && tc.workspace && tc.variant && task !== "install") {
    const norm = path.replace(/^\.?\//, "");
    const pkg = tc.workspace
      .filter((p) => norm === p.dir || norm.startsWith(`${p.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    const scoped = pkg && scopeCommand(tc.variant, pkg.name, task);
    if (pkg && scoped) return { command: scoped, from: `${tc.name}:${pkg.name}` };
  }
  const cmd = tc.commands[task];
  return cmd ? { command: cmd, from: tc.name } : undefined;
}

/** Every task name runnable for `path` — declared commands + the governing toolchain's. */
export function availableTasks(facts: ProjectFacts, path?: string): string[] {
  const declared = Object.keys(facts.commands ?? {});
  const tc = toolchainForPath(facts, path);
  return [...new Set([...declared, ...(tc ? Object.keys(tc.commands) : [])])];
}

/** A compact pointer slice — the toolchains (+ any declared tasks) + "use the script tool". The
 *  actual commands live in the script tool (resolved on demand), so the prompt stays tiny even as
 *  scripts multiply. Empty if nothing detected. */
export function renderFacts(facts: ProjectFacts): string {
  const declared = Object.keys(facts.commands ?? {});
  if (!facts.toolchains.length && !declared.length) return "";
  const list = facts.toolchains
    .map((t) => `${t.name}${t.variant ? ` (${t.variant})` : ""}${t.dir === "." ? "" : ` @ ${t.dir}`}`)
    .join(", ");
  const head = list ? `Project toolchains: ${list}. ` : "";
  // Advertise each declared command as `name(args) — description` so coder can SELECT it by INTENT.
  // The description is the whole point: the prompt names no command and no role; the model reads
  // these and picks the one that fits its need (e.g. "list a PR's CI check status").
  const declaredList = declared.map((n) => {
    const d = facts.commands?.[n];
    const a = d ? templateArgs(cmdOf(d)) : [];
    const desc = d ? descOf(d) : undefined;
    return `- ${n}${a.length ? `(${a.join(", ")})` : ""}${desc ? ` — ${desc}` : ""}`;
  });
  const declaredNote = declared.length
    ? `\n\nThis repo also DECLARES these project-specific commands — run with \`script(name, {args})\`; pick the one whose description fits what you need to do:\n${declaredList.join("\n")}`
    : "";
  return `${head}Run project tasks (test, typecheck, lint, build, install, or any package script) with the \`script\` tool — it picks the correct command per toolchain; do NOT run npm/pnpm/uv/etc. by hand.${declaredNote}`;
}

/** A compact index of learned project patterns — literals inline, refs as POINTERS (read on demand,
 *  never the resolved contents, so it stays current + context-cheap). Empty if none. */
export function renderPatterns(facts: ProjectFacts): string {
  const patterns = facts.patterns ?? [];
  if (!patterns.length) return "";
  const line = (p: ProjectPattern) => {
    const head = `${p.key}${p.category && p.category !== "other" ? ` [${p.category}]` : ""}`;
    return p.ref ? `- ${head} → see ${p.ref}` : `- ${head}: ${p.value ?? ""}`;
  };
  return `Project patterns coder has learned (REUSE these; do NOT re-ask or reinvent — read a \`ref\` on demand for current values; record new durable ones with the \`remember\` tool):\n${patterns.map(line).join("\n")}`;
}
