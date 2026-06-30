import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "../src/agent/tools.ts";

// glob is gitignore-aware via `git ls-files`, so the fixture is a real (uncommitted) repo.
describe("glob tool", () => {
  let root: string;
  // biome-ignore lint: AI SDK tool execute signature has a second options arg we don't use.
  const run = (tools: ReturnType<typeof makeTools>, pattern: string) =>
    tools.glob.execute!({ pattern }, {} as never) as Promise<string>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coder-glob-"));
    await mkdir(join(root, "docs", "guide"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "junk"), { recursive: true });
    await writeFile(join(root, "README.md"), "root");
    await writeFile(join(root, "docs", "guide", "README.md"), "nested");
    await writeFile(join(root, "src", "a.ts"), "a");
    await writeFile(join(root, "src", "b.ts"), "b");
    await writeFile(join(root, "node_modules", "junk", "README.md"), "ignored");
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("finds nested matches; a no-slash pattern matches at any depth", async () => {
    const tools = makeTools({ root });
    const readmes = await run(tools, "**/README*");
    expect(readmes).toContain("README.md");
    expect(readmes).toContain("docs/guide/README.md");

    const ts = await run(tools, "*.ts"); // no slash → **/*.ts
    expect(ts).toContain("src/a.ts");
    expect(ts).toContain("src/b.ts");
  });

  test("respects .gitignore (node_modules excluded)", async () => {
    const out = await run(makeTools({ root }), "**/README*");
    expect(out).not.toContain("node_modules");
  });

  test("no matches and escaping patterns are reported, not thrown", async () => {
    const tools = makeTools({ root });
    expect(await run(tools, "**/*.rs")).toBe("no matches");
    expect(await run(tools, "../outside")).toContain("error");
    expect(await run(tools, "/etc/*")).toContain("error");
  });
});
