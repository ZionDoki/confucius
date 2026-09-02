/**
 * Privileged Zotero scripts load into a sandbox that is not a Window.
 * AbortController, fetch, and DOMException live on the main window, so
 * `new AbortController()` throws ReferenceError when sending a prompt.
 */
import { isWindowAlive } from "./window";

type AbortListener = (event: Event) => void;

class SandboxAbortSignal {
  aborted = false;
  reason: unknown;
  onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
  private readonly listeners: AbortListener[] = [];

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | AbortListener,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (type !== "abort" || typeof listener !== "function") {
      return;
    }
    this.listeners.push(listener as AbortListener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | AbortListener,
  ): void {
    if (type !== "abort" || typeof listener !== "function") {
      return;
    }
    const index = this.listeners.indexOf(listener as AbortListener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw this.reason ?? sandboxAbortError();
    }
  }

  notify(): void {
    const event = { type: "abort" } as Event;
    const snapshot = this.listeners.splice(0);
    for (const listener of snapshot) {
      listener(event);
    }
    if (typeof this.onabort === "function") {
      this.onabort.call(this as unknown as AbortSignal, event);
    }
  }
}

class SandboxAbortController {
  readonly signal = new SandboxAbortSignal() as unknown as AbortSignal;

  abort(reason?: unknown): void {
    const signal = this.signal as unknown as SandboxAbortSignal;
    if (signal.aborted) {
      return;
    }
    signal.aborted = true;
    signal.reason = reason ?? sandboxAbortError();
    signal.notify();
  }
}

