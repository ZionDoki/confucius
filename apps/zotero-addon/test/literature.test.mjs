import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { URL } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import {
  OpenAlexClient,
  LiteratureError,
  openAlexWork,
  normalizeDoi,
  openAlexFailure,
  zoteroOpenAlexTransport,
} from "../src/modules/host/OpenAlexClient.ts";
import { LiteratureService } from "../src/modules/host/LiteratureService.ts";
import { LiteratureToolProvider } from "../src/modules/host/LiteratureToolProvider.ts";
import { shortlistWorks } from "../src/modules/host/LiteratureRanking.ts";
import { SubagentResearchTools } from "../src/modules/host/SubagentTools.ts";
import {
  LiteratureAbstracts,
  abstractText,
} from "../src/modules/host/LiteratureAbstracts.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";
import {
  validPdf,
  ZoteroLiteratureAcquirer,
} from "../src/modules/host/LiteratureAcquisition.ts";
import {
  emptyLockedContext,
  featuredTemplatesForContext,
} from "@confucius/protocol";

const raw = (i, extra = {}) => ({
  id: `https://openalex.org/W${1000 + i}`,
  title: `Paper ${i}`,
  doi: `https://doi.org/10.1234/p${i}`,
  publication_year: 2020,
  authorships: [{ author: { display_name: "A" } }],
  abstract_inverted_index: { hello: [0], world: [1] },
  ...extra,
});
function fixture(options = {}) {
  const storage = memoryJsonStorage(),
    calls = [],
    items = [],
    downloads = [],
    bindings = [],
    summaries = [];
  const client = new OpenAlexClient(
    () => "secret",
    async (url, key) => {
      calls.push({ url, key });
      return {
        status: 200,
        data: {
          results: Array.from({ length: 100 }, (_, i) => raw(i)),
          meta: { count: 4000, next_cursor: "page2" },
        },
      };
    },
  );
  const service = new LiteratureService({
    client,
    storage,
    exists: () => true,
    canConfirm: () => {},
    changed: async (id, summary) => summaries.push(summary),
    bind: async (id, added, removed) => bindings.push({ added, removed }),
    acquire: {
      ensureItem: async (w) => {
        items.push(w.id);
        return {
          id: `item:1:${w.id}`,
          libraryID: 1,
          key: w.id,
          title: w.title,
          source: "library",
        };
      },
      acquire: async (w) => {
        downloads.push(w.id);
        return { attachmentKey: `pdf_${w.id}`, stage: "open_access" };
      },
      attach: async () => "dropped_pdf",
      ...options.acquire,
    },
    ...options,
  });
  return {
    service,
    client,
    storage,
    calls,
    items,
    downloads,
    bindings,
    summaries,
  };
}
async function selectOne(f) {
  await f.service.search("task", { query: "research" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "agent",
  );
}
/** Native Zotero items for a parent with PDF children, and file existence. */
function nativeItems(attachments, files, textByPath = new Map()) {
  const originalZotero = globalThis.Zotero,
    originalIOUtils = globalThis.IOUtils;
  globalThis.IOUtils = {
    exists: async (path) => files.has(path),
    stat: async () => ({ size: 1024 }),
    read: async (path) =>
      new TextEncoder().encode(
        `%PDF-1.7\n${textByPath.get(path) ?? "Accepted manuscript\nPaper 0\nA\nhttps://doi.org/10.1234/p0\nAbstract\nStudy text"}\n%%EOF`,
      ),
  };
  globalThis.Zotero = {
    PDFWorker: {
      _enqueue: (work) => work(),
      _query: async (_action, { buf }) => ({
        totalPages: 2,
        text: new TextDecoder().decode(buf),
      }),
    },
    Items: {
      getByLibraryAndKey: (_libraryID, key) =>
        key === "PARENT"
          ? { id: 1, getAttachments: () => attachments.map(({ id }) => id) }
          : false,
      get: (id) =>
        attachments.find((attachment) => attachment.id === id) ?? false,
      getAsync: async (id) =>
        attachments.find((attachment) => attachment.id === id) ?? false,
    },
  };
  return () => {
    globalThis.Zotero = originalZotero;
    globalThis.IOUtils = originalIOUtils;
  };
}
function pdfAttachment(key, path) {
  return {
    id: 9,
    key,
    isAttachment: () => true,
    isPDFAttachment: () => true,
    attachmentContentType: "application/pdf",
    getField: (name) =>
      name === "url" ? "https://repo.example.org/a.pdf" : "",
    getFilePathAsync: async () => path,
  };
}
function interruptedPool(acquisition) {
  return {
    version: 1,
    taskId: "task",
    revision: 1,
    candidateRevision: 1,
    confirmedIds: ["W1000"],
    works: [
      {
        id: "W1000",
        openAlexIds: [],
        doi: "10.1234/p0",
        title: "Paper 0",
        authors: ["A"],
        citedBy: 0,
        openAccess: true,
        pdfUrls: [],
        queryIds: [],
        decision: {
          selected: true,
          evaluated: true,
          actor: "user",
          revision: 1,
        },
        acquisition,
      },
    ],
    queries: [],
    updatedAt: 1,
  };
}
test("malformed OpenAlex records preserve usable results and report invalid response envelopes", async () => {
  const client = new OpenAlexClient(
    () => "",
    async () => ({
      status: 200,
      data: {
        results: [
          null,
          raw(0, { authorships: [null, { author: { display_name: "A" } }] }),
        ],
      },
    }),
  );
  const result = await client.search({ query: "paper" }, "query");
  assert.equal(result.works.length, 1);
  assert.deepEqual(result.works[0].authors, ["A"]);
  const invalid = new OpenAlexClient(
    () => "",
    async () => ({ status: 200, data: null }),
  );
  await assert.rejects(invalid.search({ query: "paper" }, "query"), {
    code: "network",
  });
});
test(
  "slow searches do not block continuing, and late pages preserve newer user decisions",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    await selectOne(f);
    let finish;
    f.client.search = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const searching = f.service.search("task", { query: "slow remote query" });
    await setImmediate();
    let continued = false;
    const choosing = f.service.continue("task", 1, "abstracts").then(() => {
      continued = true;
    });
    await setImmediate();
    const immediate = continued;
    if (immediate) {
      await f.service.updateCandidates(
        "task",
        1,
        [{ id: "W1001", selected: true, reason: "New user choice" }],
        "user",
      );
      await f.service.continue("task", 2, "abstracts");
    }
    finish({ works: [openAlexWork(raw(1), "remote")], total: 1, cursor: null });
    await Promise.all([searching, choosing]);
    assert.equal(
      immediate,
      true,
      "Continue must not wait for the remote search",
    );
    const work = await f.service.get("task", "W1001");
    assert.equal(work.decision.actor, "user");
    assert.equal(work.decision.selected, true);
    assert.equal(
      (await f.service.list("task")).summary.continuation,
      "abstracts",
    );
  },
);
test("a failed confirmation remains reviewable and cannot be mistaken for applied sources", async () => {
  let fail = true;
  const f = fixture({
    bind: async () => {
      if (fail) throw new Error("binding failed");
    },
  });
  await selectOne(f);
  await assert.rejects(f.service.confirm("task", 1), /binding failed/);
  const failed = await f.service.list("task");
  assert.equal(failed.summary.awaitingConfirmation, true);
  assert.deepEqual((await f.service.load("task")).confirmedIds, []);
  assert.equal(f.downloads.length, 0);
  fail = false;
  await f.service.confirm("task", 1);
  await f.service.cancel("task");
  assert.equal(
    (await f.service.list("task")).summary.awaitingConfirmation,
    false,
  );
  assert.deepEqual((await f.service.load("task")).confirmedIds, ["W1000"]);
  assert.equal(f.items.length, 1);
});
test(
  "a user can continue with abstracts, without import, binding, downloads or repeated waits",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    await selectOne(f);
    const tool = new LiteratureToolProvider(f.service, "task");
    let pauses = 0,
      resumes = 0;
    const pending = tool.call(
      "literature_acquire",
      { waitForFulltext: true },
      undefined,
      {
        runId: "run1",
        executionScope: { pause: () => pauses++, resume: () => resumes++ },
      },
    );
    await setImmediate();
    await f.service.continue("task", 1, "abstracts");
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(pauses, 1);
    assert.equal(resumes, 1);
    assert.equal(result.data.continuation.mode, "abstracts");
    assert.deepEqual(result.data.continuation.ids, ["W1000"]);
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.summary.awaitingConfirmation, false);
    assert.equal(result.data.summary.awaitingFulltext, false);
    assert.equal(result.data.summary.hasCandidateChanges, false);
    assert.equal(result.data.summary.abstracts, 1);
    assert.equal(result.data.summary.read, 0);
    assert.match(result.data.guidance, /Do not wait/);
    assert.equal(
      (await tool.call("literature_acquire", { waitForFulltext: true })).ok,
      true,
    );
    assert.deepEqual(f.items, []);
    assert.deepEqual(f.bindings, []);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual((await f.service.load("task")).confirmedIds, []);
  },
);
test(
  "early continue is durable, stale choices are rejected, and new candidates require a new decision",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    await selectOne(f);
    await assert.rejects(
      f.service.continue("task", 0, "abstracts"),
      /revision conflict/,
    );
    await assert.rejects(f.service.continue("task", 1, "invalid"), /Invalid/);
    await f.service.continue("task", 1, "abstracts");
    await f.service.recover("task");
    await f.service.requestConfirmation("task");
    await f.service.waitForConfirmation("task", 1);
    await f.service.waitForFulltext("task", "run");
    assert.equal((await f.service.load("task")).continuation.mode, "abstracts");
    await f.service.updateCandidates(
      "task",
      1,
      [{ id: "W1001", selected: true }],
      "user",
    );
    const next = await f.service.requestConfirmation("task");
    assert.equal(next.candidateRevision, 2);
    assert.equal(
      (await f.service.list("task")).summary.continuation,
      undefined,
    );
    assert.equal(
      (await f.service.list("task")).summary.awaitingConfirmation,
      true,
    );
    await f.service.continue("task", 2, "abstracts");
    await f.service.confirm("task", 2);
    assert.equal((await f.service.load("task")).continuation, undefined);
    await f.service.cancel("task");
    assert.equal(f.items.length, 2);
  },
);
test(
  "accepting current results releases the tool while a PDF download is still pending",
  { timeout: 2000 },
  async () => {
    let finish;
    const f = fixture({
      acquire: {
        ensureItem: async (w) => ({
          id: w.id,
          libraryID: 1,
          key: w.id,
          title: w.title,
          source: "library",
        }),
        acquire: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    await selectOne(f);
    await f.service.confirm("task", 1);
    const tool = new LiteratureToolProvider(f.service, "task");
    const pending = tool.call(
      "literature_acquire",
      { waitForFulltext: true },
      undefined,
      { runId: "run1" },
    );
    await setImmediate();
    assert.equal((await f.service.list("task")).summary.awaitingFulltext, true);
    await f.service.continue("task", 1, "current");
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.data.summary.awaitingFulltext, false);
    assert.equal(result.data.summary.available, 0);
    assert.equal(result.data.summary.acquiring, 1);
    assert.equal(result.data.continuation.mode, "current");
    finish({ attachmentKey: "PDF", stage: "open_access" });
    await setImmediate();
    assert.equal(
      (await f.service.get("task", "W1000")).acquisition.status,
      "available",
    );
    assert.equal((await f.service.list("task")).summary.read, 0);
    assert.equal(
      (await f.service.list("task")).summary.awaitingFulltext,
      false,
    );
    await f.service.cancel("task");
  },
);
test(
  "failed and stopped downloads can be accepted, and abort clears the live fulltext wait",
  { timeout: 2000 },
  async () => {
    const f = fixture({
      acquire: {
        ensureItem: async (w) => ({
          id: w.id,
          libraryID: 1,
          key: w.id,
          title: w.title,
          source: "library",
        }),
        acquire: async () => {
          throw new Error("offline");
        },
      },
    });
    await selectOne(f);
    await f.service.confirm("task", 1);
    await f.service.cancel("task");
    const abort = new globalThis.AbortController();
    const wait = f.service.waitForFulltext("task", "run1", abort.signal);
    await setImmediate();
    abort.abort();
    await assert.rejects(wait, /cancelled/);
    assert.equal(
      (await f.service.list("task")).summary.awaitingFulltext,
      false,
    );
    const retry = f.service.waitForFulltext("task", "run2");
    await setImmediate();
    await f.service.continue("task", 1, "current");
    assert.equal((await retry).summary.continuation, "current");
  },
);
test(
  "replacing a fulltext waiter does not let the old waiter clear the new one",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    await selectOne(f);
    const p = await f.service.load("task");
    p.confirmedIds = ["W1000"];
    await f.storage.write("task", p);
    const old = f.service.waitForFulltext("task", "run");
    const rejected = assert.rejects(old, /replaced/);
    await setImmediate();
    const latest = f.service.waitForFulltext("task", "run");
    await rejected;
    assert.equal((await f.service.list("task")).summary.awaitingFulltext, true);
    await f.service.continue("task", 1, "current");
    await latest;
  },
);
test(
  "missing abstract lookup is cached and never blocks continuing or alters selection/read evidence",
  { timeout: 2000 },
  async () => {
    let finish,
      lookups = 0;
    const f = fixture({
      abstracts: {
        resolve: async () => {
          lookups++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    await selectOne(f);
    const p = await f.service.load("task");
    delete p.works[0].abstract;
    await f.storage.write("task", p);
    const tool = new LiteratureToolProvider(f.service, "task", true);
    const lookup = tool.call("literature_get", { id: "W1000" });
    await setImmediate();
    const before = await f.service.continue("task", 1, "abstracts");
    assert.equal(before.summary.continuation, "abstracts");
    finish({
      abstract: "Retrieved abstract",
      abstractLookup: {
        status: "available",
        source: "crossref",
        checkedAt: Date.now(),
      },
    });
    const result = await lookup;
    assert.equal(result.ok, true);
    assert.equal(result.data.abstract, "Retrieved abstract");
    assert.equal(result.data.acquisition.status, "missing");
    assert.equal(result.data.decision.revision, 1);
    assert.equal((await f.service.list("task")).summary.read, 0);
    await tool.call("literature_get", { id: "W1000" });
    assert.equal(lookups, 1);
    assert.deepEqual(f.items, []);
    assert.deepEqual(f.downloads, []);
  },
);
test("unsuccessful metadata lookups have a cooldown and cancellation is not cached", async () => {
  let attempts = 0;
  const controller = new globalThis.AbortController();
  const f = fixture({
    abstracts: {
      resolve: async () => {
        attempts++;
        if (attempts === 1) controller.abort();
        return {
          abstractLookup: { status: "unavailable", checkedAt: Date.now() },
        };
      },
    },
  });
  await selectOne(f);
  const p = await f.service.load("task");
  delete p.works[0].abstract;
  await f.storage.write("task", p);
  await assert.rejects(
    f.service.getWithAbstract("task", "W1000", controller.signal),
    /Cancelled/,
  );
  assert.equal(
    (await f.service.get("task", "W1000")).abstractLookup,
    undefined,
  );
  await f.service.getWithAbstract("task", "W1000");
  await f.service.getWithAbstract("task", "W1000");
  assert.equal(attempts, 2);
  assert.equal((await f.service.get("task", "W1000")).abstract, undefined);
});
test("abstract fallback prefers exact local metadata and then OpenAlex before Crossref", async () => {
  const work = openAlexWork(raw(0), "q");
  const called = [];
  let local = "Local abstract",
    openalex;
  const resolver = new LiteratureAbstracts(
    {
      abstract: async () => {
        called.push("openalex");
        return openalex;
      },
    },
    async () => local,
    async (url, key) => {
      called.push("crossref");
      assert.equal(key, "");
      assert.match(url, /10\.1234%2Fp0$/);
      return {
        status: 200,
        data: {
          message: {
            DOI: "10.1234/P0",
            abstract: "<jats:p>Crossref &amp; evidence &#x3b1;.</jats:p>",
          },
        },
      };
    },
  );
  assert.equal((await resolver.resolve(work)).abstractLookup.source, "zotero");
  assert.deepEqual(called, []);
  local = undefined;
  openalex = "OpenAlex abstract";
  assert.equal(
    (await resolver.resolve(work)).abstractLookup.source,
    "openalex",
  );
  openalex = undefined;
  const result = await resolver.resolve(work);
  assert.equal(result.abstractLookup.source, "crossref");
  assert.equal(result.abstract, "Crossref & evidence α.");
});
test(
  "abstract lookups time out even for an uncooperative transport and can still use the next source",
  { timeout: 2000 },
  async () => {
    let aborted = false;
    const resolver = new LiteratureAbstracts(
      {
        abstract: (work, signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise(() => {});
        },
      },
      async () => undefined,
      async () => ({
        status: 200,
        data: { message: { DOI: "10.1234/p0", abstract: "Fallback" } },
      }),
      10,
    );
    const result = await resolver.resolve(openAlexWork(raw(0), "q"));
    assert.equal(aborted, true);
    assert.equal(result.abstract, "Fallback");
    const absent = new LiteratureAbstracts(
      { abstract: async () => undefined },
      async () => undefined,
      async () => ({
        status: 200,
        data: { message: { DOI: "10.1234/WRONG", abstract: "Not this paper" } },
      }),
    );
    assert.equal(
      (await absent.resolve(openAlexWork(raw(0), "q"))).abstract,
      undefined,
    );
  },
);
test(
  "aborting abstract retrieval stops fallback and never returns stale data",
  { timeout: 2000 },
  async () => {
    const controller = new globalThis.AbortController();
    let next = 0;
    const resolver = new LiteratureAbstracts(
      {
        abstract: async () => {
          controller.abort();
          return "late";
        },
      },
      async () => undefined,
      async () => {
        next++;
        return { status: 404 };
      },
    );
    await assert.rejects(
      resolver.resolve(openAlexWork(raw(0), "q"), controller.signal),
      /Cancelled/,
    );
    assert.equal(next, 0);
  },
);
test("single-work OpenAlex abstract refresh checks identity and cleans Crossref JATS as text", async () => {
  let value = raw(0);
  const client = new OpenAlexClient(
    () => "key",
    async (url, key) => {
      const request = new URL(url);
      assert.equal(
        request.origin + request.pathname,
        "https://api.openalex.org/works/W1000",
      );
      assert.match(
        request.searchParams.get("select"),
        /abstract_inverted_index/,
      );
      assert.equal(key, "key");
      return { status: 200, data: value };
    },
  );
  assert.equal(await client.abstract(openAlexWork(raw(0), "q")), "hello world");
  value = raw(1);
  assert.equal(await client.abstract(openAlexWork(raw(0), "q")), undefined);
  assert.equal(
    abstractText(
      "<jats:p>A &lt; B &#945;</jats:p><script>bad()</script><!-- hidden --><p>C</p>",
    ),
    "A < B α C",
  );
});
test("100 fetched papers, dedup, provenance, paging, independent candidates and API total", async () => {
  const f = fixture();
  let page = await f.service.search("task", { query: "research" });
  assert.equal(page.summary.pool, 100);
  assert.equal(page.queries[0].total, 4000);
  assert.equal(page.items.length, 20);
  assert.equal(page.nextOffset, 20);
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1001", selected: true, reason: "method match" }],
    "user",
  );
  page = await f.service.search("task", { query: "other" });
  assert.equal(page.summary.pool, 100);
  assert.equal(page.summary.candidates, 1);
  const work = await f.service.get("task", "W1001");
  assert.equal(work.queryIds.length, 2);
  assert.equal(work.decision.actor, "user");
  assert.equal(work.abstract, "hello world");
  await f.service.search("task", { query: "", queryId: page.queries[0].id });
  assert.match(f.calls.at(-1).url, /cursor=page2/);
  assert.deepEqual(f.items, []);
  assert.deepEqual(f.downloads, []);
  const local = await f.service.list("task", { filter: "Paper 99" });
  assert.equal(local.total, 1);
  assert.equal(f.calls.length, 3);
});
test("concurrent candidate edits reject stale revisions rather than overwrite a user", async () => {
  const { service } = fixture();
  await service.search("task", { query: "x" });
  const results = await Promise.allSettled([
    service.updateCandidates(
      "task",
      0,
      [{ id: "W1000", selected: true }],
      "user",
    ),
    service.updateCandidates(
      "task",
      0,
      [{ id: "W1000", selected: false }],
      "agent",
    ),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal((await service.get("task", "W1000")).decision.selected, true);
});
test("authenticated OpenAlex requests refuse redirects instead of trusting redirected JSON", async () => {
  const original = globalThis.Zotero;
  const calls = [];
  globalThis.Zotero = {
    HTTP: {
      request: async (method, url, options) => {
        calls.push({ method, url, options });
        return {
          status: 302,
          response: {
            results: [{ id: "https://openalex.org/W1", title: "Injected" }],
          },
          getResponseHeader: () => null,
        };
      },
    },
  };
  try {
    const client = new OpenAlexClient(() => "secret", zoteroOpenAlexTransport);
    await assert.rejects(client.search({ query: "paper" }, "q"), {
      code: "network",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.followRedirects, false);
    assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  } finally {
    globalThis.Zotero = original;
  }
});
test("one batch confirmation is required, versioned, repeatable, and removal only unbinds", async () => {
  const f = fixture();
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [
      { id: "W1000", selected: true },
      { id: "W1001", selected: true },
    ],
    "agent",
  );
  assert.equal(f.items.length, 0);
  assert.equal(f.downloads.length, 0);
  await assert.rejects(f.service.confirm("task", 0), /revision conflict/);
  await f.service.confirm("task", 1);
  await setImmediate();
  await f.service.cancel("task");
  await f.service.confirm("task", 1);
  await setImmediate();
  await f.service.cancel("task");
  assert.equal(f.items.length, 2);
  assert.equal(f.downloads.length, 2);
  await f.service.updateCandidates(
    "task",
    1,
    [{ id: "W1000", selected: false }],
    "user",
  );
  assert.equal((await f.service.load("task")).confirmedIds.length, 2);
  await f.service.confirm("task", 2);
  assert.equal(f.bindings.at(-1).removed[0].key, "W1000");
  assert.equal(f.items.length, 2);
});
test("cancel fences a confirmation still waiting for the pool lock", async () => {
  const memory = memoryJsonStorage();
  let blocked = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let markStarted;
  const writeStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const f = fixture({
    storage: {
      ...memory,
      write: async (key, value) => {
        if (blocked && key === "task") {
          markStarted();
          await gate;
        }
        return memory.write(key, value);
      },
    },
  });
  await selectOne(f);
  blocked = true;
  const editing = f.service.updateCandidates(
    "task",
    1,
    [{ id: "W1001", selected: true }],
    "user",
  );
  await writeStarted;
  const confirming = f.service.confirm("task", 2);
  await setImmediate();
  await f.service.cancel("task");
  release();
  await editing;
  await assert.rejects(confirming, { code: "cancelled" });
  const pool = await f.service.load("task");
  assert.equal(pool.confirmedRevision, undefined);
  assert.equal(pool.waiting, undefined);
  assert.deepEqual(f.items, []);
  assert.deepEqual(f.bindings, []);
  assert.deepEqual(f.downloads, []);
});

test("missing DOI remains valid, equal titles do not merge, equivalent DOIs do", async () => {
  const f = fixture({
    client: new OpenAlexClient(
      () => "",
      async () => ({
        status: 200,
        data: {
          results: [
            raw(0, { doi: null, title: "Equal" }),
            raw(1, { doi: null, title: "Equal" }),
            raw(2),
            raw(3, { doi: "10.1234/P2" }),
          ],
          meta: { count: 4 },
        },
      }),
    ),
  });
  const page = await f.service.search("task", { query: "x" });
  assert.equal(page.summary.pool, 3);
  assert.deepEqual(page.items[2].openAlexIds, ["W1002", "W1003"]);
});
test("OpenAlex normalization strips credentials, reconstructs abstracts, distinguishes OA/cache", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1234/AB"), "10.1234/ab");
  const w = openAlexWork(
    raw(0, {
      open_access: { is_oa: true },
      has_content: { pdf: false },
      content_urls: {
        pdf: "https://content.openalex.org/works/W1000.pdf?api_key=secret",
      },
    }),
    "q",
  );
  assert.equal(w.cachedPdfUrl, undefined);
  assert.equal(w.pdfUrls.length, 0);
  assert.equal(w.acquisition.status, "missing");
  assert.equal(openAlexFailure(401).code, "authentication");
  assert.equal(openAlexFailure(402).code, "quota");
  assert.equal(openAlexFailure(429).code, "rate_limit");
  assert.equal(JSON.stringify(w).includes("secret"), false);
});
test("HTML is never accepted as PDF, valid signature and trailer required", () => {
  assert.equal(
    validPdf(
      new globalThis.TextEncoder().encode("<html>please sign in</html>"),
    ),
    false,
  );
  assert.equal(
    validPdf(
      new globalThis.TextEncoder().encode(
        "%PDF-1.7\n" + "x".repeat(100) + "\n%%EOF",
      ),
    ),
    true,
  );
});
test("waiting acquisition is host-event-driven and cancellation wakes it", async () => {
  const f = fixture();
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "agent",
  );
  const tool = new LiteratureToolProvider(f.service, "task");
  const controller = new globalThis.AbortController();
  let pauses = 0,
    resumes = 0;
  const pending = tool.call("literature_acquire", {}, controller.signal, {
    executionScope: { pause: () => pauses++, resume: () => resumes++ },
  });
  await setImmediate();
  assert.equal(pauses, 1);
  assert.equal(f.items.length, 0);
  await f.service.confirm("task", 1);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(resumes, 1);
  await f.service.updateCandidates(
    "task",
    1,
    [{ id: "W1001", selected: true }],
    "agent",
  );
  const pending2 = tool.call("literature_acquire", {}, controller.signal);
  await setImmediate();
  controller.abort();
  assert.equal((await pending2).ok, false);
  await f.service.cancel("task");
});
test("partial download failure and targeted manual PDF do not launch research or duplicate items", async () => {
  const f = fixture({
    acquire: {
      ensureItem: async (w) => ({
        libraryID: 1,
        key: w.id,
        title: w.title,
        id: w.id,
        source: "library",
      }),
      acquire: async () => {
        throw new Error("offline");
      },
      attach: async () => "PDF001",
    },
  });
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "user",
  );
  await f.service.confirm("task", 1);
  await setImmediate();
  await f.service.cancel("task");
  assert.equal(
    (await f.service.get("task", "W1000")).acquisition.status,
    "failed",
  );
  await f.service.attach("task", "W1000", "/test.pdf");
  assert.equal(
    (await f.service.get("task", "W1000")).acquisition.attachmentKey,
    "PDF001",
  );
  assert.deepEqual((await f.service.get("task", "W1000")).reads, undefined);
  await assert.rejects(
    f.service.attach("task", "W1001", "/test.pdf"),
    /Confirm/,
  );
});
test("branch uses saved revision and later candidate choices are independent", async () => {
  const f = fixture();
  const page = await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "user",
  );
  await f.service.branch("task", "branch", page.summary.revision);
  assert.equal((await f.service.list("branch")).summary.candidates, 0);
  assert.equal((await f.service.list("task")).summary.candidates, 1);
});
test("featured presets depend on explicit source scope", () => {
  const context = emptyLockedContext();
  assert.deepEqual(featuredTemplatesForContext(context), []);
  context.items = [{ key: "one", libraryID: 1 }];
  assert.deepEqual(
    featuredTemplatesForContext(context).map((t) => t.id),
    ["deep-read", "evidence-audit"],
  );
  context.items.push({ key: "two", libraryID: 1 });
  assert.deepEqual(
    featuredTemplatesForContext(context).map((t) => t.id),
    ["synthesis"],
  );
});

test("rate limit backoff is bounded and daily quota errors do not retry", async () => {
  let attempts = 0;
  const delays = [];
  const client = new OpenAlexClient(
    () => "host-secret",
    async () => ({
      status: ++attempts < 3 ? 429 : 200,
      data: { results: [], meta: { count: 0 } },
    }),
    async (ms) => {
      delays.push(ms);
    },
  );
  await client.search({ query: "test" }, "q");
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(attempts, 3);
  attempts = 0;
  const exhausted = new OpenAlexClient(
    () => "host-secret",
    async () => {
      attempts++;
      return {
        status: 429,
        remaining: "0",
        data: { error: "daily budget exceeded" },
      };
    },
  );
  await assert.rejects(
    exhausted.search({ query: "test" }, "q"),
    (e) => e.code === "quota" && !String(e).includes("host-secret"),
  );
  assert.equal(attempts, 1);
});

test("only a previously waiting research call resumes after a targeted PDF is supplied", async () => {
  const f = fixture({
    acquire: {
      ensureItem: async (w) => ({
        libraryID: 1,
        key: w.id,
        title: w.title,
        id: w.id,
        source: "library",
      }),
      acquire: async () => {
        throw new Error("missing");
      },
      attach: async () => "PDF001",
    },
  });
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "user",
  );
  await f.service.confirm("task", 1);
  await setImmediate();
  await f.service.cancel("task");
  let resumed = false;
  const waiting = f.service.waitForFulltext("task", "run1").then(() => {
    resumed = true;
  });
  await setImmediate();
  assert.equal(resumed, false);
  await f.service.attach("task", "W1000", "/test.pdf");
  await waiting;
  assert.equal(resumed, true);
  assert.equal((await f.service.load("task")).waitingFulltext, undefined);
});

test("deleting a parent removes only its pool and keeps an independent branch", async () => {
  const f = fixture();
  const page = await f.service.search("task", { query: "x" });
  await f.service.branch("task", "branch", page.summary.revision);
  await f.service.remove("task");
  assert.equal(await f.storage.read("task"), null);
  assert.equal((await f.service.list("branch")).summary.pool, 100);
  await assert.rejects(f.service.list("task"), /no longer exists/);
});

test("library reuse requires an exact OpenAlex marker, not a matching ID prefix", async () => {
  const original = globalThis.Zotero;
  const item = (key, marker) => ({
    key,
    libraryID: 1,
    deleted: false,
    isRegularItem: () => true,
    getField: (field) => (field === "extra" ? marker : "Paper"),
  });
  globalThis.Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: class {
      addCondition() {}
      async search() {
        return [1, 2];
      }
    },
    Items: {
      getAsync: async (id) =>
        id === 1
          ? item("WRONG", "OpenAlex: W10001")
          : item("RIGHT", "OpenAlex: W1000"),
    },
  };
  try {
    const acquirer = new ZoteroLiteratureAcquirer(() => "");
    const result = await acquirer.ensureItem(
      openAlexWork(raw(0, { doi: null }), "q"),
    );
    assert.equal(result.key, "RIGHT");
  } finally {
    globalThis.Zotero = original;
  }
});

