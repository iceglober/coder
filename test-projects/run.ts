#!/usr/bin/env bun
// Eval harness — run coder against each task in tasks.jsonc and report PASS/FAIL.
//
// For each task: copy its project to a throwaway dir (so the originals stay pristine), `git init`
// (coder's facts detection needs a repo), run `setup` to install deps, run coder ONCE with the
// prompt, then run `verify`. PASS = verify exits 0. We also surface coder's own cost / changed-files
// footer so you can compare runs over time.
//
//   bun test-projects/run.ts            # all tasks
//   bun test-projects/run.ts py         # only tasks whose id contains "py"
//   KEEP=1 bun test-projects/run.ts     # don't delete the throwaway dirs (to inspect the diff)
import { $ } from "bun";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorktree, removeWorktree, type Worktree } from "../packages/coder-core/src/worktree.ts";
import { judgeSolution } from "../packages/coder-server/src/eval/judge.ts";

// The LLM judge runs in THIS process (not a coder subprocess), so the Vertex creds must be on
// process.env, not just the child env below.
process.env.GOOGLE_VERTEX_PROJECT ??= "ai-tooling-496018";
process.env.GOOGLE_VERTEX_LOCATION ??= "global";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODER = join(HERE, "..", "bin", "coder");

interface Task {
  id: string;
  project: string;
  prompt: string;
  seed?: string; // shell run on the fresh copy BEFORE the commit — perturbs the baseline (e.g. plant a bug)
  setup?: string;
  needs?: string[]; // tools that must be on PATH, else the task is SKIPPED (not failed)
  // Graders — a task passes iff every grader present passes:
  verify?: string; // command must exit 0 (Full tasks: a change makes a suite pass)
  expect?: string[]; // every substring must appear in coder's output (Question/Investigation)
  expectNoChange?: boolean; // `git diff` must be empty (read-only / diagnosis tasks)
  judge?: string; // a rubric — an LLM grades coder's DIFF + report against it (ambiguous-hard tasks)
}

/** Tolerant JSONC: strip `//` line comments (not inside strings) so we can keep the manifest annotated. */
function parseJsonc(text: string): Task[] {
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
  return JSON.parse(stripped);
}

