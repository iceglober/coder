// Docker sandbox — runs the agent's shell commands inside a per-worktree container
// (PLAN §"Sandbox and workspace"). The worktree is bind-mounted, so file tools keep
// acting on the host path while only process execution is isolated. Credentials never
// enter the container: the host keeps making model + remote calls; the container only
// runs `bash`/`grep`.
//
// It implements CommandRunner, so it drops straight into the tool seam. The actual
// `docker` CLI is invoked through a base runner (the host) — that keeps the timeout/abort
// logic in one place and makes argv construction unit-testable without a daemon.
import { relative } from "node:path";
import { type CommandResult, type CommandRunner, HostCommandRunner, type RunOptions } from "./index.ts";

/** Default image. Has bash + git out of the box; grep falls back to `git grep` if rg is
 *  absent. Override per-project with CODER_SANDBOX_IMAGE / `image`. */
export const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm";

export interface DockerSandboxOptions {
  /** Host worktree root, bind-mounted into the container. */
  worktreeRoot: string;
  /** Container image. Defaults to DEFAULT_SANDBOX_IMAGE. */
  image?: string;
  /** Where the worktree is mounted inside the container. */
  mountPath?: string;
  /** Opt-in: run commands as a non-root user (name or `uid:gid`). Default: image default
   *  (root). Only set on an image that has the user *and* can write the bind mount. */
  user?: string;
  /** Opt-in: `docker run --network` value (e.g. `none` to cut egress). Default: bridge. */
  network?: string;
  /** Invokes the `docker` CLI itself (on the host). Defaults to HostCommandRunner. */
  base?: CommandRunner;
}

/** Stable, filesystem-safe container name derived from the worktree path (djb2). */
function containerNameFor(worktreeRoot: string): string {
  let h = 5381;
  for (let i = 0; i < worktreeRoot.length; i++) h = ((h << 5) + h + worktreeRoot.charCodeAt(i)) >>> 0;
  return `coder-${h.toString(16)}`;
}

export class DockerSandbox implements CommandRunner {
  readonly name: string;
  private readonly base: CommandRunner;
  private readonly image: string;
  private readonly mountPath: string;
  private readonly worktreeRoot: string;
  private readonly user?: string;
  private readonly network?: string;

  constructor(opts: DockerSandboxOptions) {
    this.worktreeRoot = opts.worktreeRoot;
    this.image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
    this.mountPath = opts.mountPath ?? "/workspace";
    this.user = opts.user || undefined;
    this.network = opts.network || undefined;
    this.base = opts.base ?? new HostCommandRunner();
    this.name = containerNameFor(opts.worktreeRoot);
  }

  /** Map a host cwd under the worktree to its path inside the container. */
  private toContainerPath(hostCwd: string): string {
    const rel = relative(this.worktreeRoot, hostCwd);
    if (rel === "" ) return this.mountPath;
    // Path stays inside the worktree (tools enforce this); join under the mount.
    return rel.startsWith("..") ? this.mountPath : `${this.mountPath}/${rel}`;
  }

  /** True if the container is already running (so repeated starts reuse it). */
  async isRunning(): Promise<boolean> {
    const r = await this.base.run(["docker", "ps", "-q", "-f", `name=^${this.name}$`], {
      cwd: this.worktreeRoot,
    });
    return r.exitCode === 0 && r.stdout.trim() !== "";
  }

  /** Ensure the container exists and is running, bind-mounting the worktree. Idempotent.
   *  On first create it also verifies the mount is actually usable. */
  async start(): Promise<void> {
    if (await this.isRunning()) return; // already verified when it was created
    const args = [
      "docker", "run", "-d", "--rm",
      "--name", this.name,
      "--security-opt", "no-new-privileges", // block setuid privilege escalation
      "-v", `${this.worktreeRoot}:${this.mountPath}`,
      "-w", this.mountPath,
    ];
    if (this.network) args.push("--network", this.network);
    args.push(this.image, "sleep", "infinity");

    const r = await this.base.run(args, { cwd: this.worktreeRoot, timeoutMs: 300_000 }); // first run may pull
    if (r.exitCode !== 0) {
      throw new Error(`docker run failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    await this.verifyMount();
  }

  /**
   * Prove the worktree is bind-mounted, writable, and that the image has `bash` — before
   * the agent relies on any of it. Catches the common footgun where the worktree lives
   * outside the runtime's mounted paths (e.g. colima only mounts the home dir) and
   * `/workspace` silently comes up empty.
   */
  private async verifyMount(): Promise<void> {
    const probe = await this.run(
      ["bash", "-lc", "touch .coder/.mount-probe && rm -f .coder/.mount-probe && echo MOUNT_OK"],
      { cwd: this.worktreeRoot },
    );
    if (probe.exitCode === 126 || probe.exitCode === 127) {
      await this.stop();
      throw new Error(`sandbox image '${this.image}' has no usable bash: ${probe.stderr.trim()}`);
    }
    if (!probe.stdout.includes("MOUNT_OK")) {
      await this.stop();
      throw new Error(
        `worktree not usable inside the container — the bind mount of ${this.worktreeRoot} at ` +
          `${this.mountPath} is missing or not writable. With colima the worktree must be under a ` +
          `mounted path (the home dir by default); otherwise restart colima with ` +
          `--mount '${this.worktreeRoot}:w'. (exit ${probe.exitCode}) ${probe.stderr.trim()}`,
      );
    }
  }

  /** Remove the container. Best-effort; never throws. */
  async stop(): Promise<void> {
    try {
      await this.base.run(["docker", "rm", "-f", this.name], { cwd: this.worktreeRoot });
    } catch {
      // teardown is best-effort
    }
  }

  /**
   * CommandRunner: run argv inside the container via `docker exec`.
   *
   * Killing `docker exec` on the host does NOT stop the in-container process, so a host
   * timeout alone would orphan a runaway command for the rest of the run. We enforce the
   * deadline *inside* the container with coreutils `timeout` (kills the process tree
   * there), and keep the host timeout only as a longer backstop. Container teardown
   * (`docker rm -f`) reaps anything that still slips through on run-abort.
   */
  async run(argv: string[], opts: RunOptions): Promise<CommandResult> {
    const containerCwd = this.toContainerPath(opts.cwd);
    let inner = argv;
    let hostTimeoutMs = opts.timeoutMs;
    if (opts.timeoutMs != null) {
      const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
      // TERM at the deadline, KILL 5s later if it ignores TERM.
      inner = ["timeout", "-k", "5s", `${secs}s`, ...argv];
      hostTimeoutMs = opts.timeoutMs + 10_000; // backstop only if container-side timeout wedges
    }
    const exec = ["docker", "exec", "-w", containerCwd];
    if (this.user) exec.push("-u", this.user);
    exec.push(this.name, ...inner);
    const r = await this.base.run(exec, {
      cwd: this.worktreeRoot,
      signal: opts.signal,
      timeoutMs: hostTimeoutMs,
    });
    // `timeout` exits 124 (TERM) or 137 (128+KILL) when it fires — surface that as timedOut.
    const timedOut = r.timedOut || r.exitCode === 124 || r.exitCode === 137;
    return { ...r, timedOut };
  }
}
