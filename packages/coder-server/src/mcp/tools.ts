// Adapt MCP tools into AI SDK tools. Each remote tool becomes a `dynamicTool` (its schema is only
// known at runtime) keyed `"<server>__<tool>"`, mirroring how operationTool wraps a deterministic op
// (operations/index.ts). Tools default to the `write` effect — they reach the network with the user's
// credentials — so the role filter and permission policy treat them like other mutating tools.
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { Effect } from "coder-core";
import type { McpConnection } from "./client.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Default effect for MCP tools: network + credentials → treat as a write (gated, dropped from the
 *  read-only investigator). A future refinement can mark obviously read-only tools as `read`. */
export const MCP_DEFAULT_EFFECT: Effect = "write";

/** The fully-qualified tool name for a server's tool, as the model sees it. */
export const mcpToolName = (server: string, tool: string): string => `${server}__${tool}`;

// biome-ignore lint/suspicious/noExplicitAny: CallToolResult shape from the SDK.
function renderToolResult(res: any): string {
  const blocks: unknown[] = Array.isArray(res?.content) ? res.content : [];
  const text = blocks
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous content blocks.
    .map((c: any) => (c?.type === "text" ? c.text : c?.type === "resource" ? JSON.stringify(c.resource) : `[${c?.type ?? "content"}]`))
    .join("\n");
  if (res?.isError) return `error: ${text || "tool reported an error"}`;
  if (text) return text;
  return res?.structuredContent ? JSON.stringify(res.structuredContent) : "(no output)";
}

/** Build the AI SDK ToolSet for every connected server's tools. */
export function mcpToolSet(connections: McpConnection[]): ToolSet {
  const set: ToolSet = {};
  for (const conn of connections) {
    for (const t of conn.tools) {
      set[mcpToolName(conn.server, t.name)] = dynamicTool({
        description: t.description ?? `${conn.server}: ${t.name}`,
        inputSchema: jsonSchema(t.inputSchema ?? { type: "object", properties: {} }),
        execute: async (args: unknown) => {
          try {
            const res = await conn.client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> });
            return renderToolResult(res);
          } catch (err) {
            return `error: ${msg(err)}`;
          }
        },
      });
    }
  }
  return set;
}

/** Effect map for the connected MCP tools (all `write` by default) — feeds role filtering + gating. */
export function mcpEffects(connections: McpConnection[]): Map<string, Effect> {
  const m = new Map<string, Effect>();
  for (const conn of connections) for (const t of conn.tools) m.set(mcpToolName(conn.server, t.name), MCP_DEFAULT_EFFECT);
  return m;
}
