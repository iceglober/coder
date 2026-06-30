import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { costOf, familyOf, preflight, resolveProvider, tierModels } from "../src/agent/models.ts";

describe("model family + pricing", () => {
  test("maps ids to families, unknown → sonnet", () => {
    expect(familyOf("claude-opus-4-8")).toBe("opus");
    expect(familyOf("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(familyOf("claude-sonnet-4-6")).toBe("sonnet");
    expect(familyOf("something-weird")).toBe("sonnet");
  });

  test("maps gemini ids to gemini families (flash-lite before flash)", () => {
    expect(familyOf("gemini-2.5-pro")).toBe("gemini-pro");
    expect(familyOf("gemini-2.5-flash")).toBe("gemini-flash");
    expect(familyOf("gemini-2.5-flash-lite")).toBe("gemini-flash-lite");
  });

  test("costOf uses per-family per-1M pricing", () => {
    // sonnet: $3/M in, $15/M out → 1M in + 1M out = 3 + 15
    expect(costOf("claude-sonnet-4-6", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(18);
    // opus: $5/M in, $25/M out
    expect(costOf("claude-opus-4-8", { promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(5);
    // gemini-flash: $0.30/M in, $2.50/M out
    expect(costOf("gemini-2.5-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(2.8);
  });

  test("every tier resolves to a model id per provider", () => {
    const vertex = tierModels("vertex")!;
    expect(vertex.deep).toContain("gemini");
    expect(vertex.mid).toContain("gemini");
    expect(vertex.fast).toContain("flash-lite");
    expect(vertex.cheap).toContain("flash-lite");

    const anthropic = tierModels("anthropic")!;
    expect(anthropic.deep).toContain("opus");
    expect(anthropic.mid).toContain("sonnet");
    expect(anthropic.fast).toContain("haiku");
  });

  test("azure has no tier defaults — addressed by deployment name instead", () => {
    expect(tierModels("azure")).toBeUndefined();
  });
});

describe("provider selection + preflight", () => {
  const MANAGED = [
    "CODER_PROVIDER",
    "CODER_MODEL",
    "ANTHROPIC_API_KEY",
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_VERTEX_LOCATION",
    "AZURE_BASE_URL",
    "AZURE_API_KEY",
    "AZURE_API_VERSION",
  ] as const;
  const saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of MANAGED) delete process.env[k];
  });

  afterEach(() => {
    for (const k of MANAGED) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("resolveProvider defaults to vertex, honors explicit anthropic/azure, ignores junk", () => {
    expect(resolveProvider(undefined)).toBe("vertex");
    expect(resolveProvider("anthropic")).toBe("anthropic");
    expect(resolveProvider("azure")).toBe("azure");
    expect(resolveProvider("bogus")).toBe("vertex");
  });

  test("anthropic preflight requires ANTHROPIC_API_KEY", () => {
    expect(preflight("anthropic")).toContain("ANTHROPIC_API_KEY");
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(preflight("anthropic")).toBeNull();
  });

  test("vertex preflight requires only project (location defaults to global)", () => {
    expect(preflight("vertex")).toContain("GOOGLE_VERTEX_PROJECT");
    // Ready with just the project — no location, no Anthropic key.
    process.env.GOOGLE_VERTEX_PROJECT = "my-proj";
    expect(preflight("vertex")).toBeNull();
    // An explicit region is fine too, but not required.
    process.env.GOOGLE_VERTEX_LOCATION = "us-east5";
    expect(preflight("vertex")).toBeNull();
  });

  test("azure preflight needs endpoint, key, and an explicit model", () => {
    expect(preflight("azure", "my-deployment")).toContain("AZURE_BASE_URL");
    process.env.AZURE_BASE_URL = "https://r.services.ai.azure.com/models";
    expect(preflight("azure", "my-deployment")).toContain("AZURE_API_KEY");
    process.env.AZURE_API_KEY = "az-test";
    // Endpoint + key present but no model named → still not ready (azure has no default).
    expect(preflight("azure")).toContain("no default model");
    expect(preflight("azure", "my-deployment")).toBeNull();
    // CODER_MODEL satisfies the model requirement without an explicit arg.
    process.env.CODER_MODEL = "my-deployment";
    expect(preflight("azure")).toBeNull();
  });
});
