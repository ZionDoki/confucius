import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { setImmediate } from "node:timers";
import {
  openAlexWork,
  LiteratureError,
} from "../src/modules/host/OpenAlexClient.ts";
import {
  verifyPdfIdentity,
  verifyPdf,
} from "../src/modules/host/LiteraturePdf.ts";
import {
  fulltextUrl,
  publicAddress,
  checkPublicHost,
  requestFulltext,
} from "../src/modules/host/LiteratureNetwork.ts";
import { ZoteroLiteratureAcquirer } from "../src/modules/host/LiteratureAcquisition.ts";
import { LiteratureFulltextAgent } from "../src/modules/host/LiteratureFulltextAgent.ts";
import { LiteratureBrowser } from "../src/modules/host/LiteratureBrowser.ts";
import { repositoryCandidates } from "../src/modules/host/LiteratureRepositories.ts";
import { tavilySearch } from "../src/modules/host/LiteratureSearch.ts";
import {
  ancillaryFile,
  translatedCandidates,
} from "../src/modules/host/LiteratureResolvers.ts";
import { LiteratureService } from "../src/modules/host/LiteratureService.ts";
import { LiteratureToolProvider } from "../src/modules/host/LiteratureToolProvider.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";

const { TextEncoder, queueMicrotask, AbortController, Blob, structuredClone } =
  globalThis;

const title = "Evidence guided literature acquisition";
const author = "Jane Smith";
const firstPage = `${title}\n${author}\nhttps://doi.org/10.1234/test\nAbstract\nStudy text`;
const bytes = new TextEncoder().encode(
  "%PDF-1.7\n" + "x".repeat(80) + "\n%%EOF",
);
const work = (extra = {}) => ({
  ...openAlexWork(
    {
      id: "https://openalex.org/W1",
      title,
      doi: "10.1234/test",
      authorships: [{ author: { display_name: author } }],
    },
    "q",
  ),
  acquisition: {
    status: "failed",
    item: { id: "item:1:ITEM", libraryID: 1, key: "ITEM" },
  },
  ...extra,
});

function runtime(t, options = {}) {
  const originals = Object.fromEntries(
    [
      "Zotero",
      "IOUtils",
      "PathUtils",
      "Services",
      "Ci",
      "Cr",
      "ChromeUtils",
    ].map((name) => [name, globalThis[name]]),
  );
  const files = new Map(),
    requests = [],
    imports = [];
  const parent = { id: 1, getAttachments: () => [], deleted: false };
  globalThis.IOUtils = {
    exists: async (p) => files.has(p),
    stat: async (p) => ({ size: files.get(p)?.length ?? 0 }),
    read: async (p) => files.get(p),
    write: async (p, b) => files.set(p, b),
    makeDirectory: async () => {},
    remove: async (p) => files.delete(p),
  };
  globalThis.PathUtils = { localProfileDir: "/test-profile", join: path.join };
  globalThis.Ci = { nsIDNSAddrRecord: {} };
  globalThis.Cr = { NS_BINDING_ABORTED: 1 };
  globalThis.Services = {
    tm: { currentThread: {} },
    dns: {
      asyncResolve(host, _type, _flags, _info, listener) {
        const addresses = [...(options.addresses?.(host) ?? ["93.184.216.34"])];
        queueMicrotask(() =>
          listener.onLookupComplete(
            {},
            {
              QueryInterface: () => ({
                hasMore: () => !!addresses.length,
                getNextAddrAsString: () => addresses.shift(),
              }),
            },
            0,
          ),
        );
        return { cancel() {} };
      },
    },
  };
  globalThis.Zotero = {
    getMainWindow: () => ({ AbortController, Blob }),
    HTTP: {
      request: async (_method, url, opts) => {
        requests.push(url);
        const result = (await options.response?.(url, opts)) ?? {
          status: 200,
          response: bytes.buffer,
        };
        return {
          getResponseHeader: (name) =>
            result.headers?.[name] ?? "application/pdf",
          ...result,
        };
      },
    },
    PDFWorker: {
      _enqueue: (fn) => fn(),
      _query: async () => ({ totalPages: 2, text: options.text ?? firstPage }),
    },
    Items: { getByLibraryAndKey: () => parent },
    File: { pathToFile: (file) => file },
    Utilities: {
      Internal: {
        blobToHTMLDocument: async () =>
          options.doc ?? {
            title: "Page",
            body: { textContent: "" },
            querySelectorAll: () => [],
            querySelector: () => null,
          },
        getFileFromDocument: async () => options.translated ?? {},
      },
    },
    Attachments: {
      getFileResolvers: () => options.resolvers ?? [],
      importFromFile: async (input) => {
        imports.push({ ...input, bytes: files.get(input.file) });
        return {
          key: `PDF${imports.length}`,
          setField() {},
          saveTx: async () => {},
        };
      },
    },
  };
  t.after(() => Object.assign(globalThis, originals));
  return { files, requests, imports, parent };
}

