// checkout — get the worktree onto the branch the work belongs on, deterministically. A tab runs in
// an isolated worktree on a throwaway `coder/wt-*` branch (good for NEW work). For a task that targets
// an EXISTING PR or branch, the agent must first switch the worktree to it — otherwise commits land on
// the throwaway branch and a push never reaches the PR. This makes that one cheap step instead of a
// multi-command `git fetch`/checkout fumble. Host-side + trusted (gh uses your host auth); effect=write.
import { z } from "zod";
import { HostCommandRunner } from "../sandbox/index.ts";
import type { Operation } from "./index.ts";

export interface CheckoutResult {
  ok: boolean;
  branch: string; // the branch HEAD is on after the attempt
  message: string;
}

const params = z.object({
  pr: z.number().int().positive().optional().describe("PR number to check out (uses `gh pr checkout`)"),
  branch: z.string().min(1).optional().describe("existing branch name to fetch + check out"),
});

async function currentBranch(host: HostCommandRunner, cwd: string): Promise<string> {
  const r = await host.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return r.stdout.trim() || "(unknown)";
}

export const checkout: Operation<z.infer<typeof params>, CheckoutResult> = {
  spec: {
    name: "checkout",
    description:
      "Switch this worktree onto an existing PR or branch so your commits and pushes land there. " +
      "Use it FIRST when the task targets a PR (`{pr: 2720}`, runs `gh pr checkout`) or a branch " +
      "(`{branch: \"fix/x\"}`, fetches + checks it out). You start on a throwaway `coder/wt-*` branch; " +
      "without this, work never reaches the PR. Not needed when starting brand-new work.",
    locality: "local",
    effect: "write",
    trust: "builtin",
    surfaces: [{ kind: "tool" }],
  },
  parameters: params,
  async run(input, ctx) {
    const host = new HostCommandRunner();
    const cwd = ctx.worktreeRoot;
    if (input.pr == null && !input.branch) {
      return { ok: false, branch: await currentBranch(host, cwd), message: "pass either {pr} or {branch}" };
    }

    if (input.pr != null) {
      const r = await host.run(["gh", "pr", "checkout", String(input.pr)], { cwd });
      const branch = await currentBranch(host, cwd);
      if (r.exitCode !== 0) {
        return { ok: false, branch, message: `gh pr checkout ${input.pr} failed: ${r.stderr.trim() || r.stdout.trim() || "is gh installed and authenticated?"}` };
      }
      return { ok: true, branch, message: `checked out PR #${input.pr} → branch ${branch}; commits + push now update the PR` };
    }

    // branch: fetch so a remote-only branch resolves, then check it out (git auto-tracks origin/<b>).
    await host.run(["git", "fetch", "origin", input.branch as string], { cwd }).catch(() => {});
    const r = await host.run(["git", "checkout", input.branch as string], { cwd });
    const branch = await currentBranch(host, cwd);
    if (r.exitCode !== 0) {
      return { ok: false, branch, message: `git checkout ${input.branch} failed: ${r.stderr.trim() || r.stdout.trim()}` };
    }
    return { ok: true, branch, message: `checked out branch ${branch}` };
  },
};
