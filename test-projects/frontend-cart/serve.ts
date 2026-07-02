// Static file server for the storefront, on an ephemeral port so e2e tests are hermetic.
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

export function boot() {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      // Confine to the fixture dir.
      const path = normalize(join(ROOT, rel));
      if (!path.startsWith(ROOT)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
  return {
    server,
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
