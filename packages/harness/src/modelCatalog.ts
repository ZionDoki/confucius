import {
  isReasoningEffort,
  type ModelCatalogEntry,
  type ModelCatalogResult,
} from "@confucius/protocol";

export const MODEL_CATALOG_URL = "https://models.dev/api.json";
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 60;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function limit(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 10_000_000
    ? value
    : undefined;
}

/** Read only documented fields, never catalog-supplied URLs, headers or bodies. */
export function parseModelCatalog(payload: unknown): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const [providerId, rawProvider] of Object.entries(object(payload))) {
    const provider = object(rawProvider);
    for (const [key, value] of Object.entries(object(provider.models))) {
      const model = object(value);
      const id = typeof model.id === "string" ? model.id : key;
      if (!id.trim() || id.length > 256 || typeof model.name !== "string")
        continue;
      const limits = object(model.limit);
      const options = Array.isArray(model.reasoning_options)
        ? model.reasoning_options
        : undefined;
      const efforts: string[] = [];
      for (const option of options ?? []) {
        const raw = object(option);
        if (raw.type === "toggle") efforts.push("off", "on");
        if (raw.type === "effort" && Array.isArray(raw.values))
          for (const effort of raw.values) {
            if (effort === null || effort === "default") continue;
            if (isReasoningEffort(effort))
              efforts.push(effort === "none" ? "off" : effort);
          }
      }
      entries.push({
        providerId,
        providerName:
          typeof provider.name === "string" ? provider.name : providerId,
        id,
        name: model.name,
        contextWindowTokens: limit(limits.context, 1000),
        maxOutputTokens: limit(limits.output, 1),
        ...(options
          ? { reasoningEfforts: [...new Set(efforts)].slice(0, 32) }
          : {}),
        ...(options?.some((option) => object(option).type === "budget_tokens")
          ? { reasoningBudget: true }
          : {}),
      });
    }
  }
  return entries;
}

/** On-demand metadata lookup, kept entirely off the model request path. */
export class ModelCatalog {
  private cached?: { models: ModelCatalogEntry[]; at: number };

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<ModelCatalogResult> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (query.length > 256)
      throw new Error("Model catalog query must be at most 256 characters");
    if (!this.cached || this.now() - this.cached.at >= CACHE_MS) {
      // No endpoint address, API key, or search query is sent to models.dev.
      const response = await this.fetchImpl(MODEL_CATALOG_URL, {
        method: "GET",
        credentials: "omit",
        signal,
      });
      if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 20_000_000)
        throw new Error("Model catalog is too large");
      const models = parseModelCatalog(JSON.parse(text));
      if (!models.length)
        throw new Error("Model catalog contains no usable models");
      this.cached = { models, at: this.now() };
    }
    const q = query.trim().toLowerCase();
    const rank = (model: ModelCatalogEntry) =>
      model.id.toLowerCase() === q
        ? 0
        : model.id.toLowerCase().split("/").at(-1) === q
          ? 1
          : 2;
    const matches = this.cached.models
      .filter((model) => {
        const text =
          `${model.id} ${model.name} ${model.providerId} ${model.providerName}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          a.providerId.localeCompare(b.providerId) ||
          a.id.localeCompare(b.id),
      );
    return {
      source: MODEL_CATALOG_URL,
      models: matches.slice(0, MAX_RESULTS),
      total: matches.length,
    };
  }
}
