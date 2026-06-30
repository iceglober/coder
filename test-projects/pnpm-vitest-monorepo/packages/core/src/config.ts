// Operational config. The LIVE values are stored in the operational database (table `config` in
// ops/app.db) — this in-code map is only a fallback for local dev. To see what is ACTUALLY configured
// in a given environment, query the database, not this file (production overrides these defaults).
const devFallback: Record<string, number> = {
  max_order_cents: 1_000_000, // $10,000 in local dev — production sets a much lower limit in the DB
  max_cart_items: 100,
};

export function getConfig(key: string): number {
  return devFallback[key];
}
