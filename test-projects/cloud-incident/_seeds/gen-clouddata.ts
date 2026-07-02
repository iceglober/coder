#!/usr/bin/env bun
// Regenerates ops/.clouddata — the mock cloud backend cloudctl queries. Deterministic (seeded PRNG)
// so the committed shards are reproducible. Narrative: INC-407 on 2026-07-01 — deploy d-9182 cut
// payments' PAYMENT_CONNECTION_POOL 16 -> 4 at 08:55; the 09:10 traffic ramp exhausted the pool,
// charge latency blew past orders' 300ms deadline, orders 502'd, the gateway's non-idempotent retry
// doubled auth holds. Red herrings: slow analytics queries all day, inventory cold-cache warns, an
// innocent gateway deploy, and a self-resolved webhook error burst at 05:02.
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", ".clouddata");

let seed = 0x1ce9;
const rand = () => {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const jitterMs = (n: number) => Math.floor(rand() * n);

const DAY = "2026-07-01";
const ts = (h: number, m: number, s: number, ms = 0) =>
  `${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;

type Line = { ts: string; [k: string]: unknown };
const groups: Record<string, Line[]> = {
  "svc-gateway": [],
  "svc-orders": [],
  "svc-inventory": [],
  "svc-payments": [],
  "db-slowquery": [],
};
const put = (g: string, l: Line) => groups[g].push(l);

const SKUS = ["WIDGET-9", "GADGET-3", "DOODAD-7", "SPROCKET-2"];
const CARDS = ["4242", "9911", "3007", "5550", "7712"];

// Requests-per-minute profile: calm until 09:10, then the ramp.
const rpm = (h: number, m: number) => {
  if (h < 9 || (h === 9 && m < 10)) return 8 + Math.floor(rand() * 5);
  if (h === 9 && m < 30) return 55 + Math.floor(rand() * 25); // the burst window
  return 20 + Math.floor(rand() * 10);
};

let orderSeq = 5100;
let holdSeq = 41000;
for (let h = 5; h <= 9; h++) {
  for (let m = 0; m < 60; m++) {
    const incident = h === 9 && m >= 12 && m < 28; // pool exhaustion window
    const n = Math.max(1, Math.floor(rpm(h, m) / 6)); // sampled request logs per minute
    for (let i = 0; i < n; i++) {
      const s = Math.floor(rand() * 60);
      const sku = pick(SKUS);
      const qty = 1 + Math.floor(rand() * 3);
      const id = `o-${orderSeq++}`;
      const card = pick(CARDS);
      const amount = 500 + Math.floor(rand() * 9000);
      put("svc-gateway", { ts: ts(h, m, s, jitterMs(999)), service: "gateway", level: "info", msg: "checkout received", path: "/checkout", sku, qty });
      put("svc-orders", { ts: ts(h, m, s, jitterMs(999)), service: "orders", level: "info", msg: "order received", id, sku, qty });
      put("svc-inventory", { ts: ts(h, m, s, jitterMs(999)), service: "inventory", level: "info", msg: "reserved", reservationId: `res-${id}`, sku, qty, remaining: 100 + Math.floor(rand() * 300) });
      if (incident && rand() < 0.75) {
        // The failure signature: pool queueing -> charge blows the 300ms deadline -> orders 502 ->
        // gateway retries a NON-idempotent request -> a second order + a second auth hold.
        const wait = 350 + Math.floor(rand() * 900);
        put("svc-payments", { ts: ts(h, m, s, jitterMs(999)), service: "payments", level: "warn", msg: "pool exhausted — queueing", inUse: 4, pool: 4 });
        put("svc-payments", { ts: ts(h, m, s + 1, jitterMs(999)), service: "payments", level: "info", msg: "auth hold created", orderId: id, holdId: `hold-${holdSeq++}`, amountCents: amount, cardLast4: card, durationMs: wait });
        put("svc-orders", { ts: ts(h, m, s + 1, jitterMs(999)), service: "orders", level: "error", msg: "payments call timed out — releasing reservation", id, deadlineMs: 300 });
        put("svc-gateway", { ts: ts(h, m, s + 1, jitterMs(999)), service: "gateway", level: "warn", msg: "upstream timeout — retrying", attempt: 1, timeoutMs: 250, upstream: "orders" });
        const id2 = `o-${orderSeq++}`;
        put("svc-orders", { ts: ts(h, m, s + 2, jitterMs(999)), service: "orders", level: "info", msg: "order received", id: id2, sku, qty });
        put("svc-payments", { ts: ts(h, m, s + 2, jitterMs(999)), service: "payments", level: "info", msg: "auth hold created", orderId: id2, holdId: `hold-${holdSeq++}`, amountCents: amount, cardLast4: card, durationMs: 300 + Math.floor(rand() * 700), note: "same card charged moments earlier" });
        if (rand() < 0.6) {
          put("svc-gateway", { ts: ts(h, m, s + 2, jitterMs(999)), service: "gateway", level: "error", msg: "checkout failed after retries", status: 502 });
        }
      } else {
        put("svc-payments", { ts: ts(h, m, s + 1, jitterMs(999)), service: "payments", level: "info", msg: "auth hold created", orderId: id, holdId: `hold-${holdSeq++}`, amountCents: amount, cardLast4: card, durationMs: 80 + Math.floor(rand() * 60) });
        put("svc-orders", { ts: ts(h, m, s + 1, jitterMs(999)), service: "orders", level: "info", msg: "order confirmed", id });
        put("svc-gateway", { ts: ts(h, m, s + 1, jitterMs(999)), service: "gateway", level: "info", msg: "checkout forwarded", attempt: 1, status: 201 });
      }
      // Red herring: inventory cold-cache warns, steady all day.
      if (rand() < 0.12) {
        put("svc-inventory", { ts: ts(h, m, s, jitterMs(999)), service: "inventory", level: "warn", msg: "cache miss — cold read", sku, durationMs: 180 + Math.floor(rand() * 120) });
      }
    }
    // Red herring: slow analytics queries, unrelated and constant.
    if (rand() < 0.15) {
      put("db-slowquery", { ts: ts(h, m, Math.floor(rand() * 60), jitterMs(999)), db: "app", level: "warn", msg: "slow query", sql: "SELECT * FROM analytics_rollup WHERE day = ?", durationMs: 900 + Math.floor(rand() * 900) });
    }
  }
}
// Red herring: a webhook signature error burst at 05:02 that resolves itself by 05:04.
for (let i = 0; i < 14; i++) {
  put("svc-orders", { ts: ts(5, 2 + Math.floor(i / 7), Math.floor(rand() * 60), jitterMs(999)), service: "orders", level: "error", msg: "psp webhook signature invalid — dropped", webhookId: `wh-${300 + i}` });
}
put("svc-orders", { ts: ts(5, 4, 40), service: "orders", level: "info", msg: "psp webhook signatures verifying again — clock skew corrected upstream" });

// INC-412 (the needle): a single orphaned order at 07:41. The customer's card (…9911) was charged —
// payments placed the hold, inventory reserved — but the orders process was OOM-killed before it
// confirmed or released anything. Exactly one boot line marks it; nothing else that morning does.
put("svc-orders", { ts: ts(7, 41, 12, 208), service: "orders", level: "info", msg: "order received", id: "o-99117", sku: "SPROCKET-2", qty: 1 });
put("svc-inventory", { ts: ts(7, 41, 12, 344), service: "inventory", level: "info", msg: "reserved", reservationId: "res-o-99117", sku: "SPROCKET-2", qty: 1, remaining: 212 });
put("svc-payments", { ts: ts(7, 41, 12, 501), service: "payments", level: "info", msg: "auth hold created", orderId: "o-99117", holdId: "hold-77012", amountCents: 12999, cardLast4: "9911", durationMs: 96 });
put("svc-orders", { ts: ts(7, 42, 3, 90), service: "orders", level: "warn", msg: "process start — cold boot; previous instance OOM-killed", rss_mb_at_kill: 1893, pid: 22841 });

// Write hourly gz shards, sorted by time.
for (const [g, lines] of Object.entries(groups)) {
  lines.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (let h = 5; h <= 9; h++) {
    const hour = lines.filter((l) => l.ts.startsWith(`${DAY}T${String(h).padStart(2, "0")}`));
    if (!hour.length) continue;
    const dir = join(OUT, "logs", g);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${DAY}T${String(h).padStart(2, "0")}.jsonl.gz`), gzipSync(hour.map((l) => JSON.stringify(l)).join("\n")));
  }
}