test("OpenAlex keeps every location and version, and restricts cache credentials to the matching work", () => {
  const paper = openAlexWork(
    {
      id: "https://openalex.org/W1",
      title,
      best_oa_location: {
        pdf_url: "https://repo.example.org/a.pdf",
        landing_page_url: "https://repo.example.org/a",
        is_oa: true,
        version: "acceptedVersion",
      },
      locations: [
        {
          landing_page_url: "https://publisher.example.org/a",
          version: "publishedVersion",
          is_oa: false,
        },
        { landing_page_url: "https://second.example.org/a", is_oa: true },
      ],
      has_content: { pdf: true },
      content_urls: {
        pdf: "https://content.openalex.org/works/W1.pdf?API_KEY=secret",
      },
    },
    "q",
  );
  assert.equal(paper.locations.length, 3);
  assert.equal(paper.locations[0].version, "acceptedVersion");
  assert.equal(paper.cachedPdfUrl, "https://content.openalex.org/works/W1.pdf");
  assert.equal(JSON.stringify(paper).includes("secret"), false);
  for (const url of [
    "http://content.openalex.org/works/W1.pdf",
    "https://content.openalex.org/works/W2.pdf",
    "https://evil.org/works/W1.pdf",
  ])
    assert.equal(
      openAlexWork(
        { id: "W1", has_content: { pdf: true }, content_urls: { pdf: url } },
        "q",
      ).cachedPdfUrl,
      undefined,
    );
});
test("identity requires title plus DOI or author, rejects references and supplements, accepts alternative versions", () => {
  assert.equal(verifyPdfIdentity(work(), firstPage).method, "doi_title");
  assert.equal(
    verifyPdfIdentity(work(), `${title}\nJ. Smith`).method,
    "title_author",
  );
  assert.throws(() => verifyPdfIdentity(work(), `${title}\nJohn Smith`), {
    code: "identity_mismatch",
  });
  assert.throws(
    () =>
      verifyPdfIdentity(
        work(),
        firstPage.replace(title, "A completely different article"),
      ),
    { code: "identity_mismatch" },
  );
  assert.throws(
    () =>
      verifyPdfIdentity(
        work(),
        `${title}\nWrong Person\nAbstract\n${firstPage}`,
      ),
    { code: "identity_mismatch" },
  );
  assert.throws(
    () => verifyPdfIdentity(work(), `Supplementary information\n${firstPage}`),
    { code: "identity_mismatch" },
  );
  assert.throws(
    () =>
      verifyPdfIdentity(
        work(),
        firstPage.replace("10.1234/test", "10.1234/wrong"),
      ),
    { code: "identity_mismatch" },
  );
  assert.equal(
    verifyPdfIdentity(
      work(),
      firstPage.replace("10.1234/test", "10.1234/preprint"),
      "submittedVersion",
    ).method,
    "title_author",
  );
  assert.throws(() => verifyPdfIdentity(work(), ""), {
    code: "unverified_pdf",
  });
  assert.equal(
    verifyPdfIdentity(
      work({ title: "文献智能检索研究", authors: ["张三"], doi: undefined }),
      "文献智能检索研究\n张三\n摘要",
    ).method,
    "title_author",
  );
});
test("a valid header never substitutes for PDF parsing", async (t) => {
  runtime(t);
  globalThis.Zotero.PDFWorker._query = async () => {
    throw new Error("Malformed file");
  };
  await assert.rejects(verifyPdf(bytes, work()), { code: "invalid_pdf" });
});
test("network rejects local addresses, credentials, unsafe redirects and private DNS before HTTP", async (t) => {
  const f = runtime(t, { addresses: () => ["10.0.0.1"] });
  for (const url of [
    "file:///tmp/a",
    "http://localhost/a",
    "http://127.1/a",
    "http://2130706433/a",
    "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "https://a.internal/a",
    "https://user:password@example.org/a",
    "https://example.org:8080/a",
  ])
    assert.throws(() => fulltextUrl(url), { code: "unsafe_url" });
  assert.equal(publicAddress("169.254.169.254"), false);
  assert.equal(publicAddress("2001:4860:4860::8888"), true);
  await assert.rejects(
    requestFulltext(
      "https://repository.example.org/a",
      new AbortController().signal,
    ),
    { code: "unsafe_url" },
  );
  assert.deepEqual(f.requests, []);
});
test("redirects are checked before following and cache keys never cross origins", async (t) => {
  const f = runtime(t, {
    response: (url, opts) => {
      assert.equal(opts.followRedirects, false);
      if (url.includes("content.openalex.org"))
        return {
          status: 302,
          headers: { Location: "https://cdn.example.org/a.pdf" },
        };
      return { status: 200, response: bytes.buffer };
    },
  });
  await requestFulltext(
    "https://content.openalex.org/works/W1.pdf",
    new AbortController().signal,
    { cacheKey: "test-secret" },
  );
  assert.match(f.requests[0], /api_key=test-secret/);
  assert.equal(f.requests[1], "https://cdn.example.org/a.pdf");
  globalThis.Zotero.HTTP.request = async () => ({
    status: 302,
    getResponseHeader: () => "http://127.0.0.1/private",
  });
  await assert.rejects(
    requestFulltext(
      "https://repository.example.org/a",
      new AbortController().signal,
    ),
    { code: "unsafe_url" },
  );
});
test("native OA resolvers and page translators are reused before verified import", async (t) => {
  const f = runtime(t, {
    text: `Accepted Manuscript\n${firstPage}`,
    resolvers: [
      async () => [
        {
          pageURL: "https://repository.example.org/article",
          articleVersion: "acceptedVersion",
        },
      ],
    ],
    translated: { url: "https://repository.example.org/manuscript.pdf" },
    response: (url) =>
      url.endsWith("/article")
        ? {
            status: 200,
            response: new TextEncoder().encode("<html>article</html>").buffer,
            headers: { "Content-Type": "text/html" },
          }
        : { status: 200, response: bytes.buffer },
  });
  const result = await new ZoteroLiteratureAcquirer(() => "").acquire(
    work(),
    new AbortController().signal,
    async () => {},
  );
  assert.equal(result.stage, "zotero");
  assert.equal(result.version, "acceptedVersion");
  assert.equal(
    result.sourceUrl,
    "https://repository.example.org/manuscript.pdf",
  );
  assert.equal(result.verification.method, "doi_title");
  assert.equal(f.imports.length, 1);
  assert.deepEqual(f.imports[0].bytes, bytes);
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.requests, [
    "https://repository.example.org/article",
    "https://repository.example.org/manuscript.pdf",
  ]);
});
test("mismatched and cancelled downloads never import, and rate-limit diagnostics survive fallback", async (t) => {
  const f = runtime(t, { text: "Another unrelated publication" });
  const acquirer = new ZoteroLiteratureAcquirer(() => "");
  await assert.rejects(
    acquirer.acquire(
      work({
        pdfUrls: [
          "https://repo.example.org/a.pdf",
          "https://repo.example.org/a.pdf",
        ],
      }),
      new AbortController().signal,
      async () => {},
    ),
    (error) =>
      error.code === "identity_mismatch" &&
      error.attempts.filter((a) => a.method === "http").length === 1,
  );
  assert.equal(f.requests.filter((url) => url.endsWith("a.pdf")).length, 1);
  assert.equal(f.imports.length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    acquirer.acquire(work(), controller.signal, async () => {}),
    { code: "cancelled" },
  );
  globalThis.Zotero.HTTP.request = async () => ({ status: 429 });
  await assert.rejects(
    acquirer.acquire(
      work({ pdfUrls: ["https://repo.example.org/b.pdf"] }),
      new AbortController().signal,
      async () => {},
    ),
    { code: "rate_limit" },
  );
  assert.equal(f.imports.length, 0);
});

test("older page-translator entry points remain usable", async (t) => {
  const f = runtime(t, {
    resolvers: [{ pageURL: "https://repository.example.org/article" }],
    response: (url) =>
      url.endsWith("/article")
        ? {
            status: 200,
            response: new TextEncoder().encode("<html>article</html>").buffer,
            headers: { "Content-Type": "text/html" },
          }
        : { status: 200, response: bytes.buffer },
  });
  delete globalThis.Zotero.Utilities.Internal.getFileFromDocument;
  let called = 0;
  globalThis.Zotero.Utilities.Internal.getPDFFromDocument = async () => {
    called++;
    return { url: "https://repository.example.org/legacy.pdf" };
  };
  const result = await new ZoteroLiteratureAcquirer(() => "").acquire(
    work(),
    new AbortController().signal,
    async () => {},
  );
  assert.equal(result.stage, "zotero");
  assert.equal(called, 1);
  assert.equal(f.imports.length, 1);
});
test("legacy resolver API is feature-detected and manual drops use identity verification", async (t) => {
  const f = runtime(t);
  delete globalThis.Zotero.Attachments.getFileResolvers;
  globalThis.Zotero.Attachments.getPDFResolvers = () => [
    "https://repository.example.org/file.pdf",
  ];
  const acquirer = new ZoteroLiteratureAcquirer(() => "");
  assert.equal(
    (
      await acquirer.acquire(
        work(),
        new AbortController().signal,
        async () => {},
      )
    ).stage,
    "zotero",
  );
  f.files.set("/drop.pdf", bytes);
  globalThis.Zotero.PDFWorker._query = async () => ({
    totalPages: 1,
    text: "Wrong article",
  });
  await assert.rejects(acquirer.attach(work(), "/drop.pdf"), {
    code: "identity_mismatch",
  });
  assert.equal(f.imports.length, 1);
  assert.equal(f.files.has("/drop.pdf"), true);
});

