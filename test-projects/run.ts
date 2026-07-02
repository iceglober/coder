#!/usr/bin/env bun
// Eval harness — run agentj against each task in tasks.jsonc and report PASS/FAIL.
//
// For each task: copy its project to a throwaway dir (originals stay pristine), write a .gitignore so
// installed deps stay out of git, `git init` + commit the fixture (call that commit `base`), run
// `setup` to install deps, run agentj ONCE with the prompt, then GRADE. Graders are diffed against
// `base`, so a agentj that commits its work is graded the same as one that leaves it uncommitted.
//
//   bun test-projects/run.ts               # all tasks
//   bun test-projects/run.ts py             # only tasks whose id contains "py"
//   bun test-projects/run.ts --selftest     # no agent: prove graders FAIL unsolved + PASS on the
//                                           # reference `solution` (validates every Full task)
//   KEEP=1 bun test-projects/run.ts         # don't delete the throwaway dirs (to inspect the diff)
//
// Every run appends one JSON line per task to results/history.jsonl and captures the agent's full
// output under results/out/ — the evidence trail behind pass-rate claims.
import { $ } from "bun";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// NOTE: the LLM `judge` grader is temporarily disabled — it depended on the TS package's judge, which
// was removed in the Rust cutover. `judge` tasks now grade on `verify` alone until a Rust judge lands.

// The LLM judge runs in THIS process (not a agentj subprocess), so the Vertex creds must be on
// process.env, not just the child env below.
process.env.GOOGLE_VERTEX_PROJECT ??= "ai-tooling-496018";
process.env.GOOGLE_VERTEX_LOCATION ??= "global";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTJ = join(HERE, "..", "bin", "agentj");

// Keep installed deps + caches out of git so `git add -A` only ever stages agentj's real changes.
const GITIGNORE = ["node_modules/", "**/node_modules/", ".venv/", "__pycache__/", "*.pyc", ".pytest_cache/", ".turbo/", "dist/", ".agentj/"].join("\n");
// Pathspec excluded from every diff — belt-and-suspenders alongside the .gitignore.
const EXCLUDE = ":(exclude).agentj";

interface Task {
  id: string;
  project: string;
  /** Single prompt (legacy tasks). */
  prompt?: string;
  /** Named prompt variants (e.g. terse | detailed) — same fixture, same graders, different levels of
   * hand-holding. The FIRST listed variant is the default (keep it the terse, real-world one);
   * select with --prompt <name> or run all with --all-prompts. */
  prompts?: Record<string, string>;
  seed?: string; // shell run on the fresh copy BEFORE the commit — perturbs the baseline (e.g. plant a bug)
  setup?: string;
  needs?: string[]; // tools that must be on PATH, else the task is SKIPPED (not failed)
  // Graders — a task passes iff every grader present passes:
  verify?: string; // command must exit 0 (Full tasks: a change makes a suite pass)
  expect?: string[]; // every substring must appear in agentj's output (Question/Investigation)
  expectNoChange?: boolean; // no source files changed vs the fixture (read-only / diagnosis tasks)
  expectChange?: boolean; // at least one source file must change (guards open-ended tasks whose verify is green on the baseline)
  judge?: string; // a rubric — an LLM grades agentj's DIFF + report against it (ambiguous-hard tasks)
  // Task quality proofs / limits:
  solution?: string; // shell applying the reference solution — --selftest proves verify FAILs before it and PASSes after
  timeoutSec?: number; // kill the agent after this long (default 600) — a hung run is a FAIL, not a stuck harness
  budgetTokensIn?: number; // context budget: fail the task if the run consumes more input tokens than this
}

/** Tolerant JSONC: strip `//` line comments (not inside strings) so we can keep the manifest annotated. */
function parseJsonc(text: string): Task[] {
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
  return JSON.parse(stripped);
}

/** Strip ANSI escape codes so substring/judge grading sees agentj's plain text, not its terminal markup. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI ESC (\x1b) is the point.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const env = {
  ...process.env,
  GOOGLE_VERTEX_PROJECT: process.env.GOOGLE_VERTEX_PROJECT ?? "ai-tooling-496018",
  GOOGLE_VERTEX_LOCATION: process.env.GOOGLE_VERTEX_LOCATION ?? "global",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

const argv = process.argv.slice(2);
const selftest = argv.includes("--selftest");
const allPrompts = argv.includes("--all-prompts");
const budgetSoft = argv.includes("--budget-soft"); // calibration mode: budget breaches warn instead of fail
const repeat = argv.includes("--repeat") ? Math.max(1, Number(argv[argv.indexOf("--repeat") + 1]) || 1) : 1;
const promptSel = argv.includes("--prompt") ? argv[argv.indexOf("--prompt") + 1] : undefined;
const filter = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--prompt" && argv[i - 1] !== "--repeat")[0];
const tasks = parseJsonc(await readFile(join(HERE, "tasks.jsonc"), "utf8")).filter((t) => !filter || t.id.includes(filter));

/** The (variant name, prompt text) pairs to run for a task. Default = the first listed variant. */
function variantsOf(t: Task): { vname: string; vtext: string }[] {
  const entries = Object.entries(t.prompts ?? {});
  if (selftest || !entries.length) return [{ vname: "", vtext: t.prompt ?? entries[0]?.[1] ?? "" }];
  if (allPrompts) return entries.map(([vname, vtext]) => ({ vname, vtext }));
  if (promptSel && t.prompts?.[promptSel]) return [{ vname: promptSel, vtext: t.prompts[promptSel] }];
  return [{ vname: entries[0][0], vtext: entries[0][1] }];
}

