// coder-server — barrel + entry. Wires the efficiency engine: Router → context budget →
// AI SDK loop, with Capabilities/Extractors, Succinctness, Ledger, telemetry, Distiller.
export * from "./server.ts";
export * from "./runner.ts";
export * from "./router/index.ts";
export * from "./operations/index.ts";
export * from "./permission/index.ts";
export * from "./succinctness/index.ts";
export * from "./context/manager.ts";
export * from "./context/compact.ts";
export * from "./catalog/index.ts";
export * from "./project/facts.ts";
export * from "./ledger/index.ts";
export * from "./tools/index.ts";
export * from "./sandbox/index.ts";
export * from "./sandbox/docker.ts";
export * from "./sandbox/resources.ts";
export * as telemetry from "./telemetry/otel.ts";
export * as analytics from "./telemetry/counted.ts";
export * as distiller from "./distiller/index.ts";

// Direct-run entry (sandboxed, headless). `coder --once` drives this in P1.
if (import.meta.main) {
  const port = Number(process.env.CODER_PORT ?? 4123);
  const { startServer } = await import("./server.ts");
  startServer({
    port,
    bearer: process.env.CODER_BEARER ?? "dev",
    worktreeRoot: process.env.CODER_WORKTREE ?? process.cwd(),
  });
  console.error(`coder-server listening on :${port}`);
}
