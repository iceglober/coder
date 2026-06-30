// Sandbox seam. The agent's shell commands run through a CommandRunner, not directly on
// the host — so we can drop a per-worktree container (PLAN §"Sandbox and workspace")
// behind the same interface without touching tool logic. v1 ships the host runner only;
// the container runner implements the same shape and is selected at wiring time.
//
// File tools deliberately do NOT go through here: the worktree is the unit of work and is
// bind-mounted into the container, so reads/writes act on the mounted path directly. Only
// process execution needs isolation, which is exactly what this seam abstracts.
import { spawn } from "node:child_process";

export interface RunOptions {
  /** Working directory for the command (the worktree root). */
  cwd: string;
  /** Cancels the in-flight process (interrupt / run abort). */
  signal?: AbortSignal;
  /** Wall-clock cap; the process is killed and `timedOut` is set when exceeded. */
  timeoutMs?: number;
  /** Called with the spawned process-GROUP id (the detached child's pid) when it starts — lets a
   *  caller sample that tree's CPU/RSS (per-session resource monitoring). Host runner only. */
  onStart?: (pgid: number) => void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code (or the signal-kill code). */
  exitCode: number;
  /** True iff the command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

export interface CommandRunner {
  /**
   * Run `argv` and capture output. Does **not** throw on a non-zero exit — that's a normal
   * result the model should see. Throws only when the process can't be spawned (e.g. the
   * binary is missing), so callers can fall back (grep → git grep).
   */
  run(argv: string[], opts: RunOptions): Promise<CommandResult>;
}

/** Runs commands directly on the host. v1 default — no isolation yet. */
export class HostCommandRunner implements CommandRunner {
  run(argv: string[], opts: RunOptions): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      // `detached` makes the child its own process-GROUP leader, so abort/timeout can kill the
      // WHOLE tree (bash → turbo → vitest → workers), not just the shell. Without it, killing the
      // shell orphans its children, which keep the stdout pipe open and the run hangs until they
      // finish — which is why Ctrl-C did nothing mid-command. `stdin: ignore` so a command that
      // reads stdin can't hang. We resolve on `close` (process gone), not on draining the pipe.
      const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (child.pid) opts.onStart?.(child.pid); // pid === pgid (detached); the caller samples this tree
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d;
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d;
      });

      const killTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig); // negative pid → the whole process group
        } catch {
          try {
            child.kill(sig); // group gone already, or no perms — fall back to the direct child
          } catch {
            // already dead
          }
        }
      };
      const timer = opts.timeoutMs != null ? setTimeout(() => ((timedOut = true), killTree("SIGKILL")), opts.timeoutMs) : undefined;
      const onAbort = () => killTree("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) killTree("SIGKILL"); // already aborted before we could listen
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };

      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err); // spawn failure (e.g. missing binary) — callers fall back (grep → git grep)
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const exitCode = code ?? (signal === "SIGTERM" ? 143 : 137); // signal-kill → conventional code
        resolve({ stdout, stderr, exitCode, timedOut });
      });
    });
  }
}
