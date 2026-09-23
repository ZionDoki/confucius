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
      assert.equal(url, "https://api.openalex.org/works/W1000");
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
