// Model + price resolution. Tiers map to concrete model ids per provider; a small price
// table by family powers the Ledger receipt. Three providers via the Vercel AI SDK —
// Google Vertex AI serving Gemini (default), Anthropic-direct serving Claude, or Azure AI
// Foundry via its OpenAI-compatible inference endpoint.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Tier } from "coder-core";
import { lookupModel } from "../catalog/index.ts";

/** Where the model is served from — and, with it, which model family runs. */
export type Provider = "vertex" | "anthropic" | "azure";

/**
 * Tier → concrete model id, for the providers that have canonical model ids. Vertex runs
 * Google's Gemini; Anthropic-direct runs Claude. The ids are provider-specific (Vertex's
 * Gemini ids share nothing with Anthropic's Claude ids), so the map is keyed by provider.
 *
 * Azure is deliberately absent: Azure AI Foundry addresses models by the *deployment name*
 * you pick, not a portable id, so there's no sensible default — callers must name the model
 * via CODER_MODEL / --model (enforced in `preflight`).
 */
const TIER_MODELS_BY_PROVIDER: Record<Exclude<Provider, "azure">, Record<Tier, string>> = {
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

/** Tier → model id for a provider, or undefined for a provider with no canonical ids (azure). */
export function tierModels(provider: Provider): Record<Tier, string> | undefined {
  return provider === "azure" ? undefined : TIER_MODELS_BY_PROVIDER[provider];
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
const CATALOG_KEY: Record<Provider, string> = { vertex: "google-vertex", anthropic: "anthropic", azure: "azure" };

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
  if (value === "anthropic") return "anthropic";
  if (value === "azure") return "azure";
  return "vertex";
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
 * Build provider options for Azure AI Foundry's OpenAI-compatible inference endpoint. The
 * endpoint URL and key come from the environment; Azure endpoints generally require an
 * `api-version`, so we pass `AZURE_API_VERSION` through as a query param when it's set.
 */
function azureOptions(): { name: string; baseURL: string; apiKey?: string; queryParams?: Record<string, string> } {
  const apiVersion = process.env.AZURE_API_VERSION;
  return {
    name: "azure",
    baseURL: process.env.AZURE_BASE_URL ?? "",
    apiKey: process.env.AZURE_API_KEY,
    ...(apiVersion ? { queryParams: { "api-version": apiVersion } } : {}),
  };
}

/**
 * Check provider credentials before a run so callers can surface a clear, actionable
 * error instead of a mid-stream SDK failure. Returns null when ready. `modelId` (falling
 * back to CODER_MODEL) only matters for azure, which has no default model.
 *   - vertex:    GCP application default credentials + GOOGLE_VERTEX_PROJECT
 *               (GOOGLE_VERTEX_LOCATION optional; defaults to global)
 *   - anthropic: ANTHROPIC_API_KEY
 *   - azure:     AZURE_BASE_URL + AZURE_API_KEY + an explicit model (the deployment name)
 */
export function preflight(provider: Provider, modelId = process.env.CODER_MODEL): string | null {
  if (provider === "vertex") {
    if (!process.env.GOOGLE_VERTEX_PROJECT) {
      return "Google Vertex provider needs GOOGLE_VERTEX_PROJECT set (auth via gcloud application-default credentials; GOOGLE_VERTEX_LOCATION optional, defaults to global)";
    }
    return null;
  }
  if (provider === "azure") {
    if (!process.env.AZURE_BASE_URL) {
      return "Azure provider needs AZURE_BASE_URL set (your Azure AI Foundry OpenAI-compatible endpoint, e.g. https://<resource>.services.ai.azure.com/models)";
    }
    if (!process.env.AZURE_API_KEY) return "Azure provider needs AZURE_API_KEY set";
    if (!modelId) return "Azure provider has no default model — set CODER_MODEL or pass --model with your Foundry deployment name";
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
 * Resolve a runnable model. `modelId` (or CODER_MODEL) wins over `tier`; `provider` (or
 * CODER_PROVIDER) selects where it runs and which family. Callers preflight first. Vertex
 * reads its project/location from GOOGLE_VERTEX_* env and authenticates with GCP application
 * default credentials; azure reads AZURE_* env and hits an OpenAI-compatible endpoint; only
 * anthropic uses an API key argument. Azure has no tier default, so a model id is required.
 */
export function resolveModel(opts: { tier: Tier; modelId?: string; provider?: Provider; apiKey?: string }): ResolvedModel {
  const provider = opts.provider ?? resolveProvider();
  const modelId = opts.modelId ?? process.env.CODER_MODEL ?? tierModels(provider)?.[opts.tier];
  if (!modelId) throw new Error(`No model id for provider "${provider}" — set CODER_MODEL or pass --model (azure has no default).`);
  const model =
    provider === "vertex"
      ? createVertex(vertexOptions()).languageModel(modelId)
      : provider === "azure"
        ? createOpenAICompatible(azureOptions()).languageModel(modelId)
        : createAnthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY }).languageModel(modelId);
  return { model, modelId, family: familyOf(modelId), provider };
}