function serviceFixture(t, options = {}) {
  const rt = runtime(t, options);
  const storage = memoryJsonStorage();
  let candidateDownloads = 0;
  const fulltext = {
    search: async () => ({ results: [{ id: "link1" }] }),
    open: async () => ({ links: [] }),
    candidate: () => ({
      url: "https://repo.example.org/new.pdf",
      kind: "pdf",
      version: "unknown",
    }),
    remove() {},
  };
  const service = new LiteratureService({
    storage,
    client: {},
    fulltext,
    exists: () => true,
    canConfirm() {},
    bind: async () => {},
    changed: async () => {},
    acquire: {
      ensureItem: async () => work().acquisition.item,
      attach: async () => "DROP",
      acquire: async () => {
        throw new LiteratureError("unavailable", "missing");
      },
      acquireCandidate: async () => {
        candidateDownloads++;
        return {
          attachmentKey: "PDF",
          stage: "agent",
          version: "unknown",
          sourceUrl: "https://repo.example.org/new.pdf",
        };
      },
    },
  });
  const pool = {
    version: 1,
    taskId: "task",
    revision: 1,
    candidateRevision: 1,
    confirmedRevision: 1,
    confirmedIds: ["W1"],
    works: [work()],
    queries: [],
    updatedAt: 1,
  };
  return {
    ...rt,
    service,
    storage,
    pool,
    fulltext,
    downloads: () => candidateDownloads,
  };
}

test("relative and malformed translator links do not discard valid page downloads", async (t) => {
  runtime(t);
  const element = {
    getAttribute: (name) =>
      ({ name: "citation_pdf_url", content: "/valid.pdf" })[name] ?? null,
    textContent: "",
  };
  const doc = { querySelectorAll: () => [element] };
  for (const url of ["/translated.pdf", "http://[", "javascript:alert(1)"]) {
    globalThis.Zotero.Utilities.Internal.getFileFromDocument = async () => ({
      url,
    });
    const candidates = await translatedCandidates(
      doc,
      "https://repo.example.org/article",
      new AbortController().signal,
    );
    assert.ok(
      candidates.some((c) => c.url === "https://repo.example.org/valid.pdf"),
    );
    if (url.startsWith("/"))
      assert.equal(
        candidates[0].url,
        "https://repo.example.org/translated.pdf",
      );
  }
});

test("storage failures stop background acquisition without an automatic retry loop", async (t) => {
  const f = serviceFixture(t);
  f.pool.works[0].acquisition.status = "queued";
  await f.storage.write("task", f.pool);
  const write = f.storage.write.bind(f.storage);
  let failures = 0;
  f.storage.write = async (...args) => {
    if (failures < 8) {
      failures++;
      throw new Error("Disk unavailable");
    }
    return write(...args);
  };
  f.service.start("task");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    failures,
    3,
    "two failed workers plus one bounded recovery save",
  );
  assert.equal(f.service.jobs.size, 0);
});

test("a stopped download releases fulltext waits even when recovery cannot be saved", async (t) => {
  const f = serviceFixture(t);
  f.pool.works[0].acquisition.status = "queued";
  await f.storage.write("task", f.pool);
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  f.service.options.acquire.acquire = async () => {
    entered();
    await proceed;
    return { attachmentKey: "PDF", stage: "open_access" };
  };
  f.service.start("task");
  await ready;
  const controller = new AbortController();
  let settled = false;
  const waiting = f.service
    .waitForFulltext("task", "run", controller.signal)
    .then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
  await new Promise((resolve) => setImmediate(resolve));
  f.storage.write = async () => {
    throw new Error("Disk unavailable");
  };
  const job = f.service.jobs.get("task").work;
  release();
  await job;
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = settled;
  controller.abort();
  await waiting;
  assert.equal(
    stopped,
    true,
    "the model must not wait forever for a stopped worker",
  );
});

test("DNS cancellation survives native cancellation errors and synchronous callbacks", async (t) => {
  runtime(t);
  for (const mode of ["throw", "callback"]) {
    globalThis.Services.dns.asyncResolve = (
      _host,
      _type,
      _flags,
      _info,
      listener,
    ) => ({
      cancel() {
        if (mode === "throw") throw new Error("DNS already stopped");
        listener.onLookupComplete({}, null, 1);
      },
    });
    const controller = new AbortController();
    const pending = checkPublicHost(
      "https://repo.example.org/article",
      controller.signal,
    );
    const rejected = assert.rejects(pending, { code: "cancelled" });
    controller.abort();
    await rejected;
  }
});