writeFileSync(
  join(OUT, "deploys.json"),
  JSON.stringify(
    [
      { id: "d-9155", service: "inventory", version: "v2026.06.27-1", at: "2026-06-30T14:02:00Z", notes: "bump cache TTLs" },
      { id: "d-9168", service: "orders", version: "v2026.06.28-3", at: "2026-06-30T18:40:00Z", notes: "structured logging fields for reservations" },
      { id: "d-9170", service: "gateway", version: "v2026.06.29-1", at: "2026-07-01T06:30:00Z", notes: "static asset cache headers" },
      { id: "d-9182", service: "payments", version: "v2026.06.29-2", at: "2026-07-01T08:55:12Z", notes: "connection hygiene: reduce PAYMENT_CONNECTION_POOL 16 -> 4 to cut idle PSP connections" },
    ],
    null,
    2,
  ),
);

writeFileSync(
  join(OUT, "config.json"),
  JSON.stringify(
    {
      gateway: [{ key: "UPSTREAM_TIMEOUT_MS", history: [{ value: 250, since: "2026-05-11T00:00:00Z", deploy: "d-8801" }] }],
      orders: [{ key: "PAYMENTS_DEADLINE_MS", history: [{ value: 300, since: "2026-06-02T00:00:00Z", deploy: "d-9004" }] }],
      payments: [
        {
          key: "PAYMENT_CONNECTION_POOL",
          history: [
            { value: 16, since: "2026-03-19T00:00:00Z", deploy: "d-7719" },
            { value: 4, since: "2026-07-01T08:55:12Z", deploy: "d-9182" },
          ],
        },
        { key: "PSP_LATENCY_BUDGET_MS", history: [{ value: 100, since: "2026-03-19T00:00:00Z", deploy: "d-7719" }] },
      ],
      inventory: [{ key: "CACHE_TTL_S", history: [{ value: 900, since: "2026-06-30T14:02:00Z", deploy: "d-9155" }] }],
    },
    null,
    2,
  ),
);