test("failed native import can be retried individually using the confirmed authorization", async () => {
  let calls = 0;
  const f = fixture({
    acquire: {
      ensureItem: async (w) => {
        if (++calls === 1) throw new Error("Temporary database failure");
        return {
          libraryID: 1,
          key: w.id,
          title: w.title,
          id: w.id,
          source: "library",
        };
      },
      acquire: async () => ({ attachmentKey: "PDF", stage: "existing" }),
      attach: async () => "PDF",
    },
  });
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "user",
  );
  await f.service.confirm("task", 1);
  await setImmediate();
  assert.equal(
    (await f.service.get("task", "W1000")).acquisition.item,
    undefined,
  );
  await f.service.retry("task", "W1000");
  await setImmediate();
  assert.equal(
    (await f.service.get("task", "W1000")).acquisition.status,
    "available",
  );
  assert.equal(f.bindings.at(-1).added[0].key, "W1000");
  assert.equal(calls, 2);
});

test("a late download failure cannot replace a successfully dropped PDF", async () => {
  let rejectDownload;
  const f = fixture({
    acquire: {
      ensureItem: async (w) => ({
        libraryID: 1,
        key: w.id,
        title: w.title,
        id: w.id,
        source: "library",
      }),
      acquire: () =>
        new Promise((resolve, reject) => {
          rejectDownload = reject;
        }),
      attach: async () => "DROPPED",
    },
  });
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1000", selected: true }],
    "user",
  );
  await f.service.confirm("task", 1);
  await setImmediate();
  await f.service.attach("task", "W1000", "/valid.pdf");
  rejectDownload(new Error("Late timeout"));
  await setImmediate();
  const work = await f.service.get("task", "W1000");
  assert.equal(work.acquisition.status, "available");
  assert.equal(work.acquisition.attachmentKey, "DROPPED");
  assert.equal(work.acquisition.stage, "browser");
});

