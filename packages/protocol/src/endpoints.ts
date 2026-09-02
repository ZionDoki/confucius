import {
  isReasoningEffort,
  validateConfigPatch,
  type ReasoningEffort,
} from "./rpc";

export const MAX_ENDPOINTS = 20;
export const DEFAULT_CONTEXT_WINDOW = 32_768;

export interface ModelEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
  contextWindowTokens: number;
}

export interface EndpointStore {
  endpoints: ModelEndpoint[];
  activeEndpointId: string;
}

export interface LegacyModelPrefs {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  reasoningEffort: string;
  contextWindowTokens: number;
}

export function newEndpointId(): string {
  return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function endpointLabel(model: string, baseUrl: string): string {
  const trimmed = model.trim();
  if (trimmed) {
    return trimmed;
  }
  try {
    return new URL(baseUrl).host || "Untitled";
  } catch {
    return "Untitled";
  }
}

export function blankEndpoint(id = newEndpointId()): ModelEndpoint {
  return {
    id,
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    maxTokens: 0,
    reasoningEffort: "auto",
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
  };
}

export function parseEndpointsJson(raw: string): ModelEndpoint[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ModelEndpoint[] = [];
    for (const entry of parsed.slice(0, MAX_ENDPOINTS)) {
      const ep = coerceEndpoint(entry);
      if (ep) {
        out.push(ep);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function coerceEndpoint(entry: unknown): ModelEndpoint | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const raw = entry as Record<string, unknown>;
  const id = String(raw.id ?? "").trim();
  if (!id) {
    return null;
  }
  const effort = raw.reasoningEffort;
  const window = Number(raw.contextWindowTokens);
  return {
    id,
    name: String(raw.name ?? "").trim(),
    baseUrl: String(raw.baseUrl ?? "").trim(),
    apiKey: String(raw.apiKey ?? ""),
    model: String(raw.model ?? "").trim(),
    maxTokens: Math.max(0, Math.floor(Number(raw.maxTokens) || 0)),
    reasoningEffort: isReasoningEffort(effort) ? effort : "auto",
    contextWindowTokens:
      Number.isInteger(window) && window >= 1000
        ? window
        : DEFAULT_CONTEXT_WINDOW,
  };
}

export function defaultEndpoint(legacy: LegacyModelPrefs): ModelEndpoint {
  const ep = blankEndpoint();
  ep.baseUrl = String(legacy.baseUrl || "").trim();
  ep.apiKey = String(legacy.apiKey || "");
  ep.model = String(legacy.model || "").trim();
  ep.maxTokens = Number(legacy.maxTokens) || 0;
  ep.reasoningEffort = isReasoningEffort(legacy.reasoningEffort)
    ? legacy.reasoningEffort
    : "auto";
  ep.contextWindowTokens =
    Number(legacy.contextWindowTokens) || DEFAULT_CONTEXT_WINDOW;
  ep.name = endpointLabel(ep.model, ep.baseUrl);
  return ep;
}

function legacyFieldsDiffer(
  active: ModelEndpoint,
  legacy: LegacyModelPrefs,
): boolean {
  const effort = isReasoningEffort(legacy.reasoningEffort)
    ? legacy.reasoningEffort
    : "auto";
  return (
    active.baseUrl !== String(legacy.baseUrl || "").trim() ||
    active.apiKey !== String(legacy.apiKey || "") ||
    active.model !== String(legacy.model || "").trim() ||
    active.maxTokens !== (Number(legacy.maxTokens) || 0) ||
    active.reasoningEffort !== effort ||
    active.contextWindowTokens !==
      (Number(legacy.contextWindowTokens) || DEFAULT_CONTEXT_WINDOW)
  );
}

export function resolveEndpointStore(
  json: string,
  activeId: string,
  legacy: LegacyModelPrefs,
): { store: EndpointStore; dirty: boolean } {
  let endpoints = parseEndpointsJson(json);
  let dirty = false;
  if (endpoints.length === 0) {
    const ep = defaultEndpoint(legacy);
    return {
      store: { endpoints: [ep], activeEndpointId: ep.id },
      dirty: true,
    };
  }
  let activeEndpointId = String(activeId || "");
  if (!endpoints.some((entry) => entry.id === activeEndpointId)) {
    activeEndpointId = endpoints[0].id;
    dirty = true;
  }
  const active = endpoints.find((entry) => entry.id === activeEndpointId);
  if (
    active &&
    (legacy.baseUrl || legacy.model || legacy.apiKey) &&
    legacyFieldsDiffer(active, legacy)
  ) {
    const next = defaultEndpoint(legacy);
    next.id = active.id;
    next.name = active.name || next.name;
    endpoints = endpoints.map((entry) =>
      entry.id === active.id ? next : entry,
    );
    dirty = true;
  }
  for (const entry of endpoints) {
    if (!entry.name) {
      entry.name = endpointLabel(entry.model, entry.baseUrl);
      dirty = true;
    }
  }
  return { store: { endpoints, activeEndpointId }, dirty };
}

export function activeEndpoint(
  store: EndpointStore,
): ModelEndpoint | undefined {
  return (
    store.endpoints.find((entry) => entry.id === store.activeEndpointId) ??
    store.endpoints[0]
  );
}

export function endpointIsConfigured(endpoint?: ModelEndpoint): boolean {
  return Boolean(endpoint?.baseUrl && endpoint?.model);
}

function mergeEndpoint(
  base: ModelEndpoint,
  patch: Record<string, unknown>,
): ModelEndpoint {
  const next: ModelEndpoint = { ...base };
  if (patch.name !== undefined) {
    next.name = String(patch.name).trim();
  }
  if (patch.baseUrl !== undefined) {
    next.baseUrl = String(patch.baseUrl).trim();
  }
  if (patch.apiKey !== undefined) {
    next.apiKey = String(patch.apiKey);
  }
  if (patch.model !== undefined) {
    next.model = String(patch.model).trim();
  }
  if (patch.maxTokens !== undefined) {
    next.maxTokens = Number(patch.maxTokens) || 0;
  }
  if (isReasoningEffort(patch.reasoningEffort)) {
    next.reasoningEffort = patch.reasoningEffort;
  }
  if (patch.contextWindowTokens !== undefined) {
    const window = Number(patch.contextWindowTokens);
    if (Number.isInteger(window) && window >= 1000) {
      next.contextWindowTokens = window;
    }
  }
  if (!next.name) {
    next.name = endpointLabel(next.model, next.baseUrl);
  }
  return next;
}

function validateCompleteEndpoint(endpoint: ModelEndpoint): string[] {
  const result = validateConfigPatch({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model || " ",
    maxTokens: endpoint.maxTokens,
    reasoningEffort: endpoint.reasoningEffort,
    contextWindowTokens: endpoint.contextWindowTokens,
  });
  const errors = result.ok ? [] : [...result.errors];
  if (!endpoint.baseUrl) {
    errors.push("Base URL must not be empty");
  }
  if (!endpoint.model.trim()) {
    errors.push("Model must not be empty");
  }
  return [...new Set(errors)];
}

export type EndpointPatchResult =
  { ok: true; store: EndpointStore } | { ok: false; errors: string[] };

/**
 * Apply a config/set patch to the endpoint store. Legacy fields (baseUrl,
 * model, …) update the active endpoint. `endpoint` upserts; omit id to add.
 */
export function applyEndpointPatch(
  store: EndpointStore,
  patch: Record<string, unknown>,
): EndpointPatchResult {
  const fieldCheck = validateConfigPatch(patch);
  if (!fieldCheck.ok) {
    return fieldCheck;
  }

  let endpoints = store.endpoints.map((entry) => ({ ...entry }));
  let activeId = store.activeEndpointId;
  const errors: string[] = [];

  if (patch.deleteEndpointId !== undefined) {
    const id = String(patch.deleteEndpointId);
    if (endpoints.length <= 1) {
      errors.push("Keep at least one endpoint");
    } else if (!endpoints.some((entry) => entry.id === id)) {
      errors.push("Unknown endpoint");
    } else {
      endpoints = endpoints.filter((entry) => entry.id !== id);
      if (activeId === id) {
        activeId = endpoints[0].id;
      }
    }
  }

  if (patch.endpoint !== undefined) {
    if (
      typeof patch.endpoint !== "object" ||
      patch.endpoint === null ||
      Array.isArray(patch.endpoint)
    ) {
      errors.push("endpoint must be an object");
    } else {
      const raw = patch.endpoint as Record<string, unknown>;
      const id = String(raw.id ?? "").trim();
      const existing = id
        ? endpoints.find((entry) => entry.id === id)
        : undefined;
      if (id && !existing) {
        errors.push("Unknown endpoint");
      } else if (!id && endpoints.length >= MAX_ENDPOINTS) {
        errors.push(`At most ${MAX_ENDPOINTS} endpoints`);
      } else {
        const merged = mergeEndpoint(existing ?? blankEndpoint(), raw);
        const epErrors = validateCompleteEndpoint(merged);
        if (epErrors.length > 0) {
          errors.push(...epErrors);
        } else if (existing) {
          endpoints = endpoints.map((entry) =>
            entry.id === existing.id ? merged : entry,
          );
          activeId = merged.id;
        } else {
          endpoints.push(merged);
          activeId = merged.id;
        }
      }
    }
  }

  if (patch.activeEndpointId !== undefined) {
    const id = String(patch.activeEndpointId);
    if (!endpoints.some((entry) => entry.id === id)) {
      errors.push("Unknown endpoint");
    } else {
      activeId = id;
    }
  }

  const hasLegacy =
    patch.baseUrl !== undefined ||
    patch.apiKey !== undefined ||
    patch.model !== undefined ||
    patch.maxTokens !== undefined ||
    patch.reasoningEffort !== undefined ||
    patch.contextWindowTokens !== undefined ||
    patch.name !== undefined;
  if (hasLegacy) {
    const index = endpoints.findIndex((entry) => entry.id === activeId);
    if (index < 0) {
      errors.push("No active endpoint");
    } else {
      const merged = mergeEndpoint(endpoints[index], {
        name: patch.name,
        baseUrl: patch.baseUrl,
        apiKey: patch.apiKey,
        model: patch.model,
        maxTokens: patch.maxTokens,
        reasoningEffort: patch.reasoningEffort,
        contextWindowTokens: patch.contextWindowTokens,
      });
      if (patch.baseUrl !== undefined || patch.model !== undefined) {
        const epErrors = validateCompleteEndpoint(merged);
        if (epErrors.length > 0) {
          errors.push(...epErrors);
        } else {
          endpoints[index] = merged;
        }
      } else {
        endpoints[index] = merged;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  if (endpoints.length === 0) {
    return { ok: false, errors: ["Keep at least one endpoint"] };
  }
  if (!endpoints.some((entry) => entry.id === activeId)) {
    activeId = endpoints[0].id;
  }
  return { ok: true, store: { endpoints, activeEndpointId: activeId } };
}
