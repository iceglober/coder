import { describe, expect, test } from "bun:test";
import { flatten, type Node } from "../src/app.tsx";

const COLS = 40; // content width passed to flatten (= cols - 2 in the app)

describe("flatten — transcript rows are one physical line + markdown-styled", () => {
  test("every row is a single line within the width budget", () => {
    const nodes: Node[] = [
      { kind: "user", text: "this is a fairly long user prompt that will need to wrap across more than one line for sure" },
      { kind: "msg", text: "### A heading\n* a bullet item long enough that it has to wrap onto a second visual line here\n```\nconst x = 1;\n```\nplain `code` and **bold** text." },
    ];
    const rows = flatten(nodes, [], COLS, 0, 0);
    for (const r of rows) {
      expect(r.text.includes("\n")).toBe(false); // never multi-line
      expect(r.text.length).toBeLessThanOrEqual(COLS); // fits the content budget
    }
  });

  test("markdown roles: heading stripped, bullet marked once, fence lines are code", () => {
    const nodes: Node[] = [{ kind: "msg", text: "### Changes made\n* short bullet\n```\nfoo\n```" }];
    const rows = flatten(nodes, [], COLS, 0, 0).filter((r) => r.kind === "verdict");
    const heading = rows.find((r) => r.style === "h3");
    expect(heading?.text).toBe("Changes made"); // # stripped
    const bullets = rows.filter((r) => r.style === "bullet");
    expect(bullets[0].text.startsWith("• ")).toBe(true);
    expect(rows.some((r) => r.style === "code")).toBe(true); // fence body
    expect(rows.some((r) => r.style === "rule")).toBe(true); // the fence line → a rule
  });

  test("a wrapped bullet keeps its role with NO second marker", () => {
    const long = "this bullet is intentionally long enough to wrap across two lines so we can check the continuation";
    const rows = flatten([{ kind: "msg", text: `* ${long}` }], [], COLS, 0, 0).filter((r) => r.style === "bullet");
    expect(rows.length).toBeGreaterThan(1); // it wrapped
    expect(rows[0].text.startsWith("• ")).toBe(true);
    expect(rows.slice(1).every((r) => !r.text.includes("•"))).toBe(true); // no bullet on continuations
  });

  test("a spacer row (node -1) separates turns and gutters are color-coded", () => {
    const nodes: Node[] = [
      { kind: "user", text: "first" },
      { kind: "msg", text: "answer one" },
      { kind: "user", text: "second" },
    ];
    const rows = flatten(nodes, [], COLS, 0, 0);
    const spacer = rows.find((r) => r.kind === "spacer");
    expect(spacer?.node).toBe(-1); // never matches sel
    expect(rows.find((r) => r.kind === "user")?.gutter).toBe("user");
    expect(rows.find((r) => r.kind === "verdict")?.gutter).toBe("assistant");
    // the spacer comes before the SECOND user turn, not the first
    const firstUser = rows.findIndex((r) => r.kind === "user");
    const spacerIdx = rows.findIndex((r) => r.kind === "spacer");
    expect(spacerIdx).toBeGreaterThan(firstUser);
  });

  test("a collapsed group shows its head + verdict (tools hidden)", () => {
    const nodes: Node[] = [{ kind: "group", label: "investigating", tools: ["read_file(x)", "grep(y)"], verdict: "Found the cause.", running: false, collapsed: true }];
    const rows = flatten(nodes, [], COLS, 0, 0);
    expect(rows.find((r) => r.kind === "group-head")?.gutter).toBe("group");
    expect(rows.some((r) => r.kind === "verdict")).toBe(true); // verdict visible
    expect(rows.some((r) => r.kind === "child")).toBe(false); // tools hidden when collapsed
  });

  test("a running tool shows immediately with a spinner + live elapsed clock", () => {
    const rows = flatten([], [{ callId: "c1", label: "script(test)", start: 0 }], COLS, 0, 5000);
    const live = rows.find((r) => r.text.includes("script(test)"));
    expect(live).toBeDefined();
    expect(live?.node).toBe(-1); // transient, not selectable
    expect(live?.text).toContain("· 5s"); // now=5000, start=0 → 5s elapsed
    expect(live?.text.includes("\n")).toBe(false);
  });
});