test("the confirmation boundary belongs only to its live run, not a durable waiting flag", async () => {
  const f = fixture();
  const controller = new globalThis.AbortController();
  await f.service.requestConfirmation("task");
  assert.equal(f.service.isWaitingForConfirmation("task", "run1"), false);
  const wait = f.service.waitForConfirmation(
    "task",
    0,
    controller.signal,
    "run1",
  );
  assert.equal(f.service.isWaitingForConfirmation("task", "run1"), true);
  assert.equal(f.service.isWaitingForConfirmation("task", "run2"), false);
  controller.abort();
  assert.equal(f.service.isWaitingForConfirmation("task", "run1"), false);
  await assert.rejects(wait, /Cancelled/);
});

test("fulltext acquisition runs two workers and stopping includes queued papers", async () => {
  const running = [];
  const f = fixture({
    acquire: {
      ensureItem: async (w) => ({
        libraryID: 1,
        key: w.id,
        title: w.title,
        id: w.id,
        source: "library",
      }),
      acquire: (work, signal) =>
        new Promise((resolve, reject) => {
          running.push(work.id);
          signal.addEventListener(
            "abort",
            () => reject(new Error("Cancelled")),
            { once: true },
          );
        }),
      attach: async () => "PDF",
    },
  });
  await f.service.search("task", { query: "x" });
  await f.service.updateCandidates(
    "task",
    0,
    [0, 1, 2].map((i) => ({ id: `W${1000 + i}`, selected: true })),
    "user",
  );
  await f.service.confirm("task", 1);
  await setImmediate();
  assert.equal(running.length, 2);
  await f.service.cancel("task");
  assert.equal(
    (await f.service.load("task")).works.filter(
      (w) => w.acquisition.error === "cancelled",
    ).length,
    3,
  );
});