function sandboxAbortError(): Error {
  try {
    if (typeof DOMException === "function") {
      return new DOMException("Aborted", "AbortError");
    }
  } catch {
    // Same sandbox gap as AbortController.
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function mainWindow(): Window | null {
  try {
    const win = Zotero.getMainWindow();
    return isWindowAlive(win) ? win : null;
  } catch {
    return null;
  }
}

function fromWindow(name: string): unknown {
  const win = mainWindow();
  if (!win) {
    return undefined;
  }
  try {
    return (win as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function defineGetter(
  target: Record<string, unknown>,
  name: string,
  getter: () => unknown,
): void {
  if (typeof target[name] !== "undefined") {
    return;
  }
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: false,
    get: getter,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object") {
    if ("href" in input && typeof (input as URL).href === "string") {
      return (input as URL).href;
    }
    if ("url" in input) {
      return String((input as Request).url);
    }
  }
  return String(input);
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    );
  }
  const maybeHeaders = headers as {
    forEach?: (cb: (value: string, key: string) => void) => void;
  };
  if (typeof maybeHeaders.forEach === "function") {
    const out: Record<string, string> = {};
    maybeHeaders.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

type ByteChunk = { done: boolean; value?: Uint8Array };
type ChunkWaiter = {
  resolve: (result: ByteChunk) => void;
  reject: (error: Error) => void;
};

function utf8Bytes(text: string): Uint8Array {
  const Local = (globalThis as unknown as { TextEncoder?: typeof TextEncoder })
    .TextEncoder;
  if (typeof Local === "function") {
    return new Local().encode(text);
  }
  const fromWin = fromWindow("TextEncoder") as typeof TextEncoder | undefined;
  if (typeof fromWin === "function") {
    return new fromWin().encode(text);
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function xmlHttpRequestCtor(): (new () => XMLHttpRequest) | undefined {
  const local = (
    globalThis as unknown as { XMLHttpRequest?: new () => XMLHttpRequest }
  ).XMLHttpRequest;
  if (typeof local === "function") {
    return local;
  }
  return fromWindow("XMLHttpRequest") as (new () => XMLHttpRequest) | undefined;
}

function xhrToResponse(xhr: XMLHttpRequest): Response {
  return {
    ok: xhr.status >= 200 && xhr.status < 300,
    status: xhr.status,
    statusText: xhr.statusText,
    headers: {
      get(name: string) {
        return xhr.getResponseHeader(name);
      },
    },
    body: null,
    async text() {
      return xhr.responseText ?? "";
    },
    async json() {
      return JSON.parse(xhr.responseText ?? "");
    },
  } as unknown as Response;
}

/**
 * Privileged XHR can talk to http:// localhost from chrome:// and reports
 * body bytes via onprogress. Zotero.HTTP.request only resolves when the
 * connection closes, so SSE/NDJSON streams look like a hang.
 */
function xhrStreamFetch(
  XHR: new () => XMLHttpRequest,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(sandboxAbortError());
      return;
    }

    const xhr = new XHR();
    let settled = false;
    let finished = false;
    let failed: Error | null = null;
    let offset = 0;
    const waiters: ChunkWaiter[] = [];
    const loadWaiters: Array<{
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];

    const notifyLoad = () => {
      const pending = loadWaiters.splice(0);
      for (const waiter of pending) {
        if (failed) {
          waiter.reject(failed);
        } else {
          waiter.resolve();
        }
      }
    };

    const fail = (error: Error) => {
      if (failed) {
        return;
      }
      failed = error;
      finished = true;
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        waiter.reject(error);
      }
      notifyLoad();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const takeChunk = (): Uint8Array | null => {
      const text = xhr.responseText ?? "";
      if (text.length <= offset) {
        return null;
      }
      const slice = text.slice(offset);
      offset = text.length;
      return utf8Bytes(slice);
    };

    const flush = () => {
      while (waiters.length) {
        if (failed) {
          waiters.shift()?.reject(failed);
          continue;
        }
        const chunk = takeChunk();
        if (chunk) {
          waiters.shift()?.resolve({ done: false, value: chunk });
          continue;
        }
        if (finished) {
          waiters.shift()?.resolve({ done: true });
          continue;
        }
        break;
      }
    };

    const reader = {
      async read(): Promise<ByteChunk> {
        if (failed) {
          throw failed;
        }
        const chunk = takeChunk();
        if (chunk) {
          return { done: false, value: chunk };
        }
        if (finished) {
          return { done: true };
        }
        return new Promise<ByteChunk>((res, rej) => {
          waiters.push({ resolve: res, reject: rej });
        });
      },
      async cancel(): Promise<void> {
        try {
          xhr.abort();
        } catch {
          // Already closed.
        }
      },
    };

    const waitForLoad = (): Promise<void> => {
      if (failed) {
        return Promise.reject(failed);
      }
      if (finished) {
        return Promise.resolve();
      }
      return new Promise<void>((res, rej) => {
        loadWaiters.push({ resolve: res, reject: rej });
      });
    };

    const makeResponse = (): Response =>
      ({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText,
        headers: {
          get(name: string) {
            return xhr.getResponseHeader(name);
          },
        },
        body: { getReader: () => reader },
        async text() {
          await waitForLoad();
          return xhr.responseText ?? "";
        },
        async json() {
          await waitForLoad();
          return JSON.parse(xhr.responseText ?? "");
        },
      }) as unknown as Response;

    const trySettle = () => {
      if (settled || failed) {
        return;
      }
      if (xhr.readyState < 2) {
        return;
      }
      if (xhr.status === 0 && xhr.readyState < 4) {
        return;
      }
      if (xhr.readyState === 4 && xhr.status === 0) {
        fail(new Error("HTTP request failed"));
        return;
      }
      settled = true;
      resolve(makeResponse());
    };

    try {
      xhr.open(init?.method ?? "GET", requestUrl(input), true);
    } catch (error) {
      reject(new Error(unknownErrorMessage(error)));
      return;
    }

    // These properties are optional on the XHR implementation exposed by
    // Zotero's chrome sandbox.  In particular, some Firefox/XPCOM versions
    // throw from `withCredentials` even before send(); the default is false,
    // so there is no need to set it explicitly.
    try {
      xhr.responseType = "";
    } catch {
      // Text is the default response type.
    }
    try {
      xhr.timeout = 0;
    } catch {
      // An unlimited timeout is the default for this request.
    }
    try {
      (
        xhr as XMLHttpRequest & { mozBackgroundRequest?: boolean }
      ).mozBackgroundRequest = true;
    } catch {
      // Content XHR does not expose this flag.
    }

    const headers = headersToRecord(init?.headers);
    for (const [key, value] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(key, value);
      } catch {
        // Forbidden header names are ignored in content XHR.
      }
    }

    xhr.onreadystatechange = () => {
      trySettle();
      if (xhr.readyState === 4) {
        finished = true;
        flush();
        notifyLoad();
      }
    };
    xhr.onprogress = () => {
      trySettle();
      flush();
    };
    xhr.onload = () => {
      finished = true;
      trySettle();
      flush();
      notifyLoad();
    };
    xhr.onerror = () => {
      fail(new Error("HTTP request failed"));
    };
    xhr.onabort = () => {
      fail(sandboxAbortError());
    };
    xhr.ontimeout = () => {
      fail(new Error("HTTP request timed out"));
    };

    if (init?.signal) {
      init.signal.addEventListener(
        "abort",
        () => {
          try {
            xhr.abort();
          } catch {
            // Ignore.
          }
        },
        { once: true },
      );
    }

    const body = init?.body;
    try {
      xhr.send(
        body == null || typeof body === "string"
          ? ((body as string | null | undefined) ?? null)
          : String(body),
      );
    } catch (error) {
      fail(new Error(unknownErrorMessage(error)));
    }
  });
}

async function zoteroBufferedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const http = Zotero.HTTP;
  if (!http?.request) {
    throw new Error(
      "fetch is not available in this Zotero sandbox — cannot reach the model.",
    );
  }
  if (init?.signal?.aborted) {
    throw sandboxAbortError();
  }
  const body = init?.body;
  let cancel: (() => void) | undefined;
  const pending = http.request(init?.method ?? "GET", requestUrl(input), {
    body:
      body == null || typeof body === "string"
        ? (body as string | undefined)
        : String(body),
    headers: headersToRecord(init?.headers),
    timeout: 0,
    successCodes: false,
    errorDelayMax: 0,
    cancellerReceiver: (fn: () => void) => {
      cancel = fn;
    },
  });
  if (init?.signal) {
    init.signal.addEventListener(
      "abort",
      () => {
        cancel?.();
      },
      { once: true },
    );
  }
  try {
    return xhrToResponse(await pending);
  } catch (error) {
    if (init?.signal?.aborted) {
      throw sandboxAbortError();
    }
    throw new Error(unknownErrorMessage(error), { cause: error });
  }
}

type AbortControllerCtor = new () => AbortController;

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object") {
    const maybe = (error as { message?: unknown }).message;
    if (typeof maybe === "string" && maybe.trim()) {
      return maybe;
    }
  }
  const text = String(error);
  return text && text !== "[object Object]" ? text : "HTTP request failed";
}

