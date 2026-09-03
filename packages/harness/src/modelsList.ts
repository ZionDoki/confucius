import {
  describeNonJsonModelBody,
  detectApiStyle,
  normalizeOpenAICompatibleBaseUrl,
  type ApiStyle,
} from "./OpenAICompatibleAdapter";

export const MAX_LISTED_MODELS = 200;

export interface ListModelsInput {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export interface ListModelsResult {
  models: string[];
  error?: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Resolve the provider catalog URL for an endpoint Base URL. */
export function modelsListRequest(baseUrl: string): {
  url: string;
  style: ApiStyle;
} {
  const trimmed = baseUrl.trim();
  const style = detectApiStyle(trimmed);
  if (style === "ollama") {
    const replaced = trimmed.replace(/\/api\/chat\/?$/, "/api/tags");
    if (replaced !== trimmed) {
      return { url: replaced, style };
    }
    try {
      const parsed = new URL(trimmed);
      parsed.pathname = "/api/tags";
      parsed.search = "";
      parsed.hash = "";
      return { url: parsed.toString(), style };
    } catch {
      return { url: joinUrl(trimmed, "/api/tags"), style };
    }
  }
  const root = normalizeOpenAICompatibleBaseUrl(trimmed);
  return { url: joinUrl(root, "/models"), style };
}

export function parseModelsList(style: ApiStyle, payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const names: string[] = [];
  if (style === "ollama") {
    const models = (payload as { models?: unknown }).models;
    if (Array.isArray(models)) {
      for (const entry of models) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const row = entry as { name?: unknown; model?: unknown };
        const name = String(row.name ?? row.model ?? "").trim();
        if (name) {
          names.push(name);
        }
      }
    }
  } else {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === "string") {
          const name = entry.trim();
          if (name) {
            names.push(name);
          }
          continue;
        }
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const row = entry as { id?: unknown; name?: unknown };
        const name = String(row.id ?? row.name ?? "").trim();
        if (name) {
          names.push(name);
        }
      }
    }
  }
  return names.slice(0, MAX_LISTED_MODELS);
}

/** Keep the saved model first, then unique catalog names in provider order. */
export function mergeModelChoices(saved: string, listed: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };
  push(saved);
  for (const name of listed) {
    push(name);
  }
  return out;
}

export async function listEndpointModels(
  endpoint: ListModelsInput,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ListModelsResult> {
  const saved = endpoint.model ?? "";
  if (!endpoint.baseUrl.trim()) {
    return {
      models: mergeModelChoices(saved, []),
      error: "Base URL is empty",
    };
  }
  const { url, style } = modelsListRequest(endpoint.baseUrl);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey ?? ""}`,
      },
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        models: mergeModelChoices(saved, []),
        error: `HTTP ${response.status}: ${text.slice(0, 180)}`,
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return {
        models: mergeModelChoices(saved, []),
        error: describeNonJsonModelBody("list", text),
      };
    }
    return {
      models: mergeModelChoices(saved, parseModelsList(style, payload)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted =
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError");
    return {
      models: mergeModelChoices(saved, []),
      error: aborted ? "Timed out listing models" : message,
    };
  }
}
