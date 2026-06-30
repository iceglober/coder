// git_state — deterministic repo status. Replaces the agent running `git status` and
// reasoning over raw porcelain: one tool call returns clean structured state, no model
// parsing. Local + read; runs host-side over the worktree (same files the sandbox sees).
import { z } from "zod";
import { HostCommandRunner } from "../sandbox/index.ts";
import type { Operation } from "./index.ts";

export interface GitState {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

/** Parse `git status --porcelain -b` into structured state. Pure (testable). */
export function parseGitStatus(porcelain: string): GitState {
  const state: GitState = {
    branch: "",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    clean: true,
  };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("## ")) {
      const head = line.slice(3).replace(/^No commits yet on /, "");
      const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/);
      if (m) {
        state.branch = m[1];
        state.upstream = m[2];
        if (m[3]) {
          state.ahead = Number(m[3].match(/ahead (\d+)/)?.[1] ?? 0);
          state.behind = Number(m[3].match(/behind (\d+)/)?.[1] ?? 0);
        }
      }
      continue;
    }
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    if (x === "?" && y === "?") {
      state.untracked.push(path);
      continue;
    }
    if (x !== " " && x !== "?") state.staged.push(path);
    if (y !== " " && y !== "?") state.unstaged.push(path);
  }
  state.clean = state.staged.length === 0 && state.unstaged.length === 0 && state.untracked.length === 0;
  return state;
}

export const gitState: Operation<Record<string, never>, GitState> = {
  spec: {
    name: "git_state",
    description:
      "Get structured git status: current branch, upstream, ahead/behind counts, and the " +
      "staged / unstaged / untracked file lists. Prefer this over running `git status` and " +
      "parsing it yourself.",
    locality: "local",
    effect: "read",
    trust: "builtin",
    surfaces: [{ kind: "tool" }, { kind: "command", name: "git-state" }],
  },
  parameters: z.object({}),
  async run(_input, ctx) {
    const r = await new HostCommandRunner().run(["git", "status", "--porcelain", "-b"], {
      cwd: ctx.worktreeRoot,
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "git status failed");
    return parseGitStatus(r.stdout);
  },
};