/**
 * Privileged chrome:// windows cannot reliably fetch() http:// localhost
 * (mixed content) or pass sandbox AbortSignals. Use window XHR so SSE
 * chunks arrive via onprogress; fall back to Zotero.HTTP.request (buffered).
 */
export const hostFetch: typeof fetch = (input, init) => {
  const XHR = xmlHttpRequestCtor();
  if (XHR) {
    return xhrStreamFetch(XHR, input, init);
  }
  const zoteroHttp = (
    globalThis as unknown as {
      Zotero?: { HTTP?: { request?: unknown } };
    }
  ).Zotero?.HTTP;
  if (typeof zoteroHttp?.request === "function") {
    return zoteroBufferedFetch(input, init);
  }
  const localFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (typeof localFetch === "function" && localFetch !== hostFetch) {
    return localFetch(input, init);
  }
  const win = mainWindow();
  if (win?.fetch) {
    const rest = { ...(init ?? {}) };
    delete rest.signal;
    return win.fetch.call(win, input, rest) as Promise<Response>;
  }
  throw new Error(
    "fetch is not available in this Zotero sandbox — cannot reach the model.",
  );
};

/** True when hostFetch can deliver SSE/NDJSON before the connection closes. */
export function hostFetchCanStream(): boolean {
  return typeof xmlHttpRequestCtor() === "function";
}

export function createAbortController(): AbortController {
  const local = (
    globalThis as unknown as { AbortController?: AbortControllerCtor }
  ).AbortController;
  if (typeof local === "function") {
    return new local();
  }
  const fromWin = fromWindow("AbortController") as
    AbortControllerCtor | undefined;
  if (typeof fromWin === "function") {
    return new fromWin();
  }
  return new SandboxAbortController() as unknown as AbortController;
}

/** Copy Window web APIs onto the loadSubScript sandbox, lazily. */
export function installWebPlatform(target: object = globalThis): void {
  const record = target as Record<string, unknown>;
  defineGetter(
    record,
    "AbortController",
    () => fromWindow("AbortController") ?? SandboxAbortController,
  );
  defineGetter(record, "fetch", () => hostFetch);
  for (const name of [
    "AbortSignal",
    "DOMException",
    "Headers",
    "ReadableStream",
    "Request",
    "Response",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "URLSearchParams",
    "XMLHttpRequest",
  ] as const) {
    defineGetter(record, name, () => fromWindow(name));
  }
}