const RESULTS = join(HERE, "results");
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(join(RESULTS, "out"), { recursive: true });
await writeFile(join(RESULTS, ".gitignore"), "*\n!.gitignore\n");

const results: { id: string; pass: boolean; skip?: boolean; note: string; secs: number }[] = [];

/** Run the agent with a hard timeout; returns its combined output (killed run ⇒ graded as-is). */
async function runAgent(cwd: string, prompt: string, runEnv: Record<string, string | undefined>, timeoutSec: number) {
  const proc = Bun.spawn([AGENTJ, "--once", prompt], { cwd, env: runEnv as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutSec * 1000);
  const [so, se] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(killer);
  return { out: stripAnsi(so + se), timedOut };
}

for (const t of tasks)
for (const { vname, vtext } of variantsOf(t))
for (let rep = 1; rep <= (selftest ? 1 : repeat); rep++) {
  const label = `${vname ? `${t.id}@${vname}` : t.id}${repeat > 1 ? `#${rep}` : ""}`;
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m  (${t.project})`);
  const lack = (t.needs ?? []).filter((tool) => !Bun.which(tool));
  if (lack.length) {
    console.log(`  \x1b[33mSKIP\x1b[0m — needs ${lack.join(", ")} on PATH`);
    results.push({ id: label, pass: true, skip: true, note: `skipped (no ${lack.join(",")})`, secs: 0 });
    continue;
  }
  if (selftest && (!t.solution || !t.verify)) {
    console.log("  \x1b[33mSKIP\x1b[0m — selftest needs `solution` + `verify`");
    results.push({ id: label, pass: true, skip: true, note: "selftest n/a", secs: 0 });
    continue;
  }
  const cwd = await mkdtemp(join(tmpdir(), `agentj-eval-${label.replace("@", "-")}-`));
  const started = Date.now();
  try {
    await cp(join(HERE, t.project), cwd, { recursive: true });
    await writeFile(join(cwd, ".gitignore"), `${GITIGNORE}\n`);
    // A task may perturb the clean baseline BEFORE the commit (e.g. plant a bug) so the perturbation is
    // part of the committed state agentj sees — not a spurious diff that would trip `expectNoChange`.
    if (t.seed) await $`bash -lc ${t.seed}`.cwd(cwd).quiet();
    await $`git init -q`.cwd(cwd).quiet();
    await $`git add -A`.cwd(cwd).quiet();
    await $`git -c user.email=harness@agentj -c user.name=harness commit -qm fixture`.cwd(cwd).quiet();
    const base = (await $`git rev-parse HEAD`.cwd(cwd).quiet()).stdout.toString().trim();

    // .venv/bin first so agentj's python/pytest resolve to the per-task venv (built by setup here).
    const runEnv = { ...env, PATH: `${join(cwd, ".venv", "bin")}:${env.PATH}` };
    if (t.setup) {
      console.log(`  setup: ${t.setup}`);
      await $`bash -lc ${t.setup}`.cwd(cwd).env(runEnv).quiet();
    }
    // --selftest: no agent. Prove the task is real (graders FAIL on the unsolved fixture) and the
    // graders are sound (they PASS on the reference solution).
    if (selftest && t.solution && t.verify) {
      const pre = await $`bash -lc ${t.verify}`.cwd(cwd).env(runEnv).nothrow().quiet();
      await $`bash -lc ${t.solution}`.cwd(cwd).env(runEnv).quiet();
      const post = await $`bash -lc ${t.verify}`.cwd(cwd).env(runEnv).nothrow().quiet();
      const fails: string[] = [];
      if (pre.exitCode === 0) fails.push("verify already passes on the UNSOLVED fixture — the task tests nothing");
      if (post.exitCode !== 0) {
        const tail = (post.stdout.toString() + post.stderr.toString()).split("\n").filter(Boolean).slice(-4).join(" ").slice(0, 220);
        fails.push(`reference solution does NOT satisfy verify: ${tail}`);
      }
      const pass = fails.length === 0;
      const secs = Math.round((Date.now() - started) / 1000);
      results.push({ id: label, pass, note: "selftest", secs });
      console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} · ${secs}s · selftest (fails unsolved ✓, solution passes ✓)`);
      if (!pass) for (const f of fails) console.log(`    \x1b[31m✗\x1b[0m ${f}`);
      continue;
    }

    console.log(`  agentj: "${vtext.slice(0, 70)}…"`);
    const { out, timedOut } = await runAgent(cwd, vtext, runEnv, t.timeoutSec ?? 600);
    await writeFile(join(RESULTS, "out", `${RUN_STAMP}-${label.replace("@", "-")}.txt`), out);

    // Grade. Every grader present must pass. Diff-based graders compare the index (after `git add -A`)
    // to `base`, so they capture agentj's whole solution whether or not it committed.
    const fails: string[] = [];
    if (timedOut) fails.push(`agent killed after ${t.timeoutSec ?? 600}s`);
    // Token accounting: the primary loop prints per-call usage; delegated subagents report a total
    // in their end line. Approximate but consistent — and enough to grade context discipline.
    const tokensIn = [...out.matchAll(/tokens: (\d+) in \/ (\d+) out/g)].reduce((a, m) => a + Number(m[1]), 0);
    const tokensOut = [...out.matchAll(/tokens: (\d+) in \/ (\d+) out/g)].reduce((a, m) => a + Number(m[2]), 0);
    const subTokens = [...out.matchAll(/· (\d+) tok\b/g)].reduce((a, m) => a + Number(m[1]), 0);
    const totalTokens = tokensIn + subTokens;
    let budgetNote = "";
    if (t.budgetTokensIn && totalTokens > t.budgetTokensIn) {
      const breach = `context budget blown: ~${totalTokens} tokens used > ${t.budgetTokensIn} budget`;
      if (budgetSoft) budgetNote = ` \x1b[33m*(${breach})\x1b[0m`;
      else fails.push(breach);
    }
    if (t.verify) {
      const v = await $`bash -lc ${t.verify}`.cwd(cwd).env(runEnv).nothrow().quiet();
      if (v.exitCode !== 0) {
        const tail = (v.stdout.toString() + v.stderr.toString()).split("\n").filter(Boolean).slice(-4).join(" ").slice(0, 220);
        fails.push(`verify exit ${v.exitCode}: ${tail}`);
      }
    }
    if (t.expect) {
      const missing = t.expect.filter((s) => !out.includes(s));
      if (missing.length) fails.push(`answer missing: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
    }

    await $`git add -A`.cwd(cwd).quiet(); // stage agentj's changes (incl. new files) for the diff graders + report
    const changedFiles = (await $`git diff --cached --name-only ${base} -- ${"."} ${EXCLUDE}`.cwd(cwd).quiet()).stdout.toString().split("\n").filter(Boolean);
    const changed = changedFiles.length ? `changed ${changedFiles.length}: ${changedFiles.slice(0, 6).join(", ")}${changedFiles.length > 6 ? " …" : ""}` : "no source changes";

    if (t.expectNoChange && changedFiles.length) fails.push(`expected read-only, but changed: ${changedFiles.join(", ")}`);
    if (t.expectChange && !changedFiles.length) fails.push("expected source changes, but the diff is empty — the task was not attempted");
    if (t.judge) {
      // LLM judge disabled during the Rust cutover — grade architect tasks on `verify` only for now.
      console.log("    judge: skipped (LLM judge pending the Rust port; grading on verify only)");
    }

    const pass = fails.length === 0;
    const secs = Math.round((Date.now() - started) / 1000);
    results.push({ id: label, pass, note: changed, secs });
    await appendFile(
      join(RESULTS, "history.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), run: RUN_STAMP, id: t.id, variant: vname || undefined, pass, secs, tokensIn: totalTokens, tokensOut, changedFiles: changedFiles.length, fails })}\n`,
    );
    console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} · ${secs}s · ${changed}${budgetNote}`);
    if (!pass) for (const f of fails) console.log(`    \x1b[31m✗\x1b[0m ${f}`);
  } catch (err) {
    results.push({ id: label, pass: false, note: `error: ${err}`, secs: Math.round((Date.now() - started) / 1000) });
    console.log(`  \x1b[31mERROR\x1b[0m ${err}`);
  } finally {
    if (process.env.KEEP) console.log(`  kept: ${cwd}`);
    else await rm(cwd, { recursive: true, force: true });
  }
}

console.log(`\n\x1b[1m── summary ──\x1b[0m`);
for (const r of results) {
  const mark = r.skip ? "\x1b[33m·\x1b[0m" : r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${r.id.padEnd(22)} ${String(r.secs).padStart(4)}s  ${r.skip ? r.note : ""}`);
}
const ran = results.filter((r) => !r.skip);
const passed = ran.filter((r) => r.pass).length;
const skipped = results.length - ran.length;
console.log(`  ${passed}/${ran.length} passed${skipped ? ` · ${skipped} skipped` : ""}`);
process.exit(passed === ran.length ? 0 : 1);
