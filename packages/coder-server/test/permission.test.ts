import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "coder-core";
import { COMMAND_TOOLS, createGate, makeTools, toolsForRole } from "../src/agent/tools.ts";
import { PermissionPolicy } from "../src/permission/index.ts";
import type { CommandRunner } from "../src/sandbox/index.ts";

const okRunner: CommandRunner = {
  async run() {
    return { stdout: "ran", stderr: "", exitCode: 0, timedOut: false };
  },
};

// biome-ignore lint: AI SDK tool execute has a second options arg we don't use here.
const exec = (t: { execute?: (a: never, o: never) => unknown }, args: unknown) => t.execute!(args as never, {} as never) as Promise<string>;
const always = (mode: PermissionMode) => (): PermissionMode => mode;

describe("permission policy", () => {
  test("posture presets map tools to allow/ask/deny", () => {
    const auto = new PermissionPolicy({ mode: "auto" });
    expect(auto.decide("bash")).toBe("auto");
    expect(auto.decide("write_file")).toBe("auto");

    const ask = new PermissionPolicy({ mode: "ask" });
    expect(ask.decide("read_file")).toBe("auto"); // reads always free
    expect(ask.decide("write_file")).toBe("ask");
    expect(ask.decide("bash")).toBe("ask");

    const autoEdit = new PermissionPolicy({ mode: "auto-edit" });
    expect(autoEdit.decide("write_file")).toBe("auto");
    expect(autoEdit.decide("bash")).toBe("ask");

    const plan = new PermissionPolicy({ mode: "plan" });
    expect(plan.decide("read_file")).toBe("auto");
    expect(plan.decide("write_file")).toBe("deny");
    expect(plan.decide("bash")).toBe("deny");
  });

  test("verify (script) is gated by effect — allowed even in plan (diagnosis, not mutation)", () => {
    // script runs the project's own checks: never a write, so plan mode permits it. This is what
    // lets the read-only investigator reproduce a failure instead of guessing from the code.
    expect(new PermissionPolicy({ mode: "plan" }).decide("script")).toBe("auto");
    expect(new PermissionPolicy({ mode: "auto" }).decide("script")).toBe("auto");
    expect(new PermissionPolicy({ mode: "auto-edit" }).decide("script")).toBe("auto");
    expect(new PermissionPolicy({ mode: "ask" }).decide("script")).toBe("ask");
    // bash (arbitrary execution) stays denied in plan — verify ≠ bash.
    expect(new PermissionPolicy({ mode: "plan" }).decide("bash")).toBe("deny");
  });

  test("per-tool overrides win over the posture", () => {
    const p = new PermissionPolicy({ mode: "ask", tools: { bash: "deny", write_file: "auto" } });
    expect(p.decide("bash")).toBe("deny");
    expect(p.decide("write_file")).toBe("auto");
    expect(p.decide("edit_file")).toBe("ask"); // not overridden
  });
});

describe("role as toolset (keystone)", () => {
  const all = makeTools({ root: process.cwd() });

  test("investigator gets read + verify, but NO write tools", () => {
    const inv = toolsForRole(all, "investigate");
    // can observe and run checks…
    expect(inv.read_file).toBeDefined();
    expect(inv.grep).toBeDefined();
    expect(inv.script).toBeDefined(); // verify
    // …but cannot write or run arbitrary shell — the tools simply aren't there.
    expect(inv.write_file).toBeUndefined();
    expect(inv.edit_file).toBeUndefined();
    expect(inv.bash).toBeUndefined();
  });

  test("full role keeps every tool", () => {
    const full = toolsForRole(all, "full");
    expect(Object.keys(full).sort()).toEqual(Object.keys(all).sort());
  });

  test("unknown (operation) tools default to read, so the investigator keeps them", () => {
    const withOp = { ...all, git_state: all.read_file }; // stand-in op tool, not in TOOL_EFFECTS
    expect(toolsForRole(withOp, "investigate").git_state).toBeDefined();
  });
});

