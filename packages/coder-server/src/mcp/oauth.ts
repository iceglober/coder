// MCP OAuth — implements the SDK's OAuthClientProvider backed by our on-disk token store. The SDK
// drives discovery → dynamic client registration → PKCE → token refresh; we supply persistence, a
// loopback redirect to catch the authorization code, and a browser opener. `loginToServer` runs the
// one-time interactive flow (used by `coder mcp login`); routine runs never reach this — they load
// the stored tokens directly via a provider with the same store.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformation, OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readServerAuth, writeServerAuth } from "./store.ts";

/** Fixed loopback port for the OAuth redirect (must match the registered redirect_uri). */
const OAUTH_PORT = Number(process.env.CODER_OAUTH_PORT) || 41100;

/** Open the system browser at `url`; best-effort (we also print the URL for headless/SSH). */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // no opener available — the printed URL is the fallback
  }
}

/**
 * An OAuthClientProvider for one server, persisting to `~/.coder/auth.json`. `interactive` controls
 * `redirectToAuthorization`: during `coder mcp login` it opens the browser; during a normal run it
 * throws, so a run never spawns a browser (the SDK surfaces it as UnauthorizedError → we skip the
 * server and tell the user to log in).
 */
export class CoderOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly server: string,
    private readonly interactive: boolean,
    /** Notified with the authorization URL when redirecting. Defaults to stderr (CLI); the TUI passes
     *  one that renders in-app so the alt-screen isn't corrupted. */
    private readonly onRedirect?: (url: string) => void,
  ) {}

  get redirectUrl(): string {
    return `http://localhost:${OAUTH_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "coder",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client; security comes from PKCE
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return (await readServerAuth(this.server)).clientInformation;
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await writeServerAuth(this.server, { clientInformation: info });
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readServerAuth(this.server)).tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await writeServerAuth(this.server, { tokens, obtainedAt: Date.now() });
  }
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await writeServerAuth(this.server, { codeVerifier });
  }
  async codeVerifier(): Promise<string> {
    const v = (await readServerAuth(this.server)).codeVerifier;
    if (!v) throw new Error("missing PKCE code verifier — re-run `coder mcp login`");
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.interactive) throw new UnauthorizedError("authorization required");
    const url = authorizationUrl.toString();
    if (this.onRedirect) this.onRedirect(url);
    else process.stderr.write(`[coder] opening your browser to authorize…\n  if it doesn't open, visit:\n  ${url}\n`);
    openBrowser(url);
  }
}

const callbackHtml = (msg: string): Response =>
  new Response(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem;text-align:center">${msg}</body>`, {
    headers: { "content-type": "text/html" },
  });

/** Start a one-route loopback server that resolves with the OAuth `code` from `/callback`. */
function startCallbackServer(): { code: Promise<string>; close: () => void } {
  let resolve!: (c: string) => void;
  let reject!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const server = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      const err = url.searchParams.get("error");
      if (err) {
        reject(new Error(`authorization failed: ${err}${url.searchParams.get("error_description") ? ` — ${url.searchParams.get("error_description")}` : ""}`));
        return callbackHtml("Authorization failed. You can close this tab.");
      }
      const c = url.searchParams.get("code");
      if (!c) {
        reject(new Error("no authorization code in callback"));
        return callbackHtml("No authorization code received.");
      }
      resolve(c);
      return callbackHtml("✓ Authorized. You can close this tab and return to the terminal.");
    },
  });
  return { code, close: () => server.stop(true) };
}

/**
 * Run the interactive OAuth flow for `server` at `url` and persist tokens. Idempotent: if valid
 * tokens already exist the initial connect succeeds and we return without a browser.
 */
export async function loginToServer(server: string, url: string, opts: { onRedirect?: (url: string) => void } = {}): Promise<void> {
  const provider = new CoderOAuthProvider(server, true, opts.onRedirect);
  const client = new Client({ name: "coder", version: "0.0.0" });
  const cb = startCallbackServer();
  try {
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));
      return; // already authorized (valid stored tokens)
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err; // a real connection error, not "needs auth"
    }
    // redirectToAuthorization already opened the browser; wait for the loopback to catch the code.
    const code = await cb.code;
    const authTransport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    await authTransport.finishAuth(code); // exchanges code → tokens (saved via provider.saveTokens)
    await client.connect(authTransport); // verify the token actually connects
  } finally {
    cb.close();
    await client.close().catch(() => {});
  }
}
