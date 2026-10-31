import { describeNonJsonModelBody } from "./OpenAICompatibleAdapter";
import {
  modelApiHeaders,
  modelApiUrl,
  resolveModelProtocol,
  type ModelApiProtocol,
  type ResolvedModelProtocol,
} from "@confucius/protocol";

export const MAX_LISTED_MODELS = 200;

export interface ListModelsInput {
  baseUrl: string;
  protocol?: ModelApiProtocol;
  apiKey?: string;
  model?: string;
}

export interface ListModelsResult {
  models: string[];
  error?: string;
}

/** Resolve the provider catalog URL for an endpoint Base URL. */
export function modelsListRequest(
  baseUrl: string,
  protocol?: ModelApiProtocol,
): {
  url: string;
  style: ResolvedModelProtocol;
} {
  const style = resolveModelProtocol(baseUrl, protocol);
  const url = new URL(
    modelApiUrl(baseUrl, style, style === "ollama" ? "/api/tags" : "/models"),
  );
  if (style === "gemini") {
    url.searchParams.delete("alt");
    url.searchParams.set("pageSize", String(MAX_LISTED_MODELS));
  }
  return { url: url.toString(), style };
}

export function parseModelsList(
  style: ResolvedModelProtocol,
  payload: unknown,
): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const names: string[] = [];
  if (style === "ollama" || style === "gemini") {
    const models = (payload as { models?: unknown }).models;
    if (Array.isArray(models)) {
      for (const entry of models) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const row = entry as {
          name?: unknown;
          model?: unknown;
          supportedGenerationMethods?: string[];
        };
        if (
          style === "gemini" &&
          row.supportedGenerationMethods &&
          !row.supportedGenerationMethods.includes("generateContent")
        )
          continue;
        const name = String(row.name ?? row.model ?? "").trim();
        if (name) {
          names.push(style === "gemini" ? name.replace(/^models\//, "") : name);
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
  try {
    const { url, style } = modelsListRequest(
      endpoint.baseUrl,
      endpoint.protocol,
    );
    const response = await fetchImpl(url, {
      method: "GET",
      headers: modelApiHeaders(style, endpoint.apiKey),
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
