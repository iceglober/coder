// MCP client — connects to the configured servers and exposes their tool lists. Routine runs call
// `connectServers`; it never opens a browser. A server that needs OAuth but has no stored token (or
// an unrefreshable one) surfaces as an UnauthorizedError, which we turn into a warning telling the
// user to run `coder mcp login <name>` — the run continues with the other servers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { hasStaticAuth, type McpServerConfig } from "./config.ts";
import { CoderOAuthProvider } from "./oauth.ts";

/** A tool as advertised by a server (name + JSON-Schema input), enough to adapt into an AI SDK tool. */
export interface McpToolDef {
  name: string;
  description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema from the server, validated by the SDK.
  inputSchema?: any;
}

export interface McpConnection {
  server: string;
  client: Client;
  tools: McpToolDef[];
}

/** A remote server config (has a `url`) — the only kind that can need OAuth. */
export type RemoteServerConfig = Extract<McpServerConfig, { transport: "http" | "sse" }>;

export interface ConnectedMcp {
  /** Connected servers. Mutable — a server authorized mid-run is pushed here (and `close` covers it). */
  connections: McpConnection[];
  /** Servers that need OAuth (returned 401/403 with no usable token) — offer the user a login. */
  needsAuth: RemoteServerConfig[];
  /** Hard failures (not auth) to surface to the user; never throws. */
  warnings: string[];
  /** Disconnect every connected client. Best-effort. */
  close(): Promise<void>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function makeTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    Object.assign(env, cfg.env); // declared env wins
    return new StdioClientTransport({ command: cfg.command, args: cfg.args, env });
  }
  const url = new URL(cfg.url);
  // Static Authorization header wins (Claude Code: no OAuth fallback when a header is set).
  if (hasStaticAuth(cfg)) {
    const requestInit = { headers: cfg.headers };
    return cfg.transport === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
  }
  // Otherwise drive OAuth from stored tokens (non-interactive — no browser during a run).
  const authProvider = new CoderOAuthProvider(cfg.name, false);
  return cfg.transport === "sse" ? new SSEClientTransport(url, { authProvider }) : new StreamableHTTPClientTransport(url, { authProvider });
}

/** Connect to one server and list its tools. Throws on failure (UnauthorizedError when it needs
 *  OAuth). Used by `connectServers` and to reconnect a server right after an in-session login. */
export async function connectOne(cfg: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "coder", version: "0.0.0" });
  try {
    await client.connect(makeTransport(cfg));
    const { tools } = await client.listTools();
    return { server: cfg.name, client, tools };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

/** Connect to every configured server in parallel. Failures become warnings / needsAuth, not throws. */
export async function connectServers(configs: McpServerConfig[]): Promise<ConnectedMcp> {
  const connections: McpConnection[] = [];
  const needsAuth: RemoteServerConfig[] = [];
  const warnings: string[] = [];

  await Promise.all(
    configs.map(async (cfg) => {
      try {
        connections.push(await connectOne(cfg));
      } catch (err) {
        if (err instanceof UnauthorizedError && cfg.transport !== "stdio") needsAuth.push(cfg);
        else warnings.push(`MCP "${cfg.name}" failed to connect: ${msg(err)}`);
      }
    }),
  );

  return {
    connections,
    needsAuth,
    warnings,
    // Iterates `connections` (not a captured list) so a server authorized + pushed mid-run is closed too.
    close: async () => {
      await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
    },
  };
}
