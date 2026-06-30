// MCP server config — reuses Claude Code's `.mcp.json` format verbatim, so a config that already
// works in Claude Code works here unchanged. The repo's `.mcp.json` (project root, committed) is
// merged OVER a coder-global `~/.coder/.mcp.json` (repo entries win on a name clash). We deliberately
// do NOT read Claude's private `~/.claude.json`.
//
// Entry shapes (Claude Code's):
//   stdio:  { "command": "...", "args": [...], "env": {...} }
//   remote: { "type": "http"|"sse"|"streamable-http", "url": "...", "headers": {...} }
// Plus an optional per-server "timeout" (ms). String values support ${VAR} / ${VAR:-default}.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A resolved MCP server, after type-detection and ${VAR} expansion. */
export type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string>; timeoutMs?: number }
  | { name: string; transport: "http" | "sse"; url: string; headers: Record<string, string>; timeoutMs?: number };

/** Expand ${VAR} and ${VAR:-default} from `env` (default: process.env). Unset with no default → "". */
export function expandVars(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => env[name] ?? def ?? "");
}

const expandMap = (obj: Record<string, unknown> | undefined, env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (typeof v === "string") out[k] = expandVars(v, env);
  return out;
};

// biome-ignore lint/suspicious/noExplicitAny: external/untyped .mcp.json shape.
function parseServer(name: string, raw: any, env: Record<string, string | undefined>): McpServerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const timeoutMs = typeof raw.timeout === "number" ? raw.timeout : undefined;
  // stdio: identified by `command` (Claude Code omits `type` for stdio).
  if (typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? raw.args.filter((a: unknown): a is string => typeof a === "string").map((a: string) => expandVars(a, env)) : [];
    return { name, transport: "stdio", command: expandVars(raw.command, env), args, env: expandMap(raw.env, env), timeoutMs };
  }
  // remote: needs a url. `streamable-http` is the spec name for `http` (Claude Code accepts both).
  if (typeof raw.url === "string") {
    const transport = raw.type === "sse" ? "sse" : "http"; // default url-without-type → http
    return { name, transport, url: expandVars(raw.url, env), headers: expandMap(raw.headers, env), timeoutMs };
  }
  return undefined; // malformed — skip rather than crash a run
}

// biome-ignore lint/suspicious/noExplicitAny: external JSON.
async function readJsonSafe(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined; // missing / unreadable / invalid → treated as "no config here"
  }
}

/** The two config locations, lowest-precedence first (global, then repo). */
export function mcpConfigPaths(root: string): { global: string; repo: string } {
  return { global: join(homedir(), ".coder", ".mcp.json"), repo: join(root, ".mcp.json") };
}

/** Merge two parsed `.mcp.json` documents (repo over global) into resolved configs. Pure — the
 *  filesystem-free core of `loadMcpServers`, so the precedence + expansion logic is unit-testable. */
// biome-ignore lint/suspicious/noExplicitAny: external JSON documents.
export function resolveMcpServers(global: any, repo: any, env: Record<string, string | undefined> = process.env): McpServerConfig[] {
  // biome-ignore lint/suspicious/noExplicitAny: external shape.
  const merged: Record<string, any> = { ...(global?.mcpServers ?? {}), ...(repo?.mcpServers ?? {}) }; // repo wins
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(merged)) {
    const cfg = parseServer(name, raw, env);
    if (cfg) out.push(cfg);
  }
  return out;
}

/** Load + merge MCP servers for `root`: repo `.mcp.json` over global `~/.coder/.mcp.json`. */
export async function loadMcpServers(root: string, env: Record<string, string | undefined> = process.env): Promise<McpServerConfig[]> {
  const { global, repo } = mcpConfigPaths(root);
  const [g, r] = await Promise.all([readJsonSafe(global), readJsonSafe(repo)]);
  return resolveMcpServers(g, r, env);
}

/** True when a remote server carries a usable static auth header (so OAuth is skipped, per Claude Code). */
export function hasStaticAuth(cfg: McpServerConfig): boolean {
  if (cfg.transport === "stdio") return false;
  return Object.keys(cfg.headers).some((h) => h.toLowerCase() === "authorization" && cfg.headers[h].trim() !== "");
}