test("lightweight card anchor and draft status survive reload without embedding the pool", async () => {
  const f = fixture();
  const page = await f.service.search("task", {
    query: "methods",
    fromYear: 2020,
    toYear: 2026,
  });
  assert.deepEqual(page.summary.latestQuery, {
    id: page.queries[0].id,
    query: "methods",
    fromYear: 2020,
    toYear: 2026,
    openAccess: undefined,
    total: 4000,
    createdAt: page.queries[0].createdAt,
  });
  assert.equal(page.summary.hasCandidateChanges, false);
  await f.service.updateCandidates(
    "task",
    0,
    [{ id: "W1001", selected: true, reason: "relevant" }],
    "user",
  );
  assert.equal(
    (await f.service.list("task")).summary.hasCandidateChanges,
    true,
  );
  await f.service.confirm("task", 1);
  assert.equal(
    (await f.service.list("task")).summary.hasCandidateChanges,
    false,
  );
  assert.equal(JSON.stringify(f.summaries.at(-1)).includes("Paper 1"), false);
});

test("provides one complete review snapshot and signals only newly discovered paper IDs", async () => {
  const arrivals = [],
    f = fixture({ changed: async (id, summary, ids) => arrivals.push(ids) });
  await f.service.search("review", { query: "paper" });
  const page = await f.service.review("review");
  assert.equal(page.items.length, 100);
  assert.equal(page.summary.pool, 100);
  assert.equal(page.total, 100);
  assert.equal(page.nextOffset, null);
  assert.deepEqual(
    arrivals[0],
    page.items.map((w) => w.id),
  );
  await f.service.search("review", { query: "deduplicated" });
  assert.equal(
    arrivals[1],
    undefined,
    "Repeated identities never replay arrivals",
  );
  await f.service.updateCandidates("review", page.summary.candidateRevision, [
    { id: page.items[0].id, selected: true },
  ]);
  assert.equal(arrivals[2], undefined, "Candidate choices are not discoveries");
  const revised = await f.service.review("review");
  assert.equal(revised.summary.candidates, 1);
  assert.equal(revised.items[0].decision.selected, true);
  assert.equal(revised.queries.length, 2);
  revised.items[0].decision.selected = false;
  assert.equal(
    (await f.service.get("review", revised.items[0].id)).decision.selected,
    true,
    "The UI cannot mutate service records through its snapshot",
  );
});

