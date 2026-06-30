import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectFacts, loadFactsFile, persistFacts, type ProjectPattern, refreshProjectFacts, renderFacts, renderPatterns, resolveCommand } from "../src/project/facts.ts";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp();
  await Bun.spawn({ cmd: ["git", "init", "-q"], cwd: dir }).exited; // so git ls-files works
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true }).catch(() => {});
    await writeFile(join(dir, path), content);
  }
  return dir;
}
async function mkdtemp(): Promise<string> {
  const { mkdtemp: mt } = await import("node:fs/promises");
  return mt(join(tmpdir(), "coder-facts-"));
}

describe("project facts — polyglot toolchain detection", () => {
  test("js: bun workspace (mirrors the coder repo)", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({
        packageManager: "bun@1.2.0",
        workspaces: ["packages/*"],
        scripts: { build: "bun run --filter='*' build", test: "bun run --filter='*' test", typecheck: "bun run --filter='*' typecheck", lint: "x" },
      }),
      "bun.lock": "",
    });
    try {
      const { toolchains } = await detectProjectFacts(dir);
      expect(toolchains).toHaveLength(1);
      const js = toolchains[0];
      expect(js.name).toBe("js");
      expect(js.variant).toBe("bun"); // from the packageManager field
      expect(js.commands).toMatchObject({
        install: "bun install",
        test: "bun run test",
        typecheck: "bun run typecheck",
        build: "bun run build",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("polyglot: pnpm root + a python subpackage (mirrors kn-eng)", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({
        packageManager: "pnpm@10.33.0",
        workspaces: ["apps/*", "packages/*"],
        scripts: { build: "turbo run build", typecheck: "turbo run typecheck", lint: "biome check .", test: "turbo test", format: "biome format ." },
      }),
      "pnpm-lock.yaml": "",
      "packages/doc-pipeline/pyproject.toml": "[project]\ndependencies = ['pytest', 'mypy', 'ruff']\n",
      "packages/doc-pipeline/uv.lock": "",
      "test_phi.py": "print('loose script, no toolchain')\n", // bare .py at root → no python toolchain
    });
    try {
      const { toolchains } = await detectProjectFacts(dir);
      const js = toolchains.find((t) => t.name === "js");
      const py = toolchains.find((t) => t.name === "python");
      expect(js?.variant).toBe("pnpm");
      expect(js?.commands).toMatchObject({ typecheck: "pnpm run typecheck", lint: "pnpm run lint", format: "pnpm run format" });
      // Python anchored at the subpackage, variant from uv.lock, commands only for declared tools.
      expect(py?.dir).toBe("packages/doc-pipeline");
      expect(py?.variant).toBe("uv");
      expect(py?.commands).toMatchObject({ test: "uv run pytest", typecheck: "uv run mypy .", lint: "uv run ruff check ." });
      // The bare root test_phi.py did NOT create a second python toolchain (no project file).
      expect(toolchains.filter((t) => t.name === "python")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("custom scripts are emitted; a pre-seeded human override wins and survives", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "vitest", migrate: "prisma migrate deploy", typecheck: "tsc" } }),
      "pnpm-lock.yaml": "",
      ".coder/facts.json": JSON.stringify({ overrides: { js: { test: "pnpm run test:ci" } } }),
    });
    try {
      const js = (await detectProjectFacts(dir)).toolchains.find((t) => t.name === "js");
      expect(js?.commands.migrate).toBe("pnpm run migrate"); // custom script, runnable
      expect(js?.commands.typecheck).toBe("pnpm run typecheck"); // canonical, literal name
      expect(js?.commands.test).toBe("pnpm run test:ci"); // override beats computed "pnpm run test"
      // override survived persistence
      const f = JSON.parse(await readFile(join(dir, ".coder", "facts.json"), "utf8"));
      expect(f.overrides.js.test).toBe("pnpm run test:ci");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("monorepo: a task for a path inside a package scopes to it (pnpm --filter)", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "turbo test", typecheck: "turbo typecheck" } }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      "apps/api-server/package.json": JSON.stringify({ name: "@kn/api-server", scripts: { test: "vitest" } }),
    });
    try {
      const facts = await detectProjectFacts(dir);
      const js = facts.toolchains.find((t) => t.name === "js");
      expect(js?.workspace).toEqual([{ dir: "apps/api-server", name: "@kn/api-server", runner: "vitest" }]); // runner from the member script
      // a DIRECTORY inside the package → whole-package scope, not the whole monorepo
      expect(resolveCommand(facts, "test", "apps/api-server/src")?.command).toBe("pnpm --filter @kn/api-server run test");
      // no path → the root command (whole repo)
      expect(resolveCommand(facts, "test")?.command).toBe("pnpm run test");
      // install is always repo-wide, even with a package path
      expect(resolveCommand(facts, "install", "apps/api-server/src/x.ts")?.command).toBe("pnpm install");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("single test FILE scopes to that file via the package's runner — bypassing a turbo root", async () => {
    const dir = await repo({
      // root `test` is a wrapper (turbo) → root has NO runner; the package's own test is the runner.
      "package.json": JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "turbo test" } }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web-app/package.json": JSON.stringify({ name: "@kn/web-app", scripts: { test: "vitest run" } }),
    });
    try {
      const facts = await detectProjectFacts(dir);
      const js = facts.toolchains.find((t) => t.name === "js");
      expect(js?.runner).toBeUndefined(); // root is turbo — a wrapper, no direct runner
      // a single test file → package-relative, appended via the package's vitest, turbo bypassed
      // (the file is shell-quoted — it's a model-supplied value going into a shell command)
      expect(resolveCommand(facts, "test", "apps/web-app/src/app/tasks/page.test.tsx")?.command).toBe(
        "pnpm --filter @kn/web-app run test -- 'src/app/tasks/page.test.tsx'",
      );
      // a single test BY NAME → the runner's -t filter appended (shell-quoted) — fast iteration on one test
      expect(resolveCommand(facts, "test", "apps/web-app/src/app/tasks/page.test.tsx", undefined, "filters tasks correctly")?.command).toBe(
        "pnpm --filter @kn/web-app run test -- 'src/app/tasks/page.test.tsx' -t 'filters tasks correctly'",
      );
      // a human override template wins for cases coder can't detect
      facts.commands = { "test:file": "pnpm exec vitest run {file}" };
      expect(resolveCommand(facts, "test", "apps/web-app/x.test.tsx")?.command).toBe("pnpm exec vitest run 'apps/web-app/x.test.tsx'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pnpm-workspace.yaml wins over a stale package.json `workspaces` (precedence) — the kn-eng bug", async () => {
    const dir = await repo({
      // a stale npm-style `workspaces` names ONE package; pnpm IGNORES it. The yaml is the real list.
      "package.json": JSON.stringify({ packageManager: "pnpm@10", workspaces: ["packages/legacy"], scripts: { test: "turbo test" } }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "packages/legacy/package.json": JSON.stringify({ name: "@kn/legacy", scripts: { test: "vitest run" } }),
      "apps/web-app/package.json": JSON.stringify({ name: "@kn/web-app", scripts: { test: "vitest run" } }),
    });
    try {
      const facts = await detectProjectFacts(dir);
      const js = facts.toolchains.find((t) => t.name === "js");
      // the yaml's apps/* member — would be MISSING (only @kn/legacy) if the stale field shadowed it
      expect(js?.workspace?.map((w) => w.name)).toEqual(["@kn/web-app"]);
      // so a test file scopes to the real package's runner (fast), not the root turbo wrapper (120s)
      expect(resolveCommand(facts, "test", "apps/web-app/x.test.tsx")?.command).toBe("pnpm --filter @kn/web-app run test -- 'x.test.tsx'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("go detector: go.mod → go test/build/vet; single test is package-scoped + name-anchored", async () => {
    const dir = await repo({
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "calc/calc.go": "package calc\nfunc Add(a, b int) int { return a + b }\n",
      "calc/calc_test.go": 'package calc\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n',
    });
    try {
      const facts = await detectProjectFacts(dir);
      const go = facts.toolchains.find((t) => t.name === "go");
      expect(go?.runner).toBe("go");
      expect(go?.commands).toMatchObject({ test: "go test ./...", build: "go build ./...", lint: "go vet ./..." });
      // a test FILE → its PACKAGE dir (Go is package-scoped, not file-scoped)
      expect(resolveCommand(facts, "test", "calc/calc_test.go")?.command).toBe("go test ./calc");
      // a single test BY NAME → -run with an ANCHORED regex
      expect(resolveCommand(facts, "test", "calc/calc_test.go", undefined, "TestAdd")?.command).toBe("go test -run '^TestAdd$' ./calc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("repo-level declared commands (stack-neutral CI) resolve via script and survive", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "vitest" } }),
      "pnpm-lock.yaml": "",
      // self-hosted git + CircleCI: no GitHub, no forge baked in — the repo just declares the command.
      ".coder/facts.json": JSON.stringify({ commands: { checks: "circleci-cli pipeline status" } }),
    });
    try {
      const facts = await detectProjectFacts(dir);
      expect(resolveCommand(facts, "checks")?.command).toBe("circleci-cli pipeline status"); // declared
      expect(resolveCommand(facts, "test")?.command).toBe("pnpm run test"); // toolchain still works

      // Parameterized declared command: named `{pr}` filled from args (shell-quoted); empty → drops.
      facts.commands = { checks: "gh pr checks {pr}" };
      expect(resolveCommand(facts, "checks", undefined, { pr: "2707" })?.command).toBe("gh pr checks '2707'"); // a specific PR
      expect(resolveCommand(facts, "checks")?.command).toBe("gh pr checks"); // no args → current branch
      expect(renderFacts(facts)).toContain("checks(pr)"); // slice names the arg

      // Multiple named args, in any order.
      facts.commands = { checks: "gh pr view {pr} --repo {repo}" };
      expect(resolveCommand(facts, "checks", undefined, { repo: "kn-eng/kn-eng", pr: "2707" })?.command).toBe("gh pr view '2707' --repo 'kn-eng/kn-eng'");
      expect(renderFacts(facts)).toContain("checks(pr, repo)"); // both args named

      // INJECTION SAFETY: a malicious arg value stays one inert token; the `;` can't break out.
      facts.commands = { checks: "gh pr checks {pr}" };
      expect(resolveCommand(facts, "checks", undefined, { pr: "2707; rm -rf ~" })?.command).toBe("gh pr checks '2707; rm -rf ~'");
      // …and an injected task name (interpolated into scoped commands) is rejected outright.
      expect(resolveCommand(facts, "test; rm -rf ~", "apps/web")).toBeUndefined();
      expect(resolveCommand(facts, "nope")).toBeUndefined();
      expect(renderFacts(facts)).toContain("DECLARES these project-specific commands");
      expect(renderFacts(facts)).toContain("- checks(pr)"); // listed by name(args) for intent-selection
      const f = JSON.parse(await readFile(join(dir, ".coder", "facts.json"), "utf8"));
      expect(f.commands.checks).toBe("circleci-cli pipeline status"); // preserved across re-detect

      // A `{cmd, desc}` declared command resolves to its cmd AND advertises the description, so coder
      // selects by INTENT — no canonical role, no command name in the prompt.
      facts.commands = { "pr-checks": { cmd: "gh pr checks {pr}", desc: "list a PR's CI check status" } };
      expect(resolveCommand(facts, "pr-checks", undefined, { pr: "2704" })?.command).toBe("gh pr checks '2704'");
      expect(renderFacts(facts)).toContain("- pr-checks(pr) — list a PR's CI check status");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renderFacts is a compact pointer to the script tool, not a command dump", async () => {
    const slice = renderFacts({ toolchains: [{ name: "js", variant: "pnpm", dir: ".", commands: { typecheck: "pnpm run typecheck", migrate: "pnpm run migrate" } }] });
    expect(slice).toContain("js (pnpm)");
    expect(slice).toContain("`script` tool");
    expect(slice).not.toContain("pnpm run typecheck"); // commands live in the tool, not the prompt
  });

  test("no markers → empty facts, empty slice", async () => {
    const dir = await repo({ "README.md": "# nothing here" });
    try {
      const facts = await detectProjectFacts(dir);
      expect(facts.toolchains).toHaveLength(0);
      expect(renderFacts(facts)).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("project patterns (learned facts)", () => {
  test("persist → load → render round-trips a value and a ref, and survives re-detection", async () => {
    const dir = await repo({ "package.json": JSON.stringify({ name: "p", packageManager: "pnpm@9" }) });
    try {
      const patterns: ProjectPattern[] = [
        { key: "docs-tone", value: "concise, second-person", category: "convention", source: "user" },
        { key: "color-palette", ref: "packages/coder-docs/src/index.ts#:root", category: "design", source: "user" },
      ];
      await persistFacts(dir, { toolchains: [] }, {}, {}, patterns);

      // loadFactsFile reads them back verbatim.
      const file = await loadFactsFile(dir);
      expect(file.patterns).toHaveLength(2);

      // detectProjectFacts attaches them, and re-detection preserves them (computed is regenerated).
      const facts = await refreshProjectFacts(dir);
      expect(facts.patterns?.map((p) => p.key).sort()).toEqual(["color-palette", "docs-tone"]);
      expect(facts.toolchains.length).toBeGreaterThan(0); // computed still ran

      // renderPatterns: literal inline, ref as a POINTER (not contents).
      const slice = renderPatterns(facts);
      expect(slice).toContain("docs-tone [convention]: concise, second-person");
      expect(slice).toContain("color-palette [design] → see packages/coder-docs/src/index.ts#:root");
      expect(slice).not.toContain(":root {"); // never resolves contents into context

      // The ref persisted to disk, and re-detection didn't drop it.
      const onDisk = JSON.parse(await readFile(join(dir, ".coder", "facts.json"), "utf8"));
      expect(onDisk.patterns.find((p: ProjectPattern) => p.key === "color-palette").ref).toBe("packages/coder-docs/src/index.ts#:root");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renderPatterns is empty when there are none", async () => {
    expect(renderPatterns({ toolchains: [] })).toBe("");
  });
});