describe("sandbox routing by command source", () => {
  test("declared (host-authed) commands run on the host; toolchain code runs in the sandbox", async () => {
    const calls: string[] = [];
    const tag = (where: string): CommandRunner => ({
      async run(argv) {
        calls.push(`${where}:${argv[2]}`); // argv = ["bash","-lc",<cmd>]
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "coder-sbx-"));
    try {
      await Bun.spawn({ cmd: ["git", "init", "-q"], cwd: dir }).exited;
      await Bun.write(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run" } }));
      await Bun.write(join(dir, "pnpm-lock.yaml"), "");
      await Bun.write(join(dir, ".coder/facts.json"), JSON.stringify({ commands: { checks: "gh pr checks" } }));
      const tools = makeTools({ root: dir, runner: tag("sandbox"), hostRunner: tag("host") });

      await exec(tools.script, { task: "checks" }); // declared → host (needs your gh auth)
      await exec(tools.script, { task: "test" }); // toolchain (repo code) → sandbox

      expect(calls).toContain("host:gh pr checks");
      expect(calls).toContain("sandbox:pnpm run test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("timeout guard (stop re-running a command that doesn't finish)", () => {
  const timingOut: CommandRunner = {
    async run() {
      return { stdout: "", stderr: "", exitCode: 137, timedOut: true }; // always times out
    },
  };

  test("after 2 bash timeouts, the 3rd is refused without spawning", async () => {
    const { RunSignals } = await import("../src/operations/index.ts");
    const signals = new RunSignals();
    let spawns = 0;
    const counting: CommandRunner = {
      async run() {
        spawns++;
        return { stdout: "", stderr: "", exitCode: 137, timedOut: true };
      },
    };
    const tools = makeTools({ root: process.cwd(), runner: counting, signals });
    await exec(tools.bash, { command: "sleep 999" }); // timeout 1 — runs
    await exec(tools.bash, { command: "sleep 999" }); // timeout 2 — runs
    const third = await exec(tools.bash, { command: "sleep 999" }); // refused — no spawn
    expect(spawns).toBe(2); // only the first two actually ran
    expect(third).toContain("timed out");
    expect(signals.totalTimeouts).toBe(2);
  });

  test("a timeout is recorded against the script TASK, so retries at any scope count", async () => {
    const { RunSignals } = await import("../src/operations/index.ts");
    const signals = new RunSignals();
    const tools = makeTools({ root: process.cwd(), runner: timingOut, signals });
    // process.cwd() (coder) has a bun `test` task; both calls resolve to it and time out.
    await exec(tools.script, { task: "test" });
    expect(signals.timedOutBefore("test")).toBe(1);
  });
});

describe("script whole-workspace steer (evidence note)", () => {
  test("a bare `test` in a monorepo notes it ran every package; a scoped one doesn't", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coder-steer-"));
    try {
      await Bun.spawn({ cmd: ["git", "init", "-q"], cwd: dir }).exited;
      await Bun.write(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "turbo test" } }));
      await Bun.write(join(dir, "pnpm-lock.yaml"), "");
      await Bun.write(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
      await Bun.write(join(dir, "apps/web/package.json"), JSON.stringify({ name: "@x/web", scripts: { test: "vitest run" } }));
      const tools = makeTools({ root: dir, runner: okRunner });

      const whole = await exec(tools.script, { task: "test" }); // no path → whole workspace
      expect(whole).toContain("ran the whole workspace (1 packages)");

      const scoped = await exec(tools.script, { task: "test", path: "apps/web" }); // scoped → no note
      expect(scoped).not.toContain("whole workspace");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("command concurrency gate (OOM guard)", () => {
  test("createGate serializes parallel work to its limit (and start fires post-acquire)", async () => {
    const gate = createGate(1); // the runner applies this around COMMAND_TOOLS' whole execution
    let active = 0;
    let maxActive = 0;
    const started: number[] = []; // order in which work actually begins (post-acquire)
    const task = (id: number) =>
      gate(async () => {
        started.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
      });
    await Promise.all([task(1), task(2), task(3)]);
    expect(maxActive).toBe(1); // never two heavy commands at once
    expect(started).toEqual([1, 2, 3]); // they begin one at a time, in order — serial on screen
  });

  test("script/bash are the gated command tools", () => {
    expect(COMMAND_TOOLS.has("script")).toBe(true);
    expect(COMMAND_TOOLS.has("bash")).toBe(true);
    expect(COMMAND_TOOLS.has("read_file")).toBe(false); // reads stay parallel
  });
});

describe("permission gate (tools honor the policy)", () => {
  test("ask + denial blocks the action", async () => {
    const asks: string[] = [];
    const tools = makeTools({
      root: process.cwd(),
      runner: okRunner,
      decide: always("ask"),
      requestPermission: async (tool) => {
        asks.push(tool);
        return false;
      },
    });
    const out = await exec(tools.bash, { command: "echo hi" });
    expect(asks).toEqual(["bash"]);
    expect(out).toContain("permission denied");
    expect(out).not.toContain("ran");
  });

  test("ask + approval lets it run", async () => {
    const tools = makeTools({ root: process.cwd(), runner: okRunner, decide: always("ask"), requestPermission: async () => true });
    expect(await exec(tools.bash, { command: "echo hi" })).toContain("ran");
  });

  test("policy deny blocks without asking and doesn't touch the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "coder-perm-"));
    try {
      let asked = false;
      const tools = makeTools({
        root,
        decide: always("deny"),
        requestPermission: async () => {
          asked = true;
          return true;
        },
      });
      const out = await exec(tools.write_file, { path: "nope.txt", content: "x" });
      expect(out).toContain("permission denied");
      expect(asked).toBe(false); // deny short-circuits the ask
      expect(existsSync(join(root, "nope.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads are never gated, whatever the policy says", async () => {
    let asked = false;
    const tools = makeTools({
      root: process.cwd(),
      decide: always("ask"),
      requestPermission: async () => {
        asked = true;
        return false;
      },
    });
    await exec(tools.read_file, { path: "package.json" });
    await exec(tools.list_dir, { path: "." });
    expect(asked).toBe(false);
  });

  test("default (no policy) auto-runs gated tools (full-auto)", async () => {
    const tools = makeTools({ root: process.cwd(), runner: okRunner }); // no decide, no requestPermission
    expect(await exec(tools.bash, { command: "echo hi" })).toContain("ran");
  });
});
