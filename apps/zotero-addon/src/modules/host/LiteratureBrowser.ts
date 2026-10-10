import { LiteratureError } from "./OpenAlexClient";
import {
  checkPublicHost,
  fulltextUrl,
  requestFulltext,
} from "./LiteratureNetwork";
import { MAX_PDF_BYTES, validPdf } from "./LiteraturePdf";
import {
  htmlDocument,
  pageRefresh,
  visiblePageText,
} from "./LiteratureResolvers";
import { createAbortController } from "../../utils/webPlatform";

interface BrowserHandle {
  _createdPromise: Promise<void>;
  _browser: unknown;
  currentURI: { spec: string };
  load(url: string): Promise<boolean>;
  getPageData(fields: string[]): Promise<{ documentHTML: string }>;
  destroy(): void;
}
interface BrowserRuntime {
  HTTP: { newCookieContext?: () => { id: number; dispose(): void } };
  BrowserRequest?: {
    _makePDFMIMETypeHandler?: (
      browser: unknown,
      found: (blob: Blob) => void,
    ) => unknown;
  };
  MIMETypeHandler: {
    addHandlers(type: string, handler: unknown, intercept: boolean): void;
    removeHandlers(type: string, handler: unknown): void;
  };
  VersionHeader?: { getPlainFirefoxUA(): string };
}

export function browserFulltextAvailable() {
  const api = Zotero as unknown as BrowserRuntime;
  return !!(
    api.HTTP?.newCookieContext && api.BrowserRequest?._makePDFMIMETypeHandler
  );
}

export function isChallengePage(doc: Document) {
  const body = doc.body?.textContent ?? "";
  return (
    !!doc.querySelector(
      '#challenge-form, .anomaly-modal, #captcha-box, input[type="password"]',
    ) ||
    /checking your browser|just a moment|verify (?:you are|you're) human|enable javascript and cookies|making sure you.re not a bot/i.test(
      `${doc.title} ${body.slice(0, 1500)}`,
    )
  );
}

/** Host-only handoff. Never serialize this object into a tool response. */
export interface FulltextTransfer {
  browser: LiteratureBrowser;
  prepared?: Awaited<ReturnType<typeof requestFulltext>>;
}