test("a restart reconciles a PDF attached before the pool save instead of reporting none", async () => {
  const f = fixture({ acquire: new ZoteroLiteratureAcquirer(() => "") });
  const item = { id: "item:1:PARENT", libraryID: 1, key: "PARENT" };
  await f.storage.write(
    "task",
    interruptedPool({
      status: "downloading",
      item,
      stage: "open_access",
      attempts: [
        { stage: "open_access", url: "https://repo.example.org/a.pdf", at: 1 },
      ],
    }),
  );
  // Startup recovery marks interrupted work failed before operations reconcile.
  await f.service.recover("task");
  assert.equal(
    (await f.service.get("task", "W1000")).acquisition.status,
    "failed",
  );
  const attachment = pdfAttachment("NATIVE", "/storage/NATIVE/a.pdf");
  const restore = nativeItems([attachment], new Set(["/storage/NATIVE/a.pdf"]));
  try {
    const receipt = await f.service.reconcileDownload(
      "task",
      "W1000",
      "link-1",
    );
    assert.equal(receipt.ok, true);
    assert.equal(receipt.effect, "applied");
    assert.equal(receipt.data.reconciled, true);
    assert.equal(receipt.data.acquisition.attachmentKey, "NATIVE");
    const acquisition = (await f.service.get("task", "W1000")).acquisition;
    assert.equal(acquisition.status, "available");
    assert.equal(acquisition.attachmentKey, "NATIVE");
    assert.equal(acquisition.item.attachmentKey, "NATIVE");
    assert.equal(acquisition.error, undefined);
    assert.equal(acquisition.message, undefined);
    assert.equal(acquisition.attempts.length, 1);
  } finally {
    restore();
  }
});

