// find_def — locate where a symbol is defined. Replaces "grep for X and reason about
// which match is the definition" with a deterministic search for declaration patterns.
// Local + read; host-side over the worktree.
import { z } from "zod";
import { HostCommandRunner } from "../sandbox/index.ts";
import type { Operation } from "./index.ts";

export interface DefMatch {
  file: string;
  line: number;
  text: string;
}

/** Regex matching common declaration forms (TS/JS/Py/Go/Rust) for `symbol`. */
export function definitionPattern(symbol: string): string {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `\\b(function|class|interface|type|enum|struct|trait|const|let|var|def|fn|func)\\s+${esc}\\b`;
}

/** Parse `file:line:text` grep lines into structured matches. */
export function parseDefMatches(out: string, limit = 50): DefMatch[] {
  const matches: DefMatch[] = [];
  for (const line of out.split("\n").filter(Boolean).slice(0, limit)) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (m) matches.push({ file: m[1], line: Number(m[2]), text: m[3].trim() });
  }
  return matches;
}

export const findDef: Operation<{ symbol: string }, { symbol: string; matches: DefMatch[] }> = {
  spec: {
    name: "find_def",
    description:
      "Find where a symbol (function, class, type, const, …) is defined. Returns file:line " +
      "locations of its declaration. Prefer this over grepping and guessing which match is " +
      "the definition.",
    locality: "local",
    effect: "read",
    trust: "builtin",
    surfaces: [{ kind: "tool" }],
  },
  parameters: z.object({ symbol: z.string().describe("Exact symbol name to locate the definition of") }),
  async run({ symbol }, ctx) {
    const host = new HostCommandRunner();
    const pattern = definitionPattern(symbol);
    let r;
    try {
      r = await host.run(["rg", "--line-number", "--no-heading", "--color", "never", "-e", pattern, "."], {
        cwd: ctx.worktreeRoot,
      });
    } catch {
      r = await host.run(["git", "grep", "-n", "-E", pattern], { cwd: ctx.worktreeRoot });
    }
    return { symbol, matches: parseDefMatches(r.stdout) };
  },
};
