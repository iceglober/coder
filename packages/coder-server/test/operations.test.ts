import { describe, expect, test } from "bun:test";
import type { OpSpec } from "coder-core";
import { OperationRegistry, type Operation } from "../src/operations/index.ts";

function op(spec: Partial<OpSpec> & Pick<OpSpec, "name" | "surfaces">): Operation {
  return {
    spec: { description: "", locality: "local", effect: "read", trust: "builtin", ...spec },
    run: async () => ({}),
  };
}

describe("operation registry", () => {
  test("offers only tool-surfaced operations to the model", () => {
    const reg = new OperationRegistry();
    reg.register(op({ name: "git_state", surfaces: [{ kind: "tool" }, { kind: "command", name: "git-state" }] }));
    reg.register(op({ name: "only_command", surfaces: [{ kind: "command", name: "x" }] }));
    expect(reg.tools().map((o) => o.spec.name)).toEqual(["git_state"]);
  });

  test("finds the filter bound to a tool's output (the old Extractor surface)", () => {
    const reg = new OperationRegistry();
    reg.register(op({ name: "test_summary", surfaces: [{ kind: "filter", boundTo: "bash:test" }] }));
    expect(reg.filterFor("bash:test")?.spec.name).toBe("test_summary");
    expect(reg.filterFor("bash:lint")).toBeUndefined();
  });
});