test("native success is written back to the pool before reconcile returns applied", async () => {
  const f = fixture({ acquire: new ZoteroLiteratureAcquirer(() => "") });
  const item = { id: "item:1:PARENT", libraryID: 1, key: "PARENT" };
  await f.storage.write(
    "task",
    interruptedPool({
      status: "downloading",
      item,
      stage: "existing",
      version: "acceptedVersion",
      sourceUrl: "https://repo.example.org/a.pdf",
      discoveredFrom: "OpenAlex location",
      attempts: [
        { stage: "existing", url: "https://repo.example.org/a.pdf", at: 1 },
      ],
    }),
  );
  const attachment = pdfAttachment("NATIVE", "/storage/NATIVE/a.pdf");
  const restore = nativeItems([attachment], new Set(["/storage/NATIVE/a.pdf"]));
  try {
    const receipt = await f.service.reconcileDownload(
      "task",
      "W1000",
      "link-1",
    );
    assert.equal(receipt.effect, "applied");
    // The pool, not only the returned receipt, must record the delivered PDF.
    const acquisition = (await f.service.get("task", "W1000")).acquisition;
    assert.equal(acquisition.status, "available");
    assert.equal(acquisition.attachmentKey, "NATIVE");
    assert.equal(acquisition.version, "acceptedVersion");
    assert.equal(acquisition.sourceUrl, "https://repo.example.org/a.pdf");
    assert.equal(acquisition.discoveredFrom, "OpenAlex location");
    const summary = (await f.service.list("task")).summary;
    assert.equal(summary.available, 1);
    assert.equal(summary.acquiring, 0);
    // A later restart must not turn the persisted success back into a failure.
    await f.service.recover("task");
    assert.equal(
      (await f.service.get("task", "W1000")).acquisition.status,
      "available",
    );
  } finally {
    restore();
  }
});

test("a native attachment record without its file is not a saved PDF", async () => {
  const f = fixture({ acquire: new ZoteroLiteratureAcquirer(() => "") });
  const item = { id: "item:1:PARENT", libraryID: 1, key: "PARENT" };
  await f.storage.write(
    "task",
    interruptedPool({ status: "downloading", item }),
  );
  const attachment = pdfAttachment("NATIVE", "/storage/NATIVE/missing.pdf");
  const restore = nativeItems([attachment], new Set());
  try {
    const interrupted = await f.service.reconcileDownload(
      "task",
      "W1000",
      "link-1",
    );
    assert.equal(interrupted.effect, "none");
    assert.equal(
      (await f.service.get("task", "W1000")).acquisition.status,
      "downloading",
    );
    await f.service.recover("task");
    const failed = await f.service.reconcileDownload("task", "W1000", "link-1");
    assert.equal(failed.effect, "none");
    assert.equal(
      (await f.service.get("task", "W1000")).acquisition.status,
      "failed",
    );
  } finally {
    restore();
  }
});

for (const [kind, text] of [
  [
    "supplement",
    "Supplementary information\nPaper 0\nA\nhttps://doi.org/10.1234/p0\nAbstract",
  ],
  [
    "different paper",
    "An unrelated paper\nAnother Author\nhttps://doi.org/10.1234/other\nAbstract",
  ],
]) {
  test(`recovery does not promote an existing ${kind} to available fulltext`, async () => {
    const f = fixture({ acquire: new ZoteroLiteratureAcquirer(() => "") });
    const path = "/storage/UNRELATED/a.pdf";
    const restore = nativeItems(
      [pdfAttachment("UNRELATED", path)],
      new Set([path]),
      new Map([[path, text]]),
    );
    try {
      for (const attachmentKey of [undefined, "UNRELATED"]) {
        await f.storage.write(
          "task",
          interruptedPool({
            status: "downloading",
            item: { libraryID: 1, key: "PARENT" },
            attachmentKey,
          }),
        );
        await f.service.recover("task");
        const receipt = await f.service.reconcileDownload(
          "task",
          "W1000",
          "link-1",
        );
        assert.notEqual(receipt?.effect, "applied");
        assert.equal(
          (await f.service.get("task", "W1000")).acquisition.status,
          "failed",
        );
      }
    } finally {
      restore();
    }
  });
}

test("recovery keeps a native download unknown when no identity inspector is available", async () => {
  const f = fixture();
  await f.storage.write(
    "task",
    interruptedPool({
      status: "downloading",
      item: { libraryID: 1, key: "PARENT" },
    }),
  );
  const path = "/storage/NATIVE/a.pdf";
  const restore = nativeItems([pdfAttachment("NATIVE", path)], new Set([path]));
  try {
    assert.equal(
      await f.service.reconcileDownload("task", "W1000", "link-1"),
      null,
    );
    assert.equal(
      (await f.service.get("task", "W1000")).acquisition.status,
      "downloading",
    );
  } finally {
    restore();
  }
});

test("scoped search builds a bounded, filtered and reranked OpenAlex request", async () => {
  let requestUrl;
  const client = new OpenAlexClient(
    () => "",
    async (url) => {
      requestUrl = url;
      return {
        status: 200,
        data: {
          results: [
            raw(0, {
              relevance_score: 0.7,
              rerank_score: 0.95,
              fwci: 2.1,
              citation_normalized_percentile: {
                value: 97,
                is_in_top_1_percent: false,
                is_in_top_10_percent: true,
              },
              cited_by_percentile_year: { min: 75, max: 85 },
              publication_date: "2024-05-01",
              is_retracted: false,
            }),
          ],
          meta: { count: 1, reranked: true, next_cursor: "next" },
        },
      };
    },
  );
  const result = await client.search(
    {
      query: "graph neural networks",
      perPage: 25,
      rerank: true,
      hasAbstract: true,
      fromYear: 2020,
      toYear: 2026,
      openAccess: true,
    },
    "q",
  );
  const url = new URL(requestUrl);
  assert.equal(
    url.searchParams.get("search.title_abstract_keywords"),
    "graph neural networks",
  );
  assert.equal(url.searchParams.has("search"), false);
  assert.equal(url.searchParams.get("per_page"), "25");
  assert.equal(url.searchParams.get("sort"), "relevance_score:desc");
  assert.equal(url.searchParams.get("rerank"), "true");
  const select = url.searchParams.get("select");
  for (const field of [
    "abstract_inverted_index",
    "relevance_score",
    "rerank_score",
    "fwci",
    "citation_normalized_percentile",
    "cited_by_percentile_year",
    "is_retracted",
  ])
    assert.ok(select.includes(field), field);
  const filter = url.searchParams.get("filter");
  for (const part of [
    "is_retracted:false",
    "type:!paratext",
    "has_abstract:true",
    "publication_year:2020-2026",
    "open_access.is_oa:true",
  ])
    assert.ok(filter.includes(part), part);
  assert.equal(result.reranked, true);
  assert.deepEqual(result.works[0].queryScores.q, {
    relevanceScore: 0.7,
    rerankScore: 0.95,
  });
  assert.equal(result.works[0].fwci, 2.1);
  assert.deepEqual(result.works[0].citationNormalizedPercentile, {
    value: 97,
    isInTop1Percent: false,
    isInTop10Percent: true,
  });
  assert.deepEqual(result.works[0].citedByPercentileYear, {
    min: 75,
    max: 85,
  });
  assert.equal(result.works[0].publicationDate, "2024-05-01");
  const fallback = openAlexWork(
    raw(0, { relevance_score: 0.4, rerank_score: 0.99 }),
    "q",
    { reranked: false },
  );
  assert.deepEqual(fallback.queryScores.q, { relevanceScore: 0.4 });
});

