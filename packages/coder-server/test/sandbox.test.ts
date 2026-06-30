import { describe, expect, test } from "bun:test";
import { makeTools } from "../src/agent/tools.ts";
import { DockerSandbox } from "../src/sandbox/docker.ts";
import { type CommandResult, type CommandRunner, HostCommandRunner, type RunOptions } from "../src/sandbox/index.ts";

/** Records argv and returns a canned result — lets us assert docker translation without a daemon. */
function recordingRunner(result: Partial<CommandResult> = {}): { calls: string[][]; runner: CommandRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(argv) {
        calls.push(argv);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...result };
      },
    },
  };
}

/** Minimal docker daemon stand-in: answers `ps`/`run`/`exec` so start()'s verify probe passes. */
function dockerFake(running: boolean): { calls: string[][]; runner: CommandRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(argv) {
        calls.push(argv);
        const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
        if (argv[1] === "ps") return ok(running ? "cid\n" : "");
        if (argv[1] === "exec") return ok("MOUNT_OK\n"); // mount-verify probe succeeds
        return ok("cid\n"); // run / rm
      },
    },
  };
}

describe("HostCommandRunner", () => {
  const runner = new HostCommandRunner();

  test("captures stdout and a zero exit", async () => {
    const r = await runner.run(["bash", "-lc", "printf hello"], { cwd: process.cwd() });
    expect(r.stdout).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("non-zero exit is a result, not a throw", async () => {
    const r = await runner.run(["bash", "-lc", "exit 3"], { cwd: process.cwd() });
    expect(r.exitCode).toBe(3);
  });

  test("timeoutMs kills the process and flags timedOut", async () => {
    const r = await runner.run(["bash", "-lc", "sleep 5"], { cwd: process.cwd(), timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  test("abort kills a running command (and its child tree) promptly — not after it finishes", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    // bash spawns a child that would run 10s; abort must kill the whole group, returning at once.
    const r = await runner.run(["bash", "-lc", "sleep 10 & wait"], { cwd: process.cwd(), signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(2000); // returned on abort, not after 10s
    expect(r.exitCode).not.toBe(0); // killed
  });
});

describe("tools route shell through the injected runner", () => {
  test("bash calls runner.run instead of spawning on the host", async () => {
    const calls: string[][] = [];
    const fake: CommandRunner = {
      async run(argv: string[], _opts: RunOptions): Promise<CommandResult> {
        calls.push(argv);
        return { stdout: "mocked", stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const tools = makeTools({ root: process.cwd(), runner: fake });
    const out = await tools.bash.execute!({ command: "echo hi" }, {} as never);

    expect(calls).toEqual([["bash", "-lc", "echo hi"]]);
    expect(out).toContain("mocked");
    expect(out).toContain("[exit 0]");
  });
});

describe("DockerSandbox translates to docker CLI", () => {
  const root = "/home/me/repo";

  test("run wraps argv in `docker exec` against the worktree mount", async () => {
    const { calls, runner } = recordingRunner();
    const box = new DockerSandbox({ worktreeRoot: root, base: runner });
    await box.run(["bash", "-lc", "ls"], { cwd: root });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["docker", "exec", "-w", "/workspace", box.name, "bash", "-lc", "ls"]);
  });

  test("a deadline is enforced inside the container via coreutils timeout", async () => {
    const { calls, runner } = recordingRunner();
    const box = new DockerSandbox({ worktreeRoot: root, base: runner });
    await box.run(["bash", "-lc", "sleep 9"], { cwd: root, timeoutMs: 2000 });

    expect(calls[0]).toEqual([
      "docker", "exec", "-w", "/workspace", box.name,
      "timeout", "-k", "5s", "2s", "bash", "-lc", "sleep 9",
    ]);
  });

  test("container-side timeout exit (124) is surfaced as timedOut", async () => {
    const { runner } = recordingRunner({ exitCode: 124 });
    const box = new DockerSandbox({ worktreeRoot: root, base: runner });
    const r = await box.run(["bash", "-lc", "sleep 9"], { cwd: root, timeoutMs: 2000 });
    expect(r.timedOut).toBe(true);
  });

  test("reuses a running container — no `docker run`, no re-verify", async () => {
    const { calls, runner } = dockerFake(true);
    const box = new DockerSandbox({ worktreeRoot: root, base: runner });
    await box.start();
    expect(calls.map((c) => c[1])).toEqual(["ps"]);
  });

  test("creates and verifies the mount when not running, hardened with no-new-privileges", async () => {
    const { calls, runner } = dockerFake(false);
    const box = new DockerSandbox({ worktreeRoot: root, image: "node:22-bookworm", base: runner });
    await box.start();

    expect(calls.map((c) => c[1])).toEqual(["ps", "run", "exec"]); // ps → run → mount-verify probe
    const runCmd = calls[1];
    expect(runCmd.slice(0, 3)).toEqual(["docker", "run", "-d"]);
    expect(runCmd).toContain("--security-opt");
    expect(runCmd).toContain("no-new-privileges");
    expect(runCmd).toContain(`${root}:/workspace`);
    expect(runCmd).toContain("node:22-bookworm");
  });

  test("start throws (and tears down) if the worktree mount isn't writable", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(argv) {
        calls.push(argv);
        const sub = argv[1];
        if (sub === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        if (sub === "exec") return { stdout: "", stderr: "read-only fs", exitCode: 1, timedOut: false };
        return { stdout: "cid\n", stderr: "", exitCode: 0, timedOut: false };
      },
    };
    const box = new DockerSandbox({ worktreeRoot: "/outside/home/repo", base: runner });
    await expect(box.start()).rejects.toThrow(/bind mount|not usable/);
    expect(calls.map((c) => c[1])).toContain("rm"); // best-effort teardown
  });

  test("opt-in user + network thread into exec and run", async () => {
    const { calls, runner } = dockerFake(false);
    const box = new DockerSandbox({ worktreeRoot: root, base: runner, user: "node", network: "none" });
    await box.start();
    const runCmd = calls.find((c) => c[1] === "run")!;
    expect(runCmd).toContain("--network");
    expect(runCmd).toContain("none");

    calls.length = 0;
    await box.run(["bash", "-lc", "id"], { cwd: root });
    expect(calls[0]).toContain("-u");
    expect(calls[0]).toContain("node");
  });

  test("container name is stable per worktree, distinct across worktrees", () => {
    const a = new DockerSandbox({ worktreeRoot: "/a", base: recordingRunner().runner });
    const a2 = new DockerSandbox({ worktreeRoot: "/a", base: recordingRunner().runner });
    const b = new DockerSandbox({ worktreeRoot: "/b", base: recordingRunner().runner });
    expect(a.name).toBe(a2.name);
    expect(a.name).not.toBe(b.name);
  });
});
