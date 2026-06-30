// Model + price resolution. Tiers map to concrete model ids per provider; a small price
// table by family powers the Ledger receipt. Two providers via the Vercel AI SDK —
// Google Vertex AI serving Gemini (default), or Anthropic-direct serving Claude.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import type { LanguageModel } from "ai";
import type { Tier } from "coder-core";
import { lookupModel } from "../catalog/index.ts";

/** Where the model is served from — and, with it, which model family runs. */
export type Provider = "vertex" | "anthropic";

/**
 * Tier → concrete model id, per provider. Vertex runs Google's Gemini; Anthropic-direct
 * runs Claude. The ids are provider-specific (Vertex's Gemini ids share nothing with
 * Anthropic's Claude ids), so the map is keyed by provider, not global.
 */
const TIER_MODELS_BY_PROVIDER: Record<Provider, Record<Tier, string>> = {
  vertex: {
    deep: "gemini-2.5-pro",
    mid: "gemini-2.5-flash",
    fast: "gemini-2.5-flash-lite",
    cheap: "gemini-2.5-flash-lite",
  },
  anthropic: {
    deep: "claude-opus-4-8",
    mid: "claude-sonnet-4-6",
    fast: "claude-haiku-4-5-20251001",
    cheap: "claude-haiku-4-5-20251001",
  },
};

/** Tier → model id for a given provider. */
export function tierModels(provider: Provider): Record<Tier, string> {
  return TIER_MODELS_BY_PROVIDER[provider];
}

/** USD per 1M tokens, keyed by model family. A receipt estimate, not a billed figure. */
export type Family = "opus" | "sonnet" | "haiku" | "gemini-pro" | "gemini-flash" | "gemini-flash-lite";
export const PRICES: Record<Family, { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  "gemini-pro": { input: 1.25, output: 10 },
  "gemini-flash": { input: 0.3, output: 2.5 },
  "gemini-flash-lite": { input: 0.1, output: 0.4 },
};

/** Map a model id to its pricing family; unknown Claude-ish ids fall back to sonnet. */
export function familyOf(modelId: string): Family {
  const id = modelId.toLowerCase();
  if (id.includes("gemini")) {
    if (id.includes("flash-lite")) return "gemini-flash-lite";
    if (id.includes("flash")) return "gemini-flash";
    return "gemini-pro";
  }
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  return "sonnet";
}

/** models.dev provider key for our Provider (where the catalog indexes pricing). */
const CATALOG_KEY: Record<Provider, string> = { vertex: "google-vertex", anthropic: "anthropic" };

/**
 * Cost in USD from token usage. Prefers exact pricing from the models.dev catalog (honoring
 * the higher >200k-context tier); falls back to the hardcoded family table when the catalog
 * isn't loaded or lacks the model. Pass `provider` to hit the catalog — a receipt estimate,
 * not a billed figure. (Catalog load: see `ensureCatalog` in catalog/index.ts.)
 */
export function costOf(
  modelId: string,
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number },
  provider?: Provider,
): number {
  const cached = usage.cachedTokens ?? 0;
  const fresh = Math.max(0, usage.promptTokens - cached); // cached prefix is billed cheaper
  const cost = provider ? lookupModel(CATALOG_KEY[provider], modelId)?.cost : undefined;
  if (cost) {
    const tier = cost.over && usage.promptTokens > cost.over.size ? cost.over : cost;
    const cacheRate = cost.cacheRead ?? tier.input;
    return (fresh * tier.input + cached * cacheRate + usage.completionTokens * tier.output) / 1_000_000;
  }
  const p = PRICES[familyOf(modelId)];
  return (usage.promptTokens * p.input + usage.completionTokens * p.output) / 1_000_000;
}

/** Resolve the active provider from `CODER_PROVIDER`; default Vertex (Gemini). */
export function resolveProvider(value = process.env.CODER_PROVIDER): Provider {
  return value === "anthropic" ? "anthropic" : "vertex";
}

/** Vertex location when GOOGLE_VERTEX_LOCATION is unset. `global` serves the superset of
 *  Gemini models (verified: 2.5 + 3.x both resolve there), so switching models never hits a
 *  region-availability wall. The baseURL override below makes the global endpoint work. */
export const DEFAULT_VERTEX_LOCATION = "global";

/**
 * Build provider options for the Vercel AI SDK's Vertex (Gemini) provider.
 *
 * The v5 provider handles `global` natively (bare `aiplatform.googleapis.com` +
 * `locations/global`) on the `/v1beta1` API. We deliberately do NOT override `baseURL`: the
 * old `/v1` override broke multi-turn function calling (Vertex rejected the function-call
 * `id` field, which only `/v1beta1` accepts).
 */
function vertexOptions(): { project?: string; location: string } {
  return {
    project: process.env.GOOGLE_VERTEX_PROJECT,
    location: process.env.GOOGLE_VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION,
  };
}

/**
 * Check provider credentials before a run so callers can surface a clear, actionable
 * error instead of a mid-stream SDK failure. Returns null when ready.
 *   - vertex:    GCP application default credentials + GOOGLE_VERTEX_PROJECT
 *               (GOOGLE_VERTEX_LOCATION optional; defaults to us-central1)
 *   - anthropic: ANTHROPIC_API_KEY
 */
export function preflight(provider: Provider): string | null {
  if (provider === "vertex") {
    if (!process.env.GOOGLE_VERTEX_PROJECT) {
      return "Google Vertex provider needs GOOGLE_VERTEX_PROJECT set (auth via gcloud application-default credentials; GOOGLE_VERTEX_LOCATION optional, defaults to us-central1)";
    }
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY is not set";
  return null;
}

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  family: Family;
  provider: Provider;
}

/**
 * Resolve a runnable model. `modelId` (or CODER_MODEL upstream) wins over `tier`;
 * `provider` (or CODER_PROVIDER) selects where it runs and which family. Callers
 * preflight first. Vertex reads its project/location from GOOGLE_VERTEX_* env and
 * authenticates with GCP application default credentials — no Anthropic API key.
 */
export function resolveModel(opts: { tier: Tier; modelId?: string; provider?: Provider; apiKey?: string }): ResolvedModel {
  const provider = opts.provider ?? resolveProvider();
  const modelId = opts.modelId ?? tierModels(provider)[opts.tier];
  const model =
    provider === "vertex"
      ? createVertex(vertexOptions()).languageModel(modelId)
      : createAnthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY }).languageModel(modelId);
  return { model, modelId, family: familyOf(modelId), provider };
}