// 5-minute metric buckets, 05:00–10:00.
const buckets: string[] = [];
for (let h = 5; h <= 9; h++) for (let m = 0; m < 60; m += 5) buckets.push(ts(h, m, 0).slice(0, 16) + "Z");
const metric = (f: (b: string) => number) => buckets.map((b) => ({ t: b, value: f(b) }));
const inWindow = (b: string, from: string, to: string) => b >= from && b < to;
writeFileSync(
  join(OUT, "metrics.json"),
  JSON.stringify(
    {
      gateway: { rps: metric((b) => (inWindow(b, "2026-07-01T09:10", "2026-07-01T09:30") ? 70 + Math.floor(rand() * 20) : 9 + Math.floor(rand() * 6))) },
      orders: {
        error_rate: metric((b) => (inWindow(b, "2026-07-01T09:12", "2026-07-01T09:28") ? 0.31 + rand() * 0.2 : rand() * 0.01)),
        // Corroborates INC-412: memory climbs through the early morning and resets at the 07:42 OOM kill.
        memory_rss_mb: metric((b) => {
          if (b < "2026-07-01T07:45") {
            const minutes = (Number(b.slice(11, 13)) - 5) * 60 + Number(b.slice(14, 16));
            return 240 + Math.floor(minutes * 10.2) + Math.floor(rand() * 15);
          }
          return 215 + Math.floor(rand() * 30);
        }),
      },
      payments: {
        charge_p99_ms: metric((b) => (inWindow(b, "2026-07-01T09:12", "2026-07-01T09:28") ? 2400 + Math.floor(rand() * 5600) : 140 + Math.floor(rand() * 60))),
        pool_wait_p99_ms: metric((b) => (inWindow(b, "2026-07-01T09:12", "2026-07-01T09:28") ? 900 + Math.floor(rand() * 2600) : Math.floor(rand() * 8))),
      },
      inventory: { reserve_p99_ms: metric(() => 20 + Math.floor(rand() * 25)) },
    },
    null,
    2,
  ),
);

console.log("clouddata regenerated");
