import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { toolsForRole } from "../src/agent/tools.ts";
import { connectServers, type McpConnection } from "../src/mcp/client.ts";
import { expandVars, hasStaticAuth, resolveMcpServers } from "../src/mcp/config.ts";
import { mcpEffects, mcpToolName, mcpToolSet } from "../src/mcp/tools.ts";
import { PermissionPolicy } from "../src/permission/index.ts";

describe("mcp config", () => {
  test("expandVars: ${VAR} and ${VAR:-default}", () => {
    const env = { TOK: "secret", EMPTY: "" };
    expect(expandVars("Bearer ${TOK}", env)).toBe("Bearer secret");
    expect(expandVars("${MISSING}", env)).toBe(""); // unset, no default → empty
    expect(expandVars("${MISSING:-fallback}", env)).toBe("fallback");
    expect(expandVars("${TOK:-fallback}", env)).toBe("secret"); // set → default ignored
    expect(expandVars("${API:-https://x.com}/mcp", env)).toBe("https://x.com/mcp");
  });

  test("resolveMcpServers: detects transports, expands values, repo wins over global", () => {
    const global = {
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        shared: { type: "http", url: "https://global/mcp" },
      },
    };
    const repo = {
      mcpServers: {
        shared: { type: "http", url: "https://repo/mcp" }, // overrides global
        bearer: { type: "streamable-http", url: "https://x/mcp", headers: { Authorization: "Bearer ${TOK}" } },
        events: { type: "sse", url: "https://y/sse" },
        local: { command: "npx", args: ["-y", "${PKG}"], env: { K: "${K}" } },
        bad: { nonsense: true }, // malformed → skipped
      },
    };
    const got = resolveMcpServers(global, repo, { TOK: "t", PKG: "p-mcp", K: "v" });
    const by = Object.fromEntries(got.map((s) => [s.name, s]));

    expect(by.linear).toMatchObject({ transport: "http", url: "https://mcp.linear.app/mcp" });
    expect(by.shared).toMatchObject({ url: "https://repo/mcp" }); // repo won
    expect(by.bearer).toMatchObject({ transport: "http", headers: { Authorization: "Bearer t" } }); // alias→http + expand
    expect(by.events).toMatchObject({ transport: "sse" });
    expect(by.local).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "p-mcp"], env: { K: "v" } });
    expect(by.bad).toBeUndefined();
  });

  test("hasStaticAuth: true only when an Authorization header is set", () => {
    const [withAuth] = resolveMcpServers({}, { mcpServers: { a: { type: "http", url: "https://a", headers: { authorization: "Bearer x" } } } });
    const [noAuth] = resolveMcpServers({}, { mcpServers: { b: { type: "http", url: "https://b" } } });
    const [stdio] = resolveMcpServers({}, { mcpServers: { c: { command: "x" } } });
    expect(hasStaticAuth(withAuth)).toBe(true); // case-insensitive header name
    expect(hasStaticAuth(noAuth)).toBe(false);
    expect(hasStaticAuth(stdio)).toBe(false);
  });
});

describe("mcp tool adapter", () => {
  const conn = (): McpConnection => ({
    server: "linear",
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake client.
    client: {
      callTool: async (p: { name: string; arguments?: unknown }) => {
        if (p.name === "boom") throw new Error("kaboom");
        if (p.name === "fail") return { content: [{ type: "text", text: "nope" }], isError: true };
        return { content: [{ type: "text", text: `ok:${p.name}:${JSON.stringify(p.arguments)}` }] };
      },
    } as any,
    tools: [
      { name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
      { name: "boom", inputSchema: { type: "object" } },
      { name: "fail", inputSchema: { type: "object" } },
    ],
  });

  // biome-ignore lint/suspicious/noExplicitAny: tool execute options stub.
  const run = (set: ToolSet, key: string, args: unknown) => (set[key] as any).execute(args, { toolCallId: "1", messages: [] });

  test("keys are server__tool; execute passes args through and renders text", async () => {
    const set = mcpToolSet([conn()]);
    expect(Object.keys(set).sort()).toEqual(["linear__boom", "linear__create_issue", "linear__fail"]);
    expect(await run(set, mcpToolName("linear", "create_issue"), { title: "x" })).toBe('ok:create_issue:{"title":"x"}');
  });

  test("execute surfaces tool errors and thrown errors as strings (never throws)", async () => {
    const set = mcpToolSet([conn()]);
    expect(await run(set, "linear__fail", {})).toBe("error: nope"); // isError result
    expect(await run(set, "linear__boom", {})).toBe("error: kaboom"); // thrown
  });

  test("mcpEffects marks every MCP tool write", () => {
    const eff = mcpEffects([conn()]);
    expect(eff.get("linear__create_issue")).toBe("write");
    expect([...eff.values()].every((e) => e === "write")).toBe(true);
  });
});

describe("mcp connect", () => {
  test("a server that fails to spawn becomes a warning, not needsAuth, and never throws", async () => {
    const [bad] = resolveMcpServers({}, { mcpServers: { bad: { command: "coder-nonexistent-mcp-xyz" } } });
    const { connections, needsAuth, warnings, close } = await connectServers([bad]);
    expect(connections).toEqual([]);
    expect(needsAuth).toEqual([]); // spawn failure ≠ auth required
    expect(warnings.some((w) => w.includes("bad"))).toBe(true);
    await close();
  });
});

describe("mcp gating", () => {
  const all = { linear__create_issue: {}, read_file: {} } as unknown as ToolSet;
  const effects = new Map<string, "read" | "verify" | "write">([["linear__create_issue", "write"]]);

  test("read-only investigator drops write-effect MCP tools", () => {
    const inv = toolsForRole(all, "investigate", effects);
    expect("linear__create_issue" in inv).toBe(false); // write → excluded
    expect("read_file" in inv).toBe(true); // built-in read → kept
    expect("linear__create_issue" in toolsForRole(all, "full", effects)).toBe(true);
  });

  test("PermissionPolicy gates MCP tools by their effect under each posture", () => {
    const decide = (mode: "auto" | "ask" | "plan") => new PermissionPolicy({ mode, effects }).decide("linear__create_issue");
    expect(decide("auto")).toBe("auto");
    expect(decide("ask")).toBe("ask"); // write → ask
    expect(decide("plan")).toBe("deny"); // write → denied in read-only
  });
});