test("search modes enforce semantic, sort and inclusion contracts", async () => {
  const urls = [];
  const client = new OpenAlexClient(
    () => "",
    async (url) => {
      urls.push(url);
      return { status: 200, data: { results: [], meta: { count: 0 } } };
    },
  );
  await client.search(
    {
      query: "a long natural-language research question",
      searchMode: "semantic",
    },
    "q",
  );
  const semantic = new URL(urls[0]);
  assert.equal(
    semantic.searchParams.get("search.semantic"),
    "a long natural-language research question",
  );
  assert.equal(semantic.searchParams.get("per_page"), "50");
  assert.equal(semantic.searchParams.has("sort"), false);
  await client.search(
    {
      query: "retractions",
      searchMode: "titleAbstract",
      perPage: 3,
      includeRetracted: true,
      includeParatext: true,
    },
    "q",
  );
  const included = new URL(urls[1]);
  assert.equal(
    included.searchParams.get("search.title_and_abstract"),
    "retractions",
  );
  assert.equal(included.searchParams.has("filter"), false);
  await client.search(
    { query: "broad evidence", searchMode: "fulltext", perPage: 3 },
    "q",
  );
  const broad = new URL(urls[2]);
  assert.equal(broad.searchParams.get("search"), "broad evidence");
  assert.match(broad.searchParams.get("filter"), /is_retracted:false/);
  await assert.rejects(
    client.search({ query: "x", searchMode: "semantic", sort: "date" }, "q"),
    /custom sort/,
  );
  await assert.rejects(
    client.search({ query: "x", searchMode: "semantic", rerank: true }, "q"),
    /Rerank/,
  );
  await assert.rejects(
    client.search({ query: "x", searchMode: "semantic", perPage: 51 }, "q"),
    /1–50/,
  );
  await assert.rejects(
    client.search({ query: "x", sort: "citations", rerank: true }, "q"),
    /Rerank/,
  );
  assert.equal(urls.length, 3);
});

test("anonymous cursor continuation fails before any network request", async () => {
  let calls = 0;
  const client = new OpenAlexClient(
    () => "",
    async () => {
      calls++;
      return { status: 401, data: {} };
    },
  );
  await assert.rejects(
    client.search({ query: "paper" }, "q", "next"),
    (error) => error.code === "authentication",
  );
  assert.equal(calls, 0);
});

test("equivalent queries reuse results while refresh and queryId remain explicit", async () => {
  const f = fixture();
  const first = await f.service.search("task", { query: " repeated " });
  await f.service.search("task", {
    query: "repeated",
    searchMode: "titleAbstractKeywords",
    perPage: 100,
    sort: "relevance",
  });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.load("task")).queries.length, 1);
  const cached = await f.service.search("task", { query: "repeated" });
  assert.equal(cached.queryId, first.queryId);
  assert.equal(f.calls.length, 1);
  const refreshed = await f.service.search("task", {
    query: "repeated",
    refresh: true,
  });
  assert.notEqual(refreshed.queryId, first.queryId);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service.load("task")).queries.length, 2);
  const afterRefresh = await f.service.search("task", { query: "repeated" });
  assert.equal(afterRefresh.queryId, refreshed.queryId);
  assert.equal(f.calls.length, 2);
  await f.service.search("task", { query: "", queryId: refreshed.queryId });
  assert.equal(f.calls.length, 3);
  assert.match(f.calls.at(-1).url, /cursor=page2/);
});