const env = {
  ...process.env,
  GOOGLE_VERTEX_PROJECT: process.env.GOOGLE_VERTEX_PROJECT ?? "ai-tooling-496018",
  GOOGLE_VERTEX_LOCATION: process.env.GOOGLE_VERTEX_LOCATION ?? "global",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

/** Pull the last `$<cost>` and the `changed N file…` line out of coder's footer, for the report. */
function summarize(out: string): { cost: string; changed: string } {
  const costs = [...out.matchAll(/·\s*(\$[\d.]+)\s*·/g)].map((m) => m[1]);
  const changed = out.match(/changed \d+ files?:[^\n]*/)?.[0] ?? "(no change footer)";
  return { cost: costs.at(-1) ?? "?", changed };
}

const filter = process.argv[2];
const tasks = parseJsonc(await readFile(join(HERE, "tasks.jsonc"), "utf8")).filter((t) => !filter || t.id.includes(filter));

const results: { id: string; pass: boolean; skip?: boolean; cost: string; note: string; secs: number }[] = [];

for (const t of tasks) {
  console.log(`\n\x1b[1m▶ ${t.id}\x1b[0m  (${t.project})`);
  const lack = (t.needs ?? []).filter((tool) => !Bun.which(tool));
  if (lack.length) {
    console.log(`  \x1b[33mSKIP\x1b[0m — needs ${lack.join(", ")} on PATH`);
    results.push({ id: t.id, pass: true, skip: true, cost: "—", note: `skipped (no ${lack.join(",")})`, secs: 0 });
    continue;
  }
  const tmp = await mkdtemp(join(tmpdir(), `coder-eval-${t.id}-`));
  const started = Date.now();
  let wt: Worktree | undefined;
  try {
    await cp(join(HERE, t.project), tmp, { recursive: true });
    // A task may perturb the clean baseline BEFORE the commit (e.g. plant a bug) so the perturbation is
    // part of the committed state coder sees — not a spurious diff that would trip `expectNoChange`.
    if (t.seed) await $`bash -lc ${t.seed}`.cwd(tmp).quiet();
    // Commit the fixture, then run coder on an ISOLATED worktree branch — so even a coder that commits
    // never touches the committed test-projects, and the harness exercises coder's own worktree path.
    await $`git init -q`.cwd(tmp).quiet();
    await $`git add -A`.cwd(tmp).quiet();
    await $`git -c user.email=harness@coder -c user.name=harness commit -qm fixture`.cwd(tmp).quiet();
    wt = await createWorktree(tmp, { branch: `coder/eval-${t.id}` });
    const cwd = wt.path;
    // .venv/bin first so coder's detected python/pytest resolve to the per-task venv (built by setup here).
    const runEnv = { ...env, PATH: `${join(cwd, ".venv", "bin")}:${env.PATH}` };
    if (t.setup) {
      console.log(`  setup: ${t.setup}`);
      await $`bash -lc ${t.setup}`.cwd(cwd).env(runEnv).quiet();
    }
    console.log(`  coder: "${t.prompt.slice(0, 70)}…"`);
    const r = await $`bun ${CODER} --once ${t.prompt}`.cwd(cwd).env(runEnv).nothrow().quiet();
    const out = r.stdout.toString() + r.stderr.toString();

    // Graders — every one present must pass.
    const fails: string[] = [];
    if (t.verify) {
      const v = await $`bash -lc ${t.verify}`.cwd(cwd).env(runEnv).nothrow().quiet();
      if (v.exitCode !== 0) fails.push(`verify exit ${v.exitCode}: ${v.stdout.toString().split("\n").slice(-4).join(" ").slice(0, 200)}`);
    }
    if (t.expect) {
      const missing = t.expect.filter((s) => !out.includes(s));
      if (missing.length) fails.push(`answer missing: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
    }
    if (t.expectNoChange) {
      // Exclude .coder/ — coder rewrites its own facts cache there; that's not a source change.
      const d = await $`git diff --quiet -- ${"."} ${":(exclude).coder"}`.cwd(cwd).nothrow().quiet();
      if (d.exitCode !== 0) fails.push("expected read-only, but source files were changed");
    }
    if (t.judge) {
      await $`git add -A`.cwd(cwd).quiet(); // stage incl. new files so the diff shows coder's whole solution
      const diff = (await $`git diff --cached -- ${"."} ${":(exclude).coder"}`.cwd(cwd).nothrow().quiet()).stdout.toString();
      const j = await judgeSolution(t.judge, t.prompt, out, diff);
      const unmet = j.criteria.filter((c) => !c.met).map((c) => c.name);
      console.log(`    judge: ${j.pass ? "\x1b[32mpass\x1b[0m" : "\x1b[31mfail\x1b[0m"} — ${j.summary}`);
      if (unmet.length) console.log(`    unmet: ${unmet.join(", ")}`);
      if (!j.pass) fails.push(`judge failed: ${j.summary.slice(0, 200)}`);
    }
    const pass = fails.length === 0;
    const { cost, changed } = summarize(out);
    const secs = Math.round((Date.now() - started) / 1000);
    results.push({ id: t.id, pass, cost, note: changed, secs });
    console.log(`  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} · ${cost} · ${secs}s · ${changed}`);
    if (!pass) for (const f of fails) console.log(`    \x1b[31m✗\x1b[0m ${f}`);
  } catch (err) {
    results.push({ id: t.id, pass: false, cost: "?", note: `error: ${err}`, secs: Math.round((Date.now() - started) / 1000) });
    console.log(`  \x1b[31mERROR\x1b[0m ${err}`);
  } finally {
    if (process.env.KEEP) {
      console.log(`  kept: worktree ${wt?.path ?? "(none)"} (fixture repo ${tmp})`);
    } else {
      if (wt) await removeWorktree(tmp, wt, { deleteBranch: true }).catch(() => {});
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

console.log(`\n\x1b[1m── summary ──\x1b[0m`);
for (const r of results) {
  const mark = r.skip ? "\x1b[33m·\x1b[0m" : r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${r.id.padEnd(22)} ${r.cost.padStart(8)} ${String(r.secs).padStart(4)}s  ${r.skip ? r.note : ""}`);
}
const ran = results.filter((r) => !r.skip);
const passed = ran.filter((r) => r.pass).length;
const skipped = results.length - ran.length;
console.log(`  ${passed}/${ran.length} passed${skipped ? ` · ${skipped} skipped` : ""}`);
process.exit(passed === ran.length ? 0 : 1);