/** One isolated cookie jar per acquisition. The model never receives a script or cookie API. */
export class LiteratureBrowser {
  private context?: { id: number; dispose(): void };
  private calls = 0;
  get hasSession() {
    return !!this.context;
  }
  request(
    raw: string,
    signal: AbortSignal,
    options: Parameters<typeof requestFulltext>[2] = {},
  ) {
    return requestFulltext(raw, signal, {
      ...options,
      userContextId: this.context?.id,
    });
  }
  dispose() {
    const context = this.context;
    this.context = undefined;
    try {
      context?.dispose();
    } catch {
      // Native shutdown can race cookie cleanup. Never mask an import receipt.
    }
  }
  async read(raw: string, signal: AbortSignal) {
    if (!browserFulltextAvailable())
      throw new LiteratureError(
        "unavailable",
        "This Zotero version has no isolated browser download support",
      );
    if (++this.calls > 4)
      throw new LiteratureError(
        "unavailable",
        "Browser acquisition budget exhausted",
      );
    const api = Zotero as unknown as BrowserRuntime;
    const url = fulltextUrl(raw);
    await checkPublicHost(url, signal);
    // Reuse cookies established on the landing page for its observed file link.
    // Browser PDF viewers can start rendering before the native MIME capture finishes.
    const fileLink = /\.pdf(?:[?#]|$)|[?&]pdf=render/i.test(url);
    if (this.context) {
      try {
        const response = await requestFulltext(url, signal, {
          userContextId: this.context.id,
        });
        if (validPdf(response.bytes)) return response;
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof LiteratureError && error.code === "unsafe_url")
        )
          throw error;
      }
    }
    this.context ??= api.HTTP.newCookieContext!();
    const contextId = this.context.id;
    const { HiddenBrowser } = ChromeUtils.importESModule(
      "chrome://zotero/content/HiddenBrowser.mjs",
    ) as {
      HiddenBrowser: new (options: Record<string, unknown>) => BrowserHandle;
    };
    const browser = new HiddenBrowser({
      userContextId: contextId,
      customUserAgent: api.VersionHeader?.getPlainFirefoxUA(),
    });
    const controller = createAbortController();
    let closed = false;
    let handler: unknown;
    let pdf: Blob | undefined;
    const channels = new Set<nsIHttpChannel>();
    const hosts = new Map<string, Promise<void>>();
    // Suspend before sending every HTTP request in this browser, including redirects
    // and subresources. A public landing page must not grant access to the LAN.
    const observer = {
      observe(subject: nsISupports) {
        const channel = subject.QueryInterface!(Ci.nsIHttpChannel);
        if (channel.loadInfo.originAttributes.userContextId !== contextId)
          return;
        if (closed) {
          channel.cancel(Cr.NS_BINDING_ABORTED);
          return;
        }
        channel.suspend();
        channels.add(channel);
        void (async () => {
          try {
            const target = fulltextUrl(channel.URI.spec);
            const host = new URL(target).hostname;
            let check = hosts.get(host);
            if (!check) {
              check = checkPublicHost(target, controller.signal);
              hosts.set(host, check);
            }
            await check;
            if (closed) channel.cancel(Cr.NS_BINDING_ABORTED);
          } catch {
            channel.cancel(Cr.NS_BINDING_ABORTED);
          } finally {
            channels.delete(channel);
            try {
              channel.resume();
            } catch {
              /* Cancelled channel. */
            }
          }
        })();
      },
    };
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const abort = () =>
      rejectStop(new LiteratureError("cancelled", "Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        rejectStop(
          new LiteratureError("network", "Browser acquisition timed out"),
        ),
      25_000,
    );
    try {
      Services.obs.addObserver(observer, "http-on-modify-request");
      if (signal.aborted) abort();
      return await Promise.race([
        stopped,
        (async () => {
          await browser._createdPromise;
          if (closed) throw new LiteratureError("cancelled", "Cancelled");
          handler = api.BrowserRequest!._makePDFMIMETypeHandler!(
            browser._browser,
            (blob) => {
              pdf = blob;
            },
          );
          api.MIMETypeHandler.addHandlers("application/pdf", handler, true);
          await browser.load(url);
          let last = "",
            stableSince = Date.now();
          while (!closed) {
            if (pdf) {
              if (pdf.size > MAX_PDF_BYTES)
                throw new LiteratureError("invalid_pdf", "PDF exceeds 100 MiB");
              return {
                bytes: new Uint8Array(await pdf.arrayBuffer()),
                url: fulltextUrl(
                  /^https?:/.test(browser.currentURI.spec)
                    ? browser.currentURI.spec
                    : url,
                ),
                contentType: "application/pdf",
              };
            }
            const current = browser.currentURI.spec;
            if (/^https?:/.test(current)) {
              const { documentHTML } = await browser.getPageData([
                "documentHTML",
              ]);
              if (documentHTML.length > 5 * 1024 * 1024)
                throw new LiteratureError(
                  "unavailable",
                  "Browser page exceeds 5 MiB",
                );
              const bytes = new TextEncoder().encode(documentHTML);
              const doc = await htmlDocument(bytes, current);
              const fingerprint = `${current}:${doc.title}:${visiblePageText(doc).slice(0, 1500)}`;
              if (fingerprint !== last) {
                last = fingerprint;
                stableSince = Date.now();
              }
              if (
                !fileLink &&
                !isChallengePage(doc) &&
                !pageRefresh(doc, current) &&
                documentHTML.length > 200 &&
                Date.now() - stableSince >= 2000
              )
                return {
                  bytes,
                  url: fulltextUrl(current),
                  contentType: "text/html",
                };
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          throw new LiteratureError("cancelled", "Cancelled");
        })(),
      ]);
    } finally {
      closed = true;
      controller.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const release = (cleanup: () => void) => {
        try {
          cleanup();
        } catch {
          // Each native resource must be released even if another one fails.
        }
      };
      release(() =>
        Services.obs.removeObserver(observer, "http-on-modify-request"),
      );
      for (const channel of channels)
        release(() => channel.cancel(Cr.NS_BINDING_ABORTED));
      if (handler)
        release(() =>
          api.MIMETypeHandler.removeHandlers("application/pdf", handler),
        );
      release(() => browser.destroy());
    }
  }
}
