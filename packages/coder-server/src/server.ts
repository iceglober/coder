// HTTP/SSE server — the agent server the host TUI connects to. Bun.serve with bearer auth
// (the one privileged thing the client reaches). It owns session state and drives the
// runner: a client creates a session, opens an SSE event stream, and POSTs messages; the
// runner's `emit` events are broadcast to that session's subscribers as SSE frames.
import type { ModelMessage } from "ai";
import { Routes, type ClientMessage, type ServerEvent } from "coder-core";
import { runOnce } from "./runner.ts";

export interface ServerOptions {
  port: number;
  /** Shared bearer token for the host↔sandbox handshake. */
  bearer: string;
  worktreeRoot: string;
}

/** Encode a protocol event as an SSE frame. */
export function sseFrame(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

type Listener = (event: ServerEvent) => void;

/** One interaction with the agent: event history + live subscribers + the active run. */
class Session {
  status: "idle" | "running" = "idle";
  /** Append-only event history, replayed to late subscribers so they don't miss a thing. */
  readonly history: ServerEvent[] = [];
  /** Aborts the in-flight run (interrupt). Fresh per message. */
  ac?: AbortController;
  /** Tool-approval decisions the agent is blocked on: permissionId → settle(allow). */
  readonly pendingPermissions = new Map<string, (allow: boolean) => void>();
  /** Accumulated conversation, so each turn has the context of prior ones. */
  messages: ModelMessage[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(readonly id: string) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(event: ServerEvent): void {
    this.history.push(event);
    for (const fn of this.listeners) fn(event);
    if (event.type === "turn.idle" || event.type === "turn.error") this.status = "idle";
  }

  /**
   * Ask the client to approve a mutating tool, and block the agent until it answers.
   * Emits `permission.required`, returns a Promise the decision route (or an interrupt)
   * resolves. The id-keyed `settle` is how an async HTTP reply wakes a paused `await`.
   */
  requestPermission(tool: string, preview: string): Promise<boolean> {
    const permissionId = `perm_${crypto.randomUUID()}`;
    return new Promise<boolean>((resolve) => {
      const settle = (allow: boolean) => {
        if (this.pendingPermissions.delete(permissionId)) resolve(allow);
      };
      this.pendingPermissions.set(permissionId, settle);
      this.ac?.signal.addEventListener("abort", () => settle(false), { once: true }); // interrupt → deny
      this.broadcast({ type: "permission.required", sessionId: this.id, permissionId, tool, preview });
    });
  }
}

class Sessions {
  private readonly map = new Map<string, Session>();

  create(): Session {
    const session = new Session(`sesn_${crypto.randomUUID()}`);
    this.map.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.map.get(id);
  }
}

/** How often to ping an idle SSE connection (keeps it under the server idle timeout). */
const HEARTBEAT_MS = 5000;

/** SSE response: replay history, then stream live events until the client disconnects.
 *  A periodic heartbeat comment keeps the connection alive while the user is typing
 *  between turns (otherwise the server's idle timeout closes it). */
function sseResponse(session: Session): Response {
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: string) => {
        try {
          controller.enqueue(enc.encode(frame));
        } catch {
          cleanup(); // controller closed (client gone)
        }
      };
      send(": ok\n\n"); // flush headers so the client connects now
      for (const event of session.history) send(sseFrame(event));
      unsubscribe = session.subscribe((event) => send(sseFrame(event)));
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

/** Kick off a run in the background; progress streams to the session's subscribers. */
function startRun(session: Session, task: string, worktreeRoot: string): void {
  session.status = "running";
  session.ac = new AbortController();
  void runOnce({
    task,
    root: worktreeRoot,
    sessionId: session.id,
    emit: (event) => session.broadcast(event),
    signal: session.ac.signal,
    requestPermission: (tool, preview) => session.requestPermission(tool, preview),
    history: session.messages,
  })
    .then((res) => {
      if (res.messages) session.messages = res.messages; // remember this turn for the next
    })
    .catch((err) => {
      session.broadcast({
        type: "turn.error",
        sessionId: session.id,
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      session.status = "idle";
    });
}

export function startServer(opts: ServerOptions): { stop(): void; port: number } {
  const sessions = new Sessions();
  const server = Bun.serve({
    port: opts.port,
    idleTimeout: 255, // SSE streams are long-lived; heartbeats keep them under this cap
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // ["session", id, "events"]

      if (url.pathname === Routes.health) {
        return Response.json({ ok: true, worktree: opts.worktreeRoot });
      }

      if (req.headers.get("authorization") !== `Bearer ${opts.bearer}`) {
        return new Response("unauthorized", { status: 401 });
      }

      // POST /session — create a session.
      if (req.method === "POST" && parts.length === 1 && parts[0] === "session") {
        const session = sessions.create();
        return Response.json({ sessionId: session.id, status: session.status });
      }

      // /session/:id/...
      if (parts[0] === "session" && parts[1]) {
        const session = sessions.get(parts[1]);
        if (!session) return new Response("no such session", { status: 404 });
        const sub = parts[2];

        if (req.method === "GET" && !sub) {
          return Response.json({ sessionId: session.id, status: session.status });
        }

        if (req.method === "GET" && sub === "events") {
          return sseResponse(session);
        }

        if (req.method === "POST" && sub === "message") {
          if (session.status === "running") return new Response("session is busy", { status: 409 });
          let msg: ClientMessage;
          try {
            msg = (await req.json()) as ClientMessage;
          } catch {
            return new Response("invalid JSON body", { status: 400 });
          }
          if (msg.type !== "user.message") {
            return new Response("expected a user.message", { status: 400 });
          }
          startRun(session, msg.text, opts.worktreeRoot);
          return Response.json({ status: "accepted" }, { status: 202 });
        }

        if (req.method === "POST" && sub === "interrupt") {
          session.ac?.abort();
          return Response.json({ status: "interrupting" });
        }

        // POST /session/:id/permission/:pid  body {allow: bool} — resolve a pending approval.
        if (req.method === "POST" && sub === "permission" && parts[3]) {
          const settle = session.pendingPermissions.get(parts[3]);
          if (!settle) return new Response("no such pending permission", { status: 404 });
          let allow = false; // deny on a missing/garbled body — the safe default
          try {
            allow = ((await req.json()) as { allow?: boolean }).allow === true;
          } catch {
            // keep deny
          }
          settle(allow);
          return Response.json({ status: allow ? "allowed" : "denied" });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { stop: () => server.stop(true), port: server.port ?? opts.port };
}