test("reserved IPv6 addresses cannot bypass checks with expanded notation", () => {
  for (const address of [
    "2001:0db8::1",
    "2001:0000::1",
    "3000:garbage",
    "8..8.8",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});

test("malformed search rows do not discard usable Tavily results", async (t) => {
  runtime(t, {
    response: () => ({
      status: 200,
      response: new TextEncoder().encode(
        JSON.stringify({
          results: [
            null,
            { url: "https://repo.example.org/article.pdf", title: "Paper" },
          ],
        }),
      ).buffer,
    }),
  });
  const results = await tavilySearch(
    "paper",
    "key",
    new AbortController().signal,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://repo.example.org/article.pdf");
  globalThis.Zotero.HTTP.request = async () => ({
    status: 200,
    response: new TextEncoder().encode("null").buffer,
    getResponseHeader: () => "application/json",
  });
  await assert.rejects(
    tavilySearch("paper", "key", new AbortController().signal),
    { code: "network" },
  );
});

test("browser cleanup failures preserve the acquisition error and release other resources", async (t) => {
  runtime(t);
  for (const failed of [
    "observer-add",
    "observer-remove",
    "mime-remove",
    "browser-destroy",
    "cookie-dispose",
  ]) {
    const released = [];
    const cleanup = (name) => {
      released.push(name);
      if (name === failed) throw new Error(name);
    };
    globalThis.Services.obs = {
      addObserver() {
        if (failed === "observer-add") throw new Error("observer-add");
      },
      removeObserver: () => cleanup("observer-remove"),
    };
    globalThis.Zotero.HTTP.newCookieContext = () => ({
      id: 998,
      dispose: () => cleanup("cookie-dispose"),
    });
    globalThis.Zotero.BrowserRequest = { _makePDFMIMETypeHandler: () => ({}) };
    globalThis.Zotero.MIMETypeHandler = {
      addHandlers() {},
      removeHandlers: () => cleanup("mime-remove"),
    };
    globalThis.ChromeUtils = {
      importESModule: () => ({
        HiddenBrowser: class {
          _createdPromise = Promise.resolve();
          _browser = {};
          async load() {
            throw new Error("load failed");
          }
          destroy() {
            cleanup("browser-destroy");
          }
        },
      }),
    };
    const browser = new LiteratureBrowser();
    await assert.rejects(
      browser.read(
        "https://publisher.example.org/article",
        new AbortController().signal,
      ),
      { message: failed === "observer-add" ? "observer-add" : "load failed" },
    );
    assert.doesNotThrow(() => browser.dispose());
    assert.equal(browser.hasSession, false);
    browser.dispose();
    assert.equal(
      released.filter((name) => name === "cookie-dispose").length,
      1,
    );
    assert.ok(released.includes("browser-destroy"), failed);
    if (failed !== "observer-add")
      assert.ok(released.includes("mime-remove"), failed);
  }
});

test("a failing native resolver factory still allows repository discovery", async (t) => {
  const f = runtime(t, {
    response: (url) =>
      url.includes("europepmc")
        ? {
            status: 200,
            response: new TextEncoder().encode(
              JSON.stringify({
                resultList: {
                  result: [
                    {
                      doi: "10.1234/test",
                      fullTextUrlList: {
                        fullTextUrl: [
                          {
                            url: "https://repo.example.org/article.pdf",
                            availabilityCode: "OA",
                            documentStyle: "pdf",
                          },
                        ],
                      },
                    },
                  ],
                },
              }),
            ).buffer,
          }
        : { status: 200, response: bytes.buffer },
  });
  globalThis.Zotero.Attachments.getFileResolvers = () => {
    throw new Error("resolver unavailable");
  };
  const result = await new ZoteroLiteratureAcquirer(() => "").acquire(
    work(),
    new AbortController().signal,
    async () => {},
  );
  assert.equal(result.attachmentKey, "PDF1");
  assert.ok(
    result.attempts.some(
      (attempt) => attempt.stage === "zotero" && attempt.error === "network",
    ),
  );
  assert.equal(f.imports.length, 1);
});

test("malformed repository result shapes remain a recorded failure rather than crashing acquisition", async (t) => {
  const replies = [
    null,
    { resultList: { result: {} } },
    { resultList: { result: [null] } },
    {
      resultList: {
        result: [{ doi: "10.1234/test", fullTextUrlList: { fullTextUrl: {} } }],
      },
    },
  ];
  runtime(t, {
    response: () => ({
      status: 200,
      response: new TextEncoder().encode(JSON.stringify(replies.shift()))
        .buffer,
    }),
  });
  for (let i = 0; i < 4; i++) {
    const attempts = [];
    assert.deepEqual(
      await repositoryCandidates(
        work(),
        new AbortController().signal,
        attempts,
      ),
      [],
    );
    assert.equal(attempts[0].error, "unavailable");
  }
});

test("malformed repository rows preserve matching links from valid rows", async (t) => {
  runtime(t, {
    response: () => ({
      status: 200,
      response: new TextEncoder().encode(
        JSON.stringify({
          resultList: {
            result: [
              null,
              { doi: "10.1234/test", fullTextUrlList: { fullTextUrl: {} } },
              {
                doi: "10.1234/test",
                fullTextUrlList: {
                  fullTextUrl: [
                    null,
                    {
                      url: "https://repo.example.org/article.pdf",
                      availabilityCode: "OA",
                      documentStyle: "pdf",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ).buffer,
    }),
  });
  const attempts = [];
  const candidates = await repositoryCandidates(
    work(),
    new AbortController().signal,
    attempts,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://repo.example.org/article.pdf");
  assert.equal(attempts[0].error, "unavailable");
});

test("identity merges preserve a PDF receipt returned by an in-flight native import", async (t) => {
  const f = serviceFixture(t);
  f.pool.works = [
    work({ doi: undefined }),
    work({
      id: "W2",
      openAlexIds: ["W2"],
      acquisition: { status: "missing" },
      decision: { selected: false, actor: "user", revision: 1 },
    }),
  ];
  await f.storage.write("task", f.pool);
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.service.options.acquire.acquireCandidate = () =>
    new Promise((resolve) => {
      entered();
      release = () => resolve({ attachmentKey: "PDF", stage: "agent" });
    });
  const pending = f.service.downloadFulltext("task", "W1", "link1");
  await ready;
  f.service.options.client.search = async () => ({ works: [work()], total: 1 });
  await f.service.search("task", { query: "joined identity" });
  release();
  const receipt = await pending;
  assert.equal(receipt.id, "W2");
  assert.equal(receipt.acquisition.status, "available");
  assert.equal(receipt.acquisition.attachmentKey, "PDF");
});

test("one failed worker does not stop tracking another active worker", async (t) => {
  const f = serviceFixture(t);
  f.pool.works[0].acquisition.status = "queued";
  await f.storage.write("task", f.pool);
  const write = f.storage.write.bind(f.storage);
  let failed = false,
    entered,
    release;
  f.storage.write = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("Transient disk error");
    }
    return write(...args);
  };
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.service.options.acquire.acquire = () =>
    new Promise((resolve) => {
      entered();
      release = () => resolve({ attachmentKey: "PDF", stage: "open_access" });
    });
  f.service.start("task");
  const original = f.service.jobs.get("task");
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  const stillTracked = f.service.jobs.get("task") === original;
  release();
  await original.work;
  assert.equal(stillTracked, true);
  assert.equal(
    (await f.service.get("task", "W1")).acquisition.status,
    "available",
  );
});

test("missing repository manuscript metadata does not assert a published version", async (t) => {
  runtime(t, {
    response: (url) => ({
      status: 200,
      response: new TextEncoder().encode(
        url.includes("europepmc")
          ? JSON.stringify({
              resultList: {
                result: [{ doi: "10.1234/test", pmcid: "PMC123" }],
              },
            })
          : url.includes("list-type")
            ? "<CommonPrefixes><Prefix>PMC123.2/</Prefix></CommonPrefixes>"
            : JSON.stringify({
                doi: "10.1234/test",
                pdf_url: "https://repo.example.org/article.pdf",
              }),
      ).buffer,
    }),
  });
  const links = await repositoryCandidates(
    work(),
    new AbortController().signal,
    [],
  );
  assert.equal(links.find((link) => link.kind === "pdf").version, "unknown");
});

test("cancelling while exploration loads its pool prevents a new download", async (t) => {
  const f = serviceFixture(t);
  await f.storage.write("task", f.pool);
  const original = f.storage.read.bind(f.storage);
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  let pause = true;
  f.storage.read = async (key) => {
    const value = await original(key);
    if (key === "task" && pause) {
      pause = false;
      entered();
      await proceed;
    }
    return value;
  };
  const pending = f.service.downloadFulltext("task", "W1", "link1");
  const rejected = assert.rejects(pending, { code: "cancelled" });
  await ready;
  await f.service.cancel("task");
  release();
  await rejected;
  assert.equal(f.downloads(), 0);
});

test("a failed browser challenge attempt is not immediately rendered a second time", async (t) => {
  runtime(t, {
    response: () => ({
      status: 200,
      response: new TextEncoder().encode("<html>challenge</html>").buffer,
      headers: { "Content-Type": "text/html" },
    }),
    doc: {
      title: "Challenge",
      body: { textContent: "Please verify you are human" },
      querySelector: () => ({}),
      querySelectorAll: () => [],
    },
  });
  const agent = new LiteratureFulltextAgent();
  const paper = work({ landingUrl: "https://publisher.example.org/article" });
  const known = await agent.search(
    "task",
    paper,
    1,
    "title",
    new AbortController().signal,
  );
  let renders = 0;
  globalThis.Zotero.HTTP.newCookieContext = () => ({ id: 900, dispose() {} });
  globalThis.Zotero.BrowserRequest = { _makePDFMIMETypeHandler: () => ({}) };
  globalThis.Zotero.MIMETypeHandler = { addHandlers() {}, removeHandlers() {} };
  globalThis.Services.obs = { addObserver() {}, removeObserver() {} };
  globalThis.ChromeUtils = {
    importESModule: () => ({
      HiddenBrowser: class {
        _createdPromise = Promise.resolve();
        _browser = {};
        async load() {
          renders++;
          throw new LiteratureError("network", "Browser failed");
        }
        destroy() {}
      },
    }),
  };
  await assert.rejects(
    agent.open(
      "task",
      paper,
      1,
      known.knownSources[0].id,
      new AbortController().signal,
    ),
    /Browser failed/,
  );
  assert.equal(renders, 1);
});
test("AI tools enforce confirmation, cancellation, source revision and user continuation at the host", async (t) => {
  const f = serviceFixture(t);
  await f.storage.write("task", f.pool);
  assert.equal(
    (await f.service.searchFulltext("task", "W1", "title")).results.length,
    1,
  );
  assert.equal(
    (await f.service.downloadFulltext("task", "W1", "link1")).acquisition
      .attachmentKey,
    "PDF",
  );
  assert.equal(f.downloads(), 1);
  for (const modify of [
    (p) => {
      p.confirmedIds = [];
    },
    (p) => {
      p.candidateRevision = 2;
    },
    (p) => {
      p.continuation = {
        candidateRevision: 1,
        mode: "current",
        ids: ["W1"],
        at: 1,
      };
    },
    (p) => {
      p.works[0].acquisition.error = "cancelled";
    },
    (p) => {
      p.works[0].acquisition.status = "queued";
    },
  ]) {
    const pool = structuredClone(f.pool);
    modify(pool);
    await f.storage.write("task", pool);
    await assert.rejects(f.service.downloadFulltext("task", "W1", "link1"));
  }
  assert.equal(f.downloads(), 1);
  const childTools = new LiteratureToolProvider(f.service, "task", true);
  assert.equal(
    childTools.listTools().some((d) => d.name.endsWith("_fulltext")),
    false,
  );
});
test("waiting acquisition returns failed papers to the model for bounded exploration", async (t) => {
  const f = serviceFixture(t);
  await f.storage.write("task", f.pool);
  await f.service.waitForFulltext("task", "run", new AbortController().signal);
  assert.equal(
    (await f.service.acquisitionResult("task")).summary.awaitingFulltext,
    false,
  );
});

test("candidate edits cancel in-flight AI acquisition before it can import", async (t) => {
  const f = serviceFixture(t);
  await f.storage.write("task", f.pool);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.service.options.acquire.acquireCandidate = async (
    _work,
    _candidate,
    signal,
  ) => {
    started();
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new LiteratureError("cancelled", "Cancelled")),
        { once: true },
      ),
    );
  };
  const pending = f.service.downloadFulltext("task", "W1", "link1");
  await ready;
  await f.service.updateCandidates(
    "task",
    1,
    [{ id: "W1", selected: false, reason: "Changed selection" }],
    "user",
  );
  const result = await pending;
  assert.equal(result.acquisition.error, "cancelled");
  assert.equal(f.downloads(), 0);
});

test("a PDF drop that succeeds during an AI request keeps its available receipt", async (t) => {
  const f = serviceFixture(t);
  await f.storage.write("task", f.pool);
  let reject, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.service.options.acquire.acquireCandidate = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
      started();
    });
  const pending = f.service.downloadFulltext("task", "W1", "link1");
  await ready;
  await f.service.attach("task", "W1", "/user-file.pdf");
  reject(new LiteratureError("network", "Late failure"));
  const result = await pending;
  assert.equal(result.acquisition.status, "available");
  assert.equal(result.acquisition.attachmentKey, "DROP");
});
test("AI navigation accepts only observed per-paper links and exposes search challenges", async (t) => {
  runtime(t, {
    doc: { querySelector: () => ({}), querySelectorAll: () => [] },
  });
  const agent = new LiteratureFulltextAgent(),
    paper = work({ landingUrl: "https://repo.example.org/article" });
  const result = await agent.search(
    "task",
    paper,
    1,
    "title",
    new AbortController().signal,
  );
  assert.equal(result.searchError.code, "authentication");
  assert.equal(result.knownSources.length, 2);
  assert.equal(result.untrustedContent, true);
  await assert.rejects(
    agent.open(
      "task",
      paper,
      1,
      "https://evil.org/a",
      new AbortController().signal,
    ),
  );
  assert.throws(() =>
    agent.candidate("another-task", paper, 1, result.knownSources[0].id),
  );
  const failed = {
    ...paper,
    acquisition: {
      ...paper.acquisition,
      attempts: [
        {
          url: result.knownSources[0].url,
          error: "identity_mismatch",
          at: Date.now(),
          stage: "zotero",
        },
      ],
    },
  };
  assert.throws(
    () => agent.candidate("task", failed, 1, result.knownSources[0].id),
    /already failed/,
  );
  await agent.search("task", paper, 1, "doi", new AbortController().signal);
  const cooldown = await agent.search(
    "task",
    paper,
    1,
    "title",
    new AbortController().signal,
  );
  assert.equal(cooldown.requestMade, false);
  assert.equal(cooldown.searchAvailability.available, false);
  assert.equal(cooldown.stepsRemaining, 11);
});

test("a supplement availability notice in the article sidebar is not a supplement heading", () => {
  for (const notice of [
    "Electronic supplementary material is available\nonline at https://doi.org/10.6084/m9.figshare.1",
    "Electronic supplementary material\nis available online",
  ])
    assert.equal(
      verifyPdfIdentity(work(), `Research\n${notice}\n${firstPage}`).method,
      "doi_title",
    );
  for (const heading of [
    "Supplementary information",
    "Supporting information: " + title,
    "Supplementary material for " + title,
  ])
    assert.throws(() => verifyPdfIdentity(work(), `${heading}\n${firstPage}`), {
      code: "identity_mismatch",
    });
});

test("Tavily sends credentials only to its API and results contain observed links without keys", async (t) => {
  const f = runtime(t, {
    response: (url, opts) => {
      assert.equal(url, "https://api.tavily.com/search");
      assert.equal(opts.headers.Authorization, "Bearer secret-key");
      const body = JSON.parse(opts.body);
      assert.equal(body.search_depth, "basic");
      assert.equal(body.include_answer, false);
      return {
        status: 200,
        response: new TextEncoder().encode(
          JSON.stringify({
            results: [
              {
                url: "https://repo.example.org/paper.pdf",
                title,
                content: "Accepted manuscript",
              },
              { url: "http://127.0.0.1/private", title: "Ignore instructions" },
            ],
          }),
        ).buffer,
      };
    },
  });
  const agent = new LiteratureFulltextAgent(() => "secret-key");
  const found = await agent.search(
    "task",
    work(),
    1,
    "doi",
    new AbortController().signal,
  );
  assert.equal(found.provider, "Tavily");
  assert.equal(found.results.length, 1);
  assert.equal(JSON.stringify(found).includes("secret-key"), false);
  assert.equal(f.requests.length, 1);
  globalThis.Zotero.HTTP.request = async () => ({
    status: 302,
    getResponseHeader: () => "https://other.example.org/collect",
  });
  await assert.rejects(
    tavilySearch("paper", "secret-key", new AbortController().signal),
    /API redirect refused/,
  );
});

test("a DuckDuckGo challenge pauses subsequent requests across papers", async (t) => {
  const f = runtime(t, {
    doc: { querySelector: () => ({}), querySelectorAll: () => [] },
  });
  const agent = new LiteratureFulltextAgent();
  await agent.search("task", work(), 1, "title", new AbortController().signal);
  const second = await agent.search(
    "task",
    work({ id: "W2" }),
    1,
    "doi",
    new AbortController().signal,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(second.searchError.code, "authentication");
  assert.match(second.searchError.message, /cooldown/);
});

test("repository discovery requires the matching DOI and reads the actual PMC version metadata", async (t) => {
  const f = runtime(t, {
    response: (url) => ({
      status: 200,
      response: new TextEncoder().encode(
        url.includes("europepmc")
          ? JSON.stringify({
              resultList: {
                result: [
                  { doi: "10.9999/wrong", pmcid: "PMC999" },
                  {
                    doi: "10.1234/test",
                    pmcid: "PMC123",
                    fullTextUrlList: { fullTextUrl: [] },
                  },
                ],
              },
            })
          : url.includes("list-type")
            ? "<ListBucketResult><CommonPrefixes><Prefix>PMC123.2/</Prefix></CommonPrefixes></ListBucketResult>"
            : JSON.stringify({
                doi: "10.1234/test",
                pdf_url:
                  "https://pmc-oa-opendata.s3.amazonaws.com/PMC123.2/article.pdf",
                is_manuscript: "yes",
              }),
      ).buffer,
    }),
  });
  const attempts = [];
  const links = await repositoryCandidates(
    work(),
    new AbortController().signal,
    attempts,
  );
  assert.equal(links.length, 2);
  assert.equal(links[1].version, "acceptedVersion");
  assert.equal(
    f.requests.some((u) => u.includes("PMC999")),
    false,
  );
  assert.equal(
    f.requests.some((u) => u.includes("PMC123.1")),
    false,
  );
  assert.equal(
    attempts.every((a) => a.method === "repository"),
    true,
  );
});

test("browser cancellation cleans native listeners, cookies and suspended network requests", async (t) => {
  runtime(t, { addresses: () => ["127.0.0.1"] });
  // Initial navigation is public; the page then attempts a private subresource.
  let observer,
    removed = 0,
    destroyed = 0,
    disposed = 0,
    handlerRemoved = 0;
  globalThis.Services.dns.asyncResolve = (
    host,
    _type,
    _flags,
    _info,
    listener,
  ) => {
    let remaining = true;
    queueMicrotask(() =>
      listener.onLookupComplete(
        {},
        {
          QueryInterface: () => ({
            hasMore: () => remaining,
            getNextAddrAsString: () => {
              remaining = false;
              return host === "publisher.example.org"
                ? "93.184.216.34"
                : "127.0.0.1";
            },
          }),
        },
        0,
      ),
    );
    return { cancel() {} };
  };
  globalThis.Services.obs = {
    addObserver: (o) => {
      observer = o;
    },
    removeObserver: (o) => {
      assert.equal(o, observer);
      removed++;
    },
  };
  globalThis.Zotero.HTTP.newCookieContext = () => ({
    id: 998,
    dispose: () => disposed++,
  });
  globalThis.Zotero.BrowserRequest = { _makePDFMIMETypeHandler: () => ({}) };
  globalThis.Zotero.MIMETypeHandler = {
    addHandlers() {},
    removeHandlers: () => handlerRemoved++,
  };
  let loaded;
  const ready = new Promise((resolve) => {
    loaded = resolve;
  });
  globalThis.ChromeUtils = {
    importESModule: () => ({
      HiddenBrowser: class {
        _createdPromise = Promise.resolve();
        _browser = {};
        load() {
          loaded();
          return new Promise(() => {});
        }
        destroy() {
          destroyed++;
        }
      },
    }),
  };
  const controller = new AbortController(),
    browser = new LiteratureBrowser();
  const pending = browser.read(
    "https://publisher.example.org/article",
    controller.signal,
  );
  await ready;
  let cancelled = 0,
    resumed = 0;
  const channel = {
    loadInfo: { originAttributes: { userContextId: 998 } },
    URI: { spec: "https://internal-target.example.org/private" },
    suspend() {},
    cancel: () => cancelled++,
    resume: () => resumed++,
  };
  observer.observe({ QueryInterface: () => channel });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(resumed, 1);
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  browser.dispose();
  assert.equal(removed, 1);
  assert.equal(destroyed, 1);
  assert.equal(disposed, 1);
  assert.equal(handlerRemoved, 1);
});

test("review files repeating the full article identity cannot be imported as the article", async (t) => {
  assert.throws(
    () =>
      verifyPdfIdentity(
        work(),
        `Reports © The Reviewers\nReview History\n${firstPage}`,
      ),
    { code: "identity_mismatch" },
  );
  for (const name of [
    "rspb20192298_review_history.pdf",
    "rspb20192298supp1.pdf",
    "supplementary.pdf",
  ])
    assert.equal(ancillaryFile(`https://repo.example.org/${name}`), true);
  assert.equal(
    ancillaryFile("https://repo.example.org/rspb20192298.pdf"),
    false,
  );
  const f = runtime(t);
  await assert.rejects(
    new ZoteroLiteratureAcquirer(() => "").acquireCandidate(
      work(),
      {
        url: "https://repo.example.org/paper_review_history.pdf",
        kind: "pdf",
        version: "unknown",
      },
      new AbortController().signal,
    ),
    { code: "identity_mismatch" },
  );
  assert.equal(f.requests.length, 0);
  assert.equal(f.imports.length, 0);
});

const anchor = (href, text, extra = {}) => ({
  textContent: text,
  getAttribute: (name) => ({ href, ...extra })[name] ?? null,
  hasAttribute: (name) => name in extra,
});
const page = (links = [], text = "Public article description ".repeat(20)) => ({
  title: "Article",
  body: { textContent: text },
  querySelector: () => null,
  querySelectorAll: (selector) => (selector.includes("a[href]") ? links : []),
});
function cookieBrowser() {
  const jars = new Set(),
    created = [],
    disposed = [],
    loads = [];
  globalThis.Services.obs = { addObserver() {}, removeObserver() {} };
  globalThis.Zotero.HTTP.newCookieContext = () => {
    const id = created.length + 1;
    created.push(id);
    return {
      id,
      dispose() {
        jars.delete(id);
        disposed.push(id);
      },
    };
  };
  globalThis.Zotero.BrowserRequest = { _makePDFMIMETypeHandler: () => ({}) };
  globalThis.Zotero.MIMETypeHandler = { addHandlers() {}, removeHandlers() {} };
  globalThis.ChromeUtils = {
    importESModule: () => ({
      HiddenBrowser: class {
        _createdPromise = Promise.resolve();
        _browser = {};
        currentURI = { spec: "about:blank" };
        constructor(options) {
          this.id = options.userContextId;
        }
        async load(url) {
          loads.push(url);
          this.currentURI.spec = url;
          jars.add(this.id);
        }
        async getPageData() {
          return { documentHTML: "RENDERED" + " ".repeat(220) };
        }
        destroy() {}
      },
    }),
  };
  return { jars, created, disposed, loads };
}
function realExploration(t, paper, rtOptions = {}) {
  const f = serviceFixture(t, rtOptions);
  // Keep the service fixture but use the real host, transport and PDF verifier.
  const agent = new LiteratureFulltextAgent();
  f.service.fulltext = agent;
  f.service.options.acquire = new ZoteroLiteratureAcquirer(() => "");
  f.pool.works = [paper];
  t.after(() => agent.dispose());
  return { ...f, agent };
}

test("a rendered landing-page session reaches verified download and is disposed on success", async (t) => {
  const url = "https://repo.example.org/article",
    pdf = "https://repo.example.org/download/42";
  let jars;
  const paper = work({ landingUrl: url });
  paper.acquisition.attempts = [
    {
      url: pdf,
      error: "authentication",
      at: Date.now() - 100,
      stage: "zotero",
    },
  ];
  const f = realExploration(t, paper, {
    response: (target, options) => {
      if (target === pdf)
        return {
          status: jars.has(options.userContextId) ? 200 : 403,
          response: bytes.buffer,
        };
      return { status: 403, response: new ArrayBuffer(0) };
    },
  });
  const browser = cookieBrowser();
  jars = browser.jars;
  globalThis.Zotero.Utilities.Internal.blobToHTMLDocument = async () =>
    page([anchor("/download/42", "Download PDF")]);
  await f.storage.write("task", f.pool);
  const found = await f.service.searchFulltext("task", paper.id, "title");
  const opened = await f.service.openFulltext(
    "task",
    paper.id,
    found.knownSources[0].id,
  );
  assert.equal(jars.size, 1);
  const link = opened.links.find((l) => l.kind === "pdf");
  const receipt = await f.service.downloadFulltext("task", paper.id, link.id);
  assert.equal(receipt.acquisition.status, "available");
  assert.equal(receipt.acquisition.verification.method, "doi_title");
  assert.equal(f.imports.length, 1);
  assert.equal(f.requests.filter((u) => u === pdf).length, 1);
  assert.equal(jars.size, 0);
  assert.equal(browser.disposed.length, 1);
  assert.equal(JSON.stringify(opened).includes("userContextId"), false);
});

test("opening a 6 MiB PDF enables one fresh retry and download reuses bytes while still verifying identity", async (t) => {
  const pdf = "https://repo.example.org/large.pdf";
  const large = new TextEncoder().encode(
    "%PDF-1.7\n" + "x".repeat(6 * 1024 * 1024) + "\n%%EOF",
  );
  const paper = work({ landingUrl: pdf });
  paper.acquisition.attempts = [
    { url: pdf, stage: "zotero", error: "network", at: Date.now() - 100 },
  ];
  const f = realExploration(t, paper, {
    response: (url) => ({
      status: url === pdf ? 200 : 403,
      response: large.buffer,
    }),
  });
  await f.storage.write("task", f.pool);
  const found = await f.service.searchFulltext("task", paper.id, "title");
  const link = found.knownSources[0].id;
  assert.throws(
    () => f.agent.candidate("task", paper, 1, link),
    /already failed/,
  );
  const opened = await f.service.openFulltext("task", paper.id, link);
  assert.equal(opened.isPdf, true);
  assert.ok(JSON.stringify(opened).length < 500);
  const receipt = await f.service.downloadFulltext("task", paper.id, link);
  assert.equal(receipt.acquisition.status, "available");
  assert.equal(f.requests.filter((u) => u === pdf).length, 1);
  assert.equal(f.imports[0].bytes.length, large.length);
  assert.throws(
    () => f.agent.candidate("task", paper, 1, link),
    /already failed/,
  );
});

test("a cached PDF with a mismatched identity cannot be imported", async (t) => {
  const pdf = "https://repo.example.org/wrong.pdf",
    paper = work({ landingUrl: pdf });
  const f = realExploration(t, paper, {
    text: "An entirely different article",
    response: (url) => ({
      status: url === pdf ? 200 : 403,
      response: bytes.buffer,
    }),
  });
  await f.storage.write("task", f.pool);
  const found = await f.service.searchFulltext("task", paper.id, "title");
  await f.service.openFulltext("task", paper.id, found.knownSources[0].id);
  const receipt = await f.service.downloadFulltext(
    "task",
    paper.id,
    found.knownSources[0].id,
  );
  assert.equal(receipt.acquisition.error, "identity_mismatch");
  assert.equal(f.imports.length, 0);
  assert.equal(f.requests.filter((u) => u === pdf).length, 1);
});

test("HTML retains its 5 MiB limit even though PDF reads allow 100 MiB", async (t) => {
  runtime(t, {
    response: () => ({
      status: 200,
      response: new Uint8Array(6 * 1024 * 1024).buffer,
      headers: { "Content-Type": "text/html" },
    }),
  });
  await assert.rejects(
    requestFulltext(
      "https://repo.example.org/page",
      new AbortController().signal,
      { maxHtmlBytes: 5 * 1024 * 1024 },
    ),
    { code: "invalid_pdf" },
  );
});

test("script-only pages render, and an observed meta refresh follows only a public bounded target", async (t) => {
  runtime(t, {
    response: () => ({
      status: 200,
      response: new TextEncoder().encode("STATIC").buffer,
      headers: { "Content-Type": "text/html" },
    }),
  });
  const browser = cookieBrowser(),
    agent = new LiteratureFulltextAgent();
  t.after(() => agent.dispose());
  globalThis.Zotero.Utilities.Internal.blobToHTMLDocument = async (blob) => {
    if ((await blob.text()).startsWith("RENDERED"))
      return page([anchor("/download/42", "Download PDF")]);
    const doc = page([], "window.location.replace('article')".repeat(40));
    doc.querySelectorAll = (selector) =>
      selector.includes("script, style")
        ? [
            {
              remove() {
                doc.body.textContent = "";
              },
            },
          ]
        : [];
    return doc;
  };
  const paper = work({ landingUrl: "https://repo.example.org/script-only" });
  const found = await agent.search(
    "task",
    paper,
    1,
    "title",
    new AbortController().signal,
  );
  const opened = await agent.open(
    "task",
    paper,
    1,
    found.knownSources[0].id,
    new AbortController().signal,
  );
  assert.equal(browser.loads.length, 1);
  assert.ok(opened.text.length > 200);
  assert.equal(opened.links[0].kind, "pdf");
  let requested = [];
  globalThis.Zotero.HTTP.request = async (_method, url) => {
    requested.push(url);
    return {
      status: 200,
      response: new TextEncoder().encode(
        url.endsWith("/refresh") ? "REFRESH" : "ARTICLE",
      ).buffer,
      getResponseHeader: () => "text/html",
    };
  };
  globalThis.Zotero.Utilities.Internal.blobToHTMLDocument = async (blob) => {
    const doc = page([anchor("/download/42", "Download PDF")]);
    if ((await blob.text()) === "REFRESH") {
      doc.querySelectorAll = (selector) =>
        selector === "meta[http-equiv]"
          ? [
              anchor("", "", {
                "http-equiv": "REFRESH",
                content: "2; URL='/article'",
              }),
            ]
          : [];
    }
    return doc;
  };
  const next = work({
    id: "W2",
    landingUrl: "https://repo.example.org/refresh",
  });
  const known = await agent.search(
    "task",
    next,
    1,
    "title",
    new AbortController().signal,
  );
  await agent.open(
    "task",
    next,
    1,
    known.knownSources[0].id,
    new AbortController().signal,
  );
  assert.deepEqual(requested, [
    "https://repo.example.org/refresh",
    "https://repo.example.org/article",
  ]);
});

test("only explicit article PDF links enter deterministic candidates; supplements and generic download menus do not", async (t) => {
  runtime(t);
  const candidates = await translatedCandidates(
    page([
      anchor("/download/42", "Download PDF"),
      anchor("/asset/43", "View PDF", { download: "paper.pdf" }),
      anchor("/download/44", "Download PDF – Supplementary information"),
      anchor("/downloads", "Downloads"),
    ]),
    "https://repo.example.org/article",
    new AbortController().signal,
  );
  assert.deepEqual(
    candidates.map((c) => c.url),
    [
      "https://repo.example.org/download/42",
      "https://repo.example.org/asset/43",
    ],
  );
});

test("session resources are released on revision, cancellation, deletion and idle expiry without resetting budgets", async (t) => {
  const f = serviceFixture(t),
    agent = new LiteratureFulltextAgent(() => "", 10);
  f.service.fulltext = agent;
  t.after(() => agent.dispose());
  const browser = cookieBrowser();
  const paper = work({ landingUrl: "https://repo.example.org/article" });
  const found = await agent.search(
    "task",
    paper,
    1,
    "title",
    new AbortController().signal,
  );
  const transfer = agent.transfer("task", paper, 1, found.knownSources[0].id);
  // Install a native context without waiting for a page render in this lifecycle test.
  transfer.browser.context = globalThis.Zotero.HTTP.newCookieContext();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  assert.equal(browser.disposed.length, 1);
  const afterIdle = await agent.search(
    "task",
    paper,
    1,
    "doi",
    new AbortController().signal,
  );
  assert.equal(afterIdle.stepsRemaining, 11);
  transfer.browser.context = globalThis.Zotero.HTTP.newCookieContext();
  await agent.search("task", paper, 2, "doi", new AbortController().signal);
  assert.equal(browser.disposed.length, 2);
  agent.transfer("task", paper, 2, "unused").browser.context =
    globalThis.Zotero.HTTP.newCookieContext();
  await f.service.cancel("task");
  assert.equal(browser.disposed.length, 3);
  agent.transfer("task", paper, 2, "unused").browser.context =
    globalThis.Zotero.HTTP.newCookieContext();
  agent.remove("task");
  assert.equal(browser.disposed.length, 4);
});

test("provider cooldown is shared, does not consume paper budgets, and a new key restores bounded searches", async (t) => {
  let key = "bad-key";
  const f = runtime(t, {
    doc: { querySelector: () => ({}), querySelectorAll: () => [] },
    response: (url, opts) => ({
      status:
        url.includes("tavily") &&
        opts.headers.Authorization === "Bearer bad-key"
          ? 401
          : 200,
      response: new TextEncoder().encode(JSON.stringify({ results: [] }))
        .buffer,
    }),
  });
  const agent = new LiteratureFulltextAgent(() => key);
  t.after(() => agent.dispose());
  const first = await agent.search(
    "task",
    work(),
    1,
    "doi",
    new AbortController().signal,
  );
  assert.equal(first.searchAvailability.available, false);
  assert.ok(first.searchAvailability.retryAt > Date.now());
  const second = await agent.search(
    "task",
    work({ id: "W2" }),
    1,
    "doi",
    new AbortController().signal,
  );
  assert.equal(second.requestMade, false);
  assert.equal(second.stepsRemaining, 12);
  assert.equal(f.requests.length, 2);
  key = "new-key";
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await agent.search(
          "task",
          work(),
          1,
          "doi",
          new AbortController().signal,
        )
      ).provider,
      "Tavily",
    );
  await assert.rejects(
    agent.search("task", work(), 1, "doi", new AbortController().signal),
    /two queries/,
  );
  assert.equal(JSON.stringify(first).includes("bad-key"), false);
});

test("tool status lists filter failures and exclude verbose evidence while detail attempts remain paged", async (t) => {
  const f = serviceFixture(t);
  const attempts = Array.from({ length: 45 }, (_, at) => ({
    at,
    stage: "zotero",
    error: "network",
    url: "https://repo.example.org/" + "long".repeat(100),
  }));
  f.pool.works[0].abstract = "abstract ".repeat(1000);
  f.pool.works[0].acquisition.attempts = attempts;
  f.pool.works.push(
    work({
      id: "W2",
      acquisition: { status: "available", attachmentKey: "PDF" },
    }),
  );
  await f.storage.write("task", f.pool);
  const tool = new LiteratureToolProvider(f.service, "task");
  const result = await tool.call("literature_list", {
    status: "failed",
    view: "status",
  });
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].abstract, undefined);
  assert.equal(result.data.items[0].acquisition.attemptCount, 45);
  assert.equal(result.data.items[0].acquisition.attempts, undefined);
  assert.ok(JSON.stringify(result).length < 2000);
  const detail = await tool.call("literature_get", {
    id: "W1",
    attemptOffset: 10,
  });
  assert.equal(detail.data.acquisition.attempts.length, 10);
  assert.equal(detail.data.acquisition.attempts[0].at, 10);
  assert.equal(detail.data.acquisition.nextAttemptOffset, 20);
  assert.equal(
    (await f.service.get("task", "W1")).acquisition.attempts.length,
    45,
  );
});

test("explicit PDF version evidence overrides stale source labels, while article prose cannot promote versions", async (t) => {
  runtime(t, { text: `Document Version\nPublisher’s version\n${firstPage}` });
  const result = await new ZoteroLiteratureAcquirer(() => "").acquireCandidate(
    work(),
    {
      url: "https://repo.example.org/file.pdf",
      kind: "pdf",
      version: "submittedVersion",
    },
    new AbortController().signal,
  );
  assert.equal(result.version, "publishedVersion");
  globalThis.Zotero.PDFWorker._query = async () => ({
    totalPages: 2,
    text: `${firstPage}\nThis analysis compares the published version to a preprint.`,
  });
  const unknown = await new ZoteroLiteratureAcquirer(() => "").acquireCandidate(
    work(),
    {
      url: "https://repo.example.org/other.pdf",
      kind: "pdf",
      version: "unknown",
    },
    new AbortController().signal,
  );
  assert.equal(unknown.version, "unknown");
});

test("limited browser fallback prioritizes repository pages beyond failed DOI and index URLs", async (t) => {
  const f = runtime(t, {
    response: (url) => ({
      status: url.includes("europepmc") ? 200 : 403,
      response: new TextEncoder().encode(
        JSON.stringify({ resultList: { result: [] } }),
      ).buffer,
    }),
  });
  globalThis.Zotero.HTTP.newCookieContext = () => ({ id: 123, dispose() {} });
  globalThis.Zotero.BrowserRequest = { _makePDFMIMETypeHandler() {} };
  const rendered = [];
  t.mock.method(LiteratureBrowser.prototype, "read", async function (url) {
    rendered.push(url);
    if (url.includes("repository"))
      return { bytes, url, contentType: "application/pdf" };
    throw new LiteratureError("authentication", "Requires login");
  });
  const urls = [
    "https://doi.org/10.1234/test",
    "https://index.example.org/record",
    "https://publisher.example.org/article",
    "https://repository.example.org/handle/42",
  ];
  const result = await new ZoteroLiteratureAcquirer(() => "").acquire(
    work({
      locations: urls.map((landingUrl) => ({
        landingUrl,
        version: "unknown",
        openAccess: false,
      })),
    }),
    new AbortController().signal,
    async () => {},
  );
  assert.equal(result.sourceUrl, urls[3]);
  assert.deepEqual(rendered, [urls[3]]);
  assert.equal(f.imports.length, 1);
});
