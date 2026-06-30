import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "../src/agent/tools.ts";

/** A fixture repo with a JS toolchain (so a runtime is detected) + optional declared commands.
 *  packageManager `bun` → run_code executes with `bun`, which is always present in the test env. */
async function repo(commands?: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "coder-runcode-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fx", packageManager: "bun@1.1.0" }));
  if (commands) {
    await Bun.write(join(root, ".coder", "facts.json"), JSON.stringify({ commands }));
  }
  return root;
}
// biome-ignore lint: AI SDK tool execute has a second options arg we don't use.
const exec = (root: string, code: string) => makeTools({ root }).run_code.execute!({ code }, {} as never) as Promise<string>;

describe("run_code — code-execution dispatch", () => {
  test("keeps intermediate data OUT of context: 1MB in → one line out", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "big.txt"), `${"x\n".repeat(500_000)}`); // ~1MB, 500k lines
      const out = await exec(root, `const t = await read("big.txt"); console.log(t.trim().split("\\n").length + " lines");`);
      expect(out).toContain("500000 lines");
      expect(out).toContain("[exit 0]");
      expect(out.length).toBeLessThan(200); // the megabyte never came back
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run() invokes a declared command BY INTENT and returns its value (prints nothing itself)", async () => {
    const root = await repo({ greet: { cmd: "echo hi {who}", desc: "greet someone" } });
    try {
      const out = await exec(root, `const r = await run("greet", { who: "bob" }); console.log(r.stdout.trim().toUpperCase());`);
      expect(out).toContain("HI BOB"); // only the user's console.log; run() itself printed nothing
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("injection-safe: a metacharacter arg stays one inert token (pins __q vs shellQuote)", async () => {
    const root = await repo({ greet: { cmd: "echo got {who}", desc: "x" } });
    try {
      const out = await exec(root, `console.log((await run("greet", { who: "a; rm -rf /" })).stdout.trim());`);
      expect(out).toContain("got a; rm -rf /"); // the `;` did not break out — printed literally
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("surfaces a thrown error (stack on stderr) with [exit 1]", async () => {
    const root = await repo();
    try {
      const out = await exec(root, `throw new Error("boom");`);
      expect(out).toContain("boom");
      expect(out).toContain("[exit 1]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans up the temp program after running", async () => {
    const root = await repo();
    try {
      await exec(root, `console.log("done");`);
      const left = await readdir(join(root, ".coder", "run")).catch(() => []);
      expect(left.filter((f) => f.endsWith(".mjs"))).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unavailable when no JS runtime is detected", async () => {
    const root = await mkdtemp(join(tmpdir(), "coder-runcode-")); // no package.json → no js toolchain
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    try {
      const out = await exec(root, `console.log("hi");`);
      expect(out).toContain("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
