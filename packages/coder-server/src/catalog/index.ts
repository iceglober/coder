// Model catalog — pricing + metadata pulled from models.dev (a public, no-auth catalog of
// every provider's models), so cost is accurate per real model id instead of a stale
// hardcoded table. Fetched once, cached to ~/.coder/models.json, refreshed when stale.
// Connection still goes through the AI SDK; this is purely the price/metadata source.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SOURCE_URL = "https://models.dev/api.json";
const CACHE_PATH = join(homedir(), ".coder", "models.json");
const TTL_MS = 24 * 60 * 60 * 1000; // refresh at most daily
const FETCH_TIMEOUT_MS = 8000;

/** USD per 1M tokens, with an optional higher tier above a context size (e.g. >200k). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  over?: { size: number; input: number; output: number };
}

export interface ModelInfo {
  id: string;
  /** models.dev provider key (e.g. "google-vertex", "anthropic"). */
  provider: string;
  name?: string;
  cost?: ModelCost;
  contextLimit?: number;
  /** Can the model call tools — i.e. is it usable as a coding agent at all. */
  toolCall?: boolean;
}

// In-memory index, keyed by `${provider}/${id}` and (first-wins) bare `id`.
let memo: Map<string, ModelInfo> | null = null;

// biome-ignore lint/suspicious/noExplicitAny: models.dev JSON is external/untyped.
function parse(raw: any): Map<string, ModelInfo> {
  const map = new Map<string, ModelInfo>();
  for (const [provider, prov] of Object.entries(raw ?? {})) {
    // biome-ignore lint/suspicious/noExplicitAny: external shape.
    const models = (prov as any)?.models ?? {};
    // biome-ignore lint/suspicious/noExplicitAny: external shape.
    for (const [id, m] of Object.entries(models) as [string, any][]) {
      const c = m?.cost;
      const over = c?.context_over_200k;
      const info: ModelInfo = {
        id,
        provider,
        name: m?.name,
        contextLimit: m?.limit?.context,
        toolCall: m?.tool_call,
        cost: c
          ? {
              input: c.input,
              output: c.output,
              cacheRead: c.cache_read,
              over: over ? { size: 200_000, input: over.input, output: over.output } : undefined,
            }
          : undefined,
      };
      map.set(`${provider}/${id}`, info);
      if (!map.has(id)) map.set(id, info);
    }
  }
  return map;
}

async function fetchAndCache(): Promise<Map<string, ModelInfo> | null> {
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const raw = await res.json();
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), raw }));
    return parse(raw);
  } catch {
    return null; // offline / timeout / bad response — caller falls back
  }
}

async function loadFromDisk(): Promise<{ map: Map<string, ModelInfo>; fresh: boolean } | null> {
  try {
    const cached = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    return { map: parse(cached.raw), fresh: Date.now() - cached.fetchedAt < TTL_MS };
  } catch {
    return null;
  }
}

/**
 * Make the catalog available in memory. Never blocks on the network when a disk cache
 * exists (uses it instantly, refreshes in the background if stale). Only a first-ever run
 * with no cache waits for a fetch — and even that falls back to empty (family pricing) on
 * failure. Idempotent and cheap after the first call.
 */
export async function ensureCatalog(): Promise<void> {
  if (memo) return;
  const disk = await loadFromDisk();
  if (disk) {
    memo = disk.map;
    if (!disk.fresh) void fetchAndCache().then((m) => { if (m) memo = m; });
    return;
  }
  memo = (await fetchAndCache()) ?? new Map();
}

/** Test seam: load an explicit catalog, bypassing network/disk. */
export function _setCatalogForTest(models: ModelInfo[]): void {
  memo = new Map();
  for (const m of models) {
    memo.set(`${m.provider}/${m.id}`, m);
    if (!memo.has(m.id)) memo.set(m.id, m);
  }
}

/** Exact pricing/metadata for a model, or undefined if the catalog isn't loaded / lacks it. */
export function lookupModel(providerKey: string, modelId: string): ModelInfo | undefined {
  if (!memo) return undefined;
  return memo.get(`${providerKey}/${modelId}`) ?? memo.get(modelId);
}

/** Tool-capable models for a provider, cheapest output-price first (the ones coder can
 *  actually run as an agent). Empty if the catalog isn't loaded. */
export function listModels(providerKey: string): ModelInfo[] {
  if (!memo) return [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const info of memo.values()) {
    if (info.provider !== providerKey || seen.has(info.id) || !info.toolCall) continue;
    seen.add(info.id);
    out.push(info);
  }
  return out.sort((a, b) => (a.cost?.output ?? Infinity) - (b.cost?.output ?? Infinity));
}
