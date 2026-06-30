import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "coder-core";
import { startServer } from "../src/server.ts";

// Drive the server over real HTTP. We force a deterministic outcome without a model or
// network by unsetting the provider credentials: the runner's preflight fails and emits a
// `turn.error`, which must arrive over the SSE stream. That exercises the whole path —
// routing, auth, session lifecycle, message → runner, and emit → SSE.
describe("SSE server", () => {
  let srv: { stop(): void; port: number };
  let base: string;
  let root: string;
  const saved = { provider: process.env.CODER_PROVIDER, project: process.env.GOOGLE_VERTEX_PROJECT, key: process.env.ANTHROPIC_API_KEY };

  beforeAll(async () => {
    delete process.env.CODER_PROVIDER; // default vertex …
    delete process.env.GOOGLE_VERTEX_PROJECT; // … with no project → preflight fails
    delete process.env.ANTHROPIC_API_KEY;
    root = await mkdtemp(join(tmpdir(), "coder-server-"));
    srv = startServer({ port: 0, bearer: "secret", worktreeRoot: root });
    base = `http://localhost:${srv.port}`;
  });

  afterAll(async () => {
    srv.stop();
    await rm(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries({ CODER_PROVIDER: saved.provider, GOOGLE_VERTEX_PROJECT: saved.project, ANTHROPIC_API_KEY: saved.key })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const auth = { authorization: "Bearer secret" };

  test("health needs no auth; other routes require the bearer", async () => {
    expect((await fetch(`${base}/health`)).ok).toBe(true);
    expect((await fetch(`${base}/session`, { method: "POST" })).status).toBe(401);
  });

  test("create → SSE stream → message → turn.error flows end to end", async () => {
    const created = await fetch(`${base}/session`, { method: "POST", headers: auth });
    expect(created.status).toBe(200);
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect(sessionId).toStartWith("sesn_");

    // Open the SSE stream before sending the message.
    const sse = await fetch(`${base}/session/${sessionId}/events`, { headers: auth });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();

    const sent = await fetch(`${base}/session/${sessionId}/message`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "user.message", text: "hi" }),
    });
    expect(sent.status).toBe(202);

    const event = await readUntil(reader, (e) => e.type === "turn.error");
    expect(event.type).toBe("turn.error");
    expect((event as Extract<ServerEvent, { type: "turn.error" }>).message).toContain("GOOGLE_VERTEX_PROJECT");
    await reader.cancel();
  });

  test("unknown session → 404; bad message body → 400", async () => {
    expect((await fetch(`${base}/session/sesn_nope`, { headers: auth })).status).toBe(404);
    const { sessionId } = (await (await fetch(`${base}/session`, { method: "POST", headers: auth })).json()) as { sessionId: string };
    const bad = await fetch(`${base}/session/${sessionId}/message`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "interrupt" }),
    });
    expect(bad.status).toBe(400);
  });

  test("a permission decision for an unknown id → 404", async () => {
    const { sessionId } = (await (await fetch(`${base}/session`, { method: "POST", headers: auth })).json()) as { sessionId: string };
    const r = await fetch(`${base}/session/${sessionId}/permission/perm_nope`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ allow: true }),
    });
    expect(r.status).toBe(404);
  });
});

/** Read SSE frames until `pred` matches, returning that event. */
// Structural reader type — avoids the DOM-lib vs node:stream/web ReadableStreamDefaultReader mismatch.
type ByteReader = { read(): Promise<{ value?: Uint8Array; done: boolean }> };

async function readUntil(reader: ByteReader, pred: (e: ServerEvent) => boolean): Promise<ServerEvent> {
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before a matching event");
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as ServerEvent;
      if (pred(event)) return event;
    }
  }
}