test("model shortlist is ranked and query-scoped without shrinking the UI pool", async () => {
  const f = fixture();
  const provider = new LiteratureToolProvider(f.service, "task");
  let calls = 0;
  f.client.search = async (_input, queryId) => {
    calls++;
    const second = calls === 2;
    return {
      works: Array.from({ length: 14 }, (_, index) => {
        const id = second && index > 0 ? 100 + index : index;
        const score = second ? 1 + index : index / 100;
        return openAlexWork(
          raw(id, {
            relevance_score: score,
            rerank_score: score + 0.1,
            fwci: index,
          }),
          queryId,
          { reranked: true },
        );
      }),
      total: 14,
      cursor: null,
      reranked: true,
    };
  };
  const first = await provider.call("literature_search", {
    query: "first",
    rerank: true,
  });
  assert.equal(first.ok, true);
  assert.equal(first.data.items.length, 10);
  assert.equal(first.data.total, 14);
  assert.equal(first.data.nextOffset, null);
  assert.equal(first.data.ranking.reranked, true);
  assert.equal(first.data.ranking.totalCandidates, 14);
  assert.deepEqual(
    first.data.items.map((work) => work.id),
    Array.from({ length: 10 }, (_, index) => `W${1013 - index}`),
  );
  assert.deepEqual(
    first.data.items.map((work) => work.presentation.rank),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  assert.equal((await f.service.review("task")).items.length, 14);
  const metadata = await provider.call("literature_search", {
    query: "first",
    rerank: true,
    view: "metadata",
  });
  assert.equal(metadata.data.items.length, 14);
  assert.equal(metadata.data.ranking, undefined);
  assert.equal(calls, 1);
  const capped = await provider.call("literature_list", {
    queryId: first.data.queryId,
    limit: 25,
  });
  assert.equal(capped.data.items.length, 12);
  assert.equal(capped.data.nextOffset, null);

  const firstQueryId = first.data.queryId;
  const second = await provider.call("literature_search", {
    query: "second",
    rerank: true,
  });
  const secondQueryId = second.data.queryId;
  assert.notEqual(secondQueryId, firstQueryId);
  assert.ok(
    second.data.items.every((work) => work.queryIds.includes(secondQueryId)),
  );
  assert.equal((await f.service.review("task")).items.length, 27);
  const shared = await f.service.get("task", "W1000");
  assert.equal(shared.queryScores[firstQueryId].rerankScore, 0.1);
  assert.equal(shared.queryScores[secondQueryId].rerankScore, 1.1);
  const firstView = await f.service.list("task", {
    queryId: firstQueryId,
    view: "shortlist",
    filter: "Paper 0",
  });
  assert.equal(
    firstView.items.find((work) => work.id === "W1000").presentation
      .rerankScore,
    0.1,
  );
  const latest = await provider.call("literature_list", {});
  assert.equal(latest.data.queryId, secondQueryId);
  assert.ok(
    latest.data.items.every((work) => work.queryIds.includes(secondQueryId)),
  );
});

test("explicit inclusions and OpenAlex failure details preserve intent", async () => {
  const f = fixture();
  const provider = new LiteratureToolProvider(f.service, "task");
  f.client.search = async (_input, queryId) => ({
    works: [
      openAlexWork(raw(0, { is_retracted: true, type: "paratext" }), queryId),
    ],
    total: 1,
    cursor: null,
    reranked: false,
  });
  const included = await provider.call("literature_search", {
    query: "retractions",
    includeRetracted: true,
    includeParatext: true,
  });
  assert.equal(included.ok, true);
  assert.equal(included.data.items.length, 1);
  assert.equal(included.data.items[0].isRetracted, true);

  const failingProvider = new LiteratureToolProvider(
    {
      search: async () => {
        throw new LiteratureError("rate_limit", "Retry later");
      },
    },
    "task",
  );
  const failure = await failingProvider.call("literature_search", {
    query: "paper",
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "timeout");
  assert.equal(failure.retryable, true);
  assert.deepEqual(failure.details, {
    providerCode: "rate_limit",
  });
});

test("shortlist respects explicit sorts and uses normalized impact only as a tiebreaker", () => {
  const makeWork = (id, overrides) => ({
    ...openAlexWork(raw(0), "q"),
    id,
    ...overrides,
  });
  const works = [
    makeWork("W1001", {
      fwci: 0.1,
      year: 2024,
      publicationDate: "2024-01-01",
      citedBy: 1,
      queryScores: { q: { relevanceScore: 0.5 } },
    }),
    makeWork("W1002", {
      year: 2026,
      publicationDate: "2026-01-01",
      citedBy: 2,
      fwci: 10,
      queryScores: { q: { relevanceScore: 0.5 } },
    }),
    makeWork("W1003", {
      year: 2020,
      publicationDate: "2020-01-01",
      citedBy: 100,
      fwci: 2,
      queryScores: { q: { relevanceScore: 0.5 } },
    }),
  ];
  const query = (sort) => ({
    id: "q",
    createdAt: 1,
    total: 3,
    cursor: null,
    pages: 1,
    query: "paper",
    sort,
  });
  assert.deepEqual(
    shortlistWorks(works, query("date")).items.map((work) => work.id),
    ["W1002", "W1001", "W1003"],
  );
  assert.deepEqual(
    shortlistWorks(works, query("citations")).items.map((work) => work.id),
    ["W1003", "W1002", "W1001"],
  );
  const relevance = shortlistWorks(works, query("relevance"), 2);
  assert.deepEqual(
    relevance.items.map((work) => work.id),
    ["W1002", "W1003"],
  );
  assert.equal(relevance.totalCandidates, 3);
});

test("cursor pages retain reranked scores and never compare them with raw text scores", async () => {
  const f = fixture();
  let calls = 0;
  f.client.search = async (_input, queryId) =>
    ++calls === 1
      ? {
          works: [
            openAlexWork(
              raw(1, { relevance_score: 10, rerank_score: 0.1 }),
              queryId,
              { reranked: true },
            ),
            openAlexWork(
              raw(2, { relevance_score: 1, rerank_score: 0.9 }),
              queryId,
              { reranked: true },
            ),
          ],
          total: 101,
          cursor: "page2",
          reranked: true,
        }
      : {
          works: [
            openAlexWork(raw(2, { relevance_score: 100 }), queryId),
            openAlexWork(raw(3, { relevance_score: 999 }), queryId),
          ],
          total: 101,
          cursor: null,
          reranked: false,
        };
  const first = await f.service.search("task", {
    query: "rerank",
    rerank: true,
  });
  await f.service.search("task", { query: "", queryId: first.queryId });
  const after = await f.service.list("task", {
    view: "shortlist",
    queryId: first.queryId,
  });
  assert.equal(after.queries[0].reranked, true);
  assert.equal(after.ranking.reranked, true);
  assert.deepEqual(
    after.items.map((work) => work.id),
    ["W1002", "W1001", "W1003"],
  );
  assert.equal(after.items[0].presentation.rerankScore, 0.9);
  assert.equal(after.items[2].presentation.rerankScore, undefined);
  // A pool saved by an older version may have a false page-level flag.
  const legacy = { ...after.queries[0], reranked: false };
  assert.deepEqual(
    shortlistWorks(after.items, legacy).items.map((work) => work.id),
    ["W1002", "W1001", "W1003"],
  );
  assert.equal(
    shortlistWorks(after.items, { ...legacy, sort: "citations" }).reranked,
    false,
  );
});

test("impact tiebreakers use one common measurement regardless of input order", () => {
  const query = {
    id: "q",
    query: "paper",
    createdAt: 1,
    total: 3,
    pages: 1,
    cursor: null,
  };
  const a = openAlexWork(raw(1, { relevance_score: 1, fwci: 10 }), "q");
  const b = openAlexWork(raw(2, { relevance_score: 1, fwci: 1 }), "q");
  const ids = (works) =>
    shortlistWorks(works, query).items.map((work) => work.id);
  assert.deepEqual(ids([a, b]), [a.id, b.id]);
  a.citationNormalizedPercentile = { value: 0.99 };
  assert.deepEqual(ids([a, b]), [a.id, b.id]);
  // No shared normalized metric: fall back to the common raw citation count.
  const c = openAlexWork(
    raw(3, {
      relevance_score: 1,
      cited_by_count: 100,
      cited_by_percentile_year: { max: 95 },
    }),
    "q",
  );
  for (const works of [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ])
    assert.deepEqual(ids(works), [c.id, a.id, b.id]);
  b.citationNormalizedPercentile = { value: 1 };
  assert.deepEqual(ids([a, b]), [b.id, a.id]);
});

test("concurrent equivalent searches share one fetch while a queued cancellation stays cancelled", async () => {
  const f = fixture();
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.client.search = async (_input, queryId) => {
    calls++;
    await gate;
    return {
      works: [openAlexWork(raw(0), queryId)],
      total: 1,
      cursor: null,
      reranked: false,
    };
  };
  const first = f.service.search("task", { query: "shared" });
  const second = f.service.search("task", { query: "shared" });
  const abort = new globalThis.AbortController();
  const provider = new LiteratureToolProvider(f.service, "task");
  const cancelled = provider.call(
    "literature_search",
    { query: "shared" },
    abort.signal,
  );
  await setImmediate();
  abort.abort();
  release();
  const [a, b, result] = await Promise.all([first, second, cancelled]);
  assert.equal(calls, 1);
  assert.equal(a.queryId, b.queryId);
  assert.equal(result.ok, false);
  assert.equal(result.details.providerCode, "cancelled");
});

test("service and provider discard search results cancelled during asynchronous projection", async () => {
  const f = fixture();
  const first = await f.service.search("task", { query: "shared" });
  const list = f.service.list.bind(f.service);
  let abort = new globalThis.AbortController();
  f.service.list = async (...args) => {
    const page = await list(...args);
    abort.abort();
    return page;
  };
  await assert.rejects(
    f.service.search("task", { query: "shared" }, abort.signal),
    { code: "cancelled" },
  );
  abort = new globalThis.AbortController();
  f.service.search = async () => first;
  const result = await new LiteratureToolProvider(f.service, "task").call(
    "literature_search",
    { query: "shared" },
    abort.signal,
  );
  assert.equal(result.ok, false);
  assert.equal(result.details.providerCode, "cancelled");
});

test("child query shortlists survive restart and preserve their own source snapshots", async () => {
  const f = fixture();
  let calls = 0;
  f.client.search = async (_input, queryId) => {
    const base = 100 * calls++;
    return {
      works: Array.from({ length: 20 }, (_, i) =>
        openAlexWork(raw(base + i, { relevance_score: i }), queryId),
      ),
      total: 20,
      cursor: null,
      reranked: false,
    };
  };
  const run = {
    document: {
      record: {
        parentTaskId: "task",
        allowSearch: true,
        sourceIds: [],
        evidence: [],
      },
      archive: {},
    },
    task: { id: "child", lockedContext: { items: [] } },
    abort: new globalThis.AbortController(),
    save: async () => {},
  };
  const library = { listTools: () => [], getMeta: () => null };
  let tools = new SubagentResearchTools(run, library, f.service);
  const first = await tools.call("literature_search", { query: "first" });
  const second = await tools.call("literature_search", {
    query: "second",
    limit: 12,
  });
  assert.equal(second.data.items.length, 12);
  const listed = await tools.call("literature_list", {
    view: "shortlist",
    queryId: second.data.queryId,
    limit: 12,
  });
  assert.deepEqual(listed.data.items, second.data.items);
  assert.equal(listed.data.nextOffset, null);
  const parent = await f.service.search("task", { query: "parent only" });
  const pool = await f.service.load("task");
  pool.works.find((work) => work.id === first.data.items[0].id).acquisition = {
    status: "available",
    attachmentKey: "PARENT-NEW",
  };
  await f.service.save(pool);
  // Repeated cached searches must not refresh the child's frozen acquisition.
  const again = await tools.call("literature_search", { query: "first" });
  assert.equal(again.data.items[0].acquisition.status, "missing");
  assert.equal(again.data.items[0].acquisition.attachmentKey, undefined);
  tools = new SubagentResearchTools(
    { ...run, document: JSON.parse(JSON.stringify(run.document)) },
    library,
    f.service,
  );
  const current = await tools.call("literature_list", {});
  assert.deepEqual(current.data.items, again.data.items);
  const metadata = await tools.call("literature_list", {
    view: "metadata",
    queryId: second.data.queryId,
    offset: 10,
    limit: 5,
  });
  assert.equal(metadata.data.total, 20);
  assert.equal(metadata.data.items.length, 5);
  assert.equal(metadata.data.nextOffset, 15);
  assert.ok(
    metadata.data.items.every(
      (work) =>
        Number(work.id.slice(1)) >= 1100 && Number(work.id.slice(1)) < 1120,
    ),
  );
  const status = await tools.call("literature_list", {
    view: "status",
    status: "available",
  });
  assert.equal(status.data.items.length, 0);
  for (const name of ["literature_list", "literature_search"]) {
    const denied = await tools.call(name, { queryId: parent.queryId });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "permission_denied");
  }
  assert.equal((await tools.call("literature_get", { id: "W1200" })).ok, false);
  assert.equal(calls, 3);
});
