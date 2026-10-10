import { LiteratureError, openAlexFailure, publicUrl } from "./OpenAlexClient";
import { MAX_PDF_BYTES } from "./LiteraturePdf";

export function publicAddress(address: string): boolean {
  let host = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes(":")) {
    try {
      // DNS APIs may return expanded IPv6 addresses. Compare canonical prefixes.
      host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    } catch {
      return false;
    }
    return (
      /^[23][0-9a-f]{3}:/.test(host) &&
      !/^(?:2001:(?:db8|0|2|10|20):|2001::|2002:)/.test(host)
    );
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return false;
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function fulltextUrl(value: unknown): string {
  const safe = publicUrl(value);
  if (!safe || safe.length > 8192)
    throw new LiteratureError(
      "unsafe_url",
      "无效的全文地址 / Invalid fulltext URL",
    );
  const url = new URL(safe),
    host = url.hostname.replace(/\.$/, "");
  if (
    (url.port && !["80", "443"].includes(url.port)) ||
    (!host.includes(".") && !host.includes(":")) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
    ((/^[\d.]+$/.test(host) || host.includes(":")) && !publicAddress(host))
  )
    throw new LiteratureError(
      "unsafe_url",
      "全文地址不能访问本机或内网 / Fulltext URLs must not access local or private networks",
    );
  return safe;
}

/** Check DNS before each request/redirect. Never send a model-supplied URL to an internal host. */
export async function checkPublicHost(
  url: string,
  signal: AbortSignal,
): Promise<void> {
  const host = new URL(fulltextUrl(url)).hostname;
  if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return;
  await new Promise<void>((resolve, reject) => {
    let request: nsICancelable | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const cancel = (error: LiteratureError) => {
      // Native cancellation can throw or synchronously invoke its listener.
      finish(error);
      try {
        request?.cancel(Cr.NS_BINDING_ABORTED);
      } catch {
        // The promise has already settled with the actual cancellation reason.
      }
    };
    const abort = () => cancel(new LiteratureError("cancelled", "Cancelled"));
    const timer = setTimeout(() => {
      cancel(new LiteratureError("network", "DNS lookup timed out"));
    }, 10_000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      request = Services.dns.asyncResolve(
        host,
        0,
        0,
        null as unknown as nsIDNSAdditionalInfo,
        {
          onLookupComplete(_request, record, status) {
            if (settled) return;
            try {
              if (status || !record)
                throw new LiteratureError("network", "DNS lookup failed");
              const addresses = record.QueryInterface!(Ci.nsIDNSAddrRecord);
              let count = 0;
              while (addresses.hasMore()) {
                if (!publicAddress(addresses.getNextAddrAsString()))
                  throw new LiteratureError(
                    "unsafe_url",
                    "全文域名解析到非公网地址，请使用浏览器补齐 / Fulltext host resolves to a non-public address; use the browser",
                  );
                count++;
              }
              if (!count)
                throw new LiteratureError("network", "DNS returned no address");
              finish();
            } catch (error) {
              finish(error as Error);
            }
          },
        },
        Services.tm.currentThread,
      );
    } catch {
      finish(new LiteratureError("network", "DNS lookup unavailable"));
    }
  });
}

export async function requestFulltext(
  raw: string,
  signal: AbortSignal,
  options: {
    cacheKey?: string;
    maxBytes?: number;
    maxHtmlBytes?: number;
    beforeRequest?: (url: string) => void;
    method?: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
    userContextId?: number;
  } = {},
) {
  let url = fulltextUrl(raw);
  const visited = new Set<string>();
  for (let hop = 0; hop < 6; hop++) {
    if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
    if (visited.has(url))
      throw new LiteratureError("unavailable", "Redirect loop");
    visited.add(url);
    await checkPublicHost(url, signal);
    options.beforeRequest?.(url);
    const requestUrl = new URL(url);
    if (
      options.cacheKey &&
      requestUrl.origin === "https://content.openalex.org"
    )
      requestUrl.searchParams.set("api_key", options.cacheKey);
    let xhr: XMLHttpRequest | undefined;
    let tooLarge = false;
    const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
    const responseLimit = (type: string | null) =>
      /html|text\//i.test(type ?? "")
        ? Math.min(maxBytes, options.maxHtmlBytes ?? maxBytes)
        : maxBytes;
    const abort = () => xhr?.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await Zotero.HTTP.request(
        options.method ?? "GET",
        requestUrl.href,
        {
          body: options.body,
          headers: options.headers,
          debug: false,
          logBodyLength: 0,
          // Zotero 10 property; older typings still describe CookieSandbox.
          ...(options.userContextId === undefined
            ? {}
            : { userContextId: options.userContextId }),
          responseType: "arraybuffer",
          followRedirects: false,
          timeout: 30_000,
          successCodes: false,
          errorDelayMax: 0,
          requestObserver: (request: XMLHttpRequest) => {
            xhr = request;
            request.onprogress = (event) => {
              const progress = event as ProgressEvent;
              const limit = responseLimit(
                request.getResponseHeader("Content-Type"),
              );
              if (
                progress.loaded > limit ||
                (progress.lengthComputable && progress.total > limit)
              ) {
                tooLarge = true;
                request.abort();
              }
            };
            if (signal.aborted) abort();
          },
        },
      );
      if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
      if (result.status >= 300 && result.status < 400) {
        // Authenticated API requests never forward credentials or bodies to redirects.
        if (options.headers || options.body)
          throw new LiteratureError("network", "API redirect refused");
        const location = result.getResponseHeader("Location");
        if (!location)
          throw new LiteratureError("network", "Redirect has no location");
        url = fulltextUrl(new URL(location, url).href);
        continue;
      }
      if (
        options.cacheKey &&
        requestUrl.origin === "https://content.openalex.org"
      ) {
        const failure = openAlexFailure(result.status);
        if (failure) throw failure;
      }
      if (result.status < 200 || result.status >= 300)
        throw new LiteratureError(
          [401, 403].includes(result.status)
            ? "authentication"
            : result.status === 429
              ? "rate_limit"
              : "network",
          `全文 HTTP ${result.status} / Fulltext HTTP ${result.status}`,
        );
      const bytes = new Uint8Array(result.response as ArrayBuffer);
      if (
        tooLarge ||
        bytes.length > responseLimit(result.getResponseHeader("Content-Type"))
      )
        throw new LiteratureError(
          "invalid_pdf",
          "文件超过大小上限 / File exceeds size limit",
        );
      return {
        bytes,
        url,
        contentType: result.getResponseHeader("Content-Type") ?? "",
      };
    } catch (error) {
      if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
      if (tooLarge)
        throw new LiteratureError(
          "invalid_pdf",
          "文件超过大小上限 / File exceeds size limit",
        );
      if (error instanceof LiteratureError) throw error;
      throw new LiteratureError(
        "network",
        "全文请求失败 / Fulltext request failed",
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  throw new LiteratureError("unavailable", "Too many fulltext redirects");
}
