// Agent client — the host-side half of the protocol. Talks to a running coder-server:
// create a session, stream its `ServerEvent`s (SSE), send messages, answer permission
// prompts, interrupt. The TUI is built on top of this; for now a thin one-shot driver
// uses it (see index.ts). Pure transport — no rendering here.
import type { ClientMessage, ServerEvent } from "coder-core";

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly bearer: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.bearer}`, ...extra };
  }

  async createSession(): Promise<string> {
    const r = await fetch(`${this.baseUrl}/session`, { method: "POST", headers: this.headers() });
    if (!r.ok) throw new Error(`createSession failed: ${r.status} ${await r.text()}`);
    return ((await r.json()) as { sessionId: string }).sessionId;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const msg: ClientMessage = { type: "user.message", text };
    await this.post(`/session/${sessionId}/message`, msg);
  }

  async decide(sessionId: string, permissionId: string, allow: boolean): Promise<void> {
    await this.post(`/session/${sessionId}/permission/${permissionId}`, { allow });
  }

  async interrupt(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/session/${sessionId}/interrupt`, { method: "POST", headers: this.headers() });
  }

  /** Stream the session's events. Replays history on connect, then yields live events. */
  async *events(sessionId: string): AsyncGenerator<ServerEvent> {
    const r = await fetch(`${this.baseUrl}/session/${sessionId}/events`, { headers: this.headers() });
    if (!r.ok || !r.body) throw new Error(`event stream failed: ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) yield JSON.parse(line.slice(6)) as ServerEvent;
        }
      }
    } finally {
      reader.cancel().catch(() => {}); // close the SSE connection when iteration stops
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} failed: ${r.status} ${await r.text()}`);
  }
}
