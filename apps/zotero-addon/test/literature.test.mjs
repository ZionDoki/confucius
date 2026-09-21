import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  OpenAlexClient,
  openAlexWork,
  normalizeDoi,
  openAlexFailure,
} from "../src/modules/host/OpenAlexClient.ts";
import { LiteratureService } from "../src/modules/host/LiteratureService.ts";
import { LiteratureToolProvider } from "../src/modules/host/LiteratureToolProvider.ts";
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
