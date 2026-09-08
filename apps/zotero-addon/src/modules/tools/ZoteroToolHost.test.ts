import { memoryJsonStorage, type JsonStorage } from "../host/RuntimeStorage";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZoteroToolHost, findPdf } from "./ZoteroToolHost";
import { layoutQuoteVariants } from "./PdfQuote";
import { spatialPageText } from "./PdfLayout";
import {
  anchorPage,
  pdfPassages,
  renderPdfPassages,
  resolvePassage,
  type PdfPageChar,
} from "./PdfAnchors";
import { runtimeDigest } from "../host/RuntimeStorage";
import { ToolExecutionService } from "../host/ReliableToolProvider";
import { ZoteroToolProvider } from "../host/ZoteroToolProvider";
import { AgentHost } from "../host/AgentHost";
import type { ArtifactBody, ToolExecutionContext } from "@confucius/protocol";
import { ToolProgress, ToolTimeout } from "./Deadline";
import {
  captureWritebackSnapshot,
  verifyWritebackSnapshot,
  type WritebackSnapshot,
} from "../host/WritebackSnapshot";

function positionedChars(lines: string[]): PdfPageChar[] {
  return lines.flatMap((line, row) =>
    [...line].map((u, col) => ({
      u,
      rect: [10 + col * 5, 800 - row * 12, 15 + col * 5, 810 - row * 12],
      lineBreakAfter: col === line.length - 1,
    })),
  );
}

describe("native passage annotation contract", () => {
  it("separates table rows, radar labels and the next table caption", async () => {
    const chars = positionedChars([
      "web (72) 41.6 34.8 27.5 22.1",
      "Total (1627) 43.4 30.9 35.8 24.8",
      "LC",
      "SC",
      "0.2",
      "Figure 5: Semantic evaluation.",
      "Impact 0.722 0.594 0.650 0.731",
      "Table 7: Efficiency and cost.",
    ]);
    const passages = await pdfPassages(
      chars,
      9,
      "synthetic-layout",
      runtimeDigest,
    );
    const total = passages.find((p) => p.text.startsWith("Total"))!;
    assert.ok(total.anchor);
    assert.doesNotMatch(total.text, /web|LC|SC|Figure/);
    const impact = passages.find((p) => p.text.startsWith("Impact"))!;
    assert.ok(impact.anchor);
    assert.doesNotMatch(impact.text, /Table 7/);
  });

  it("returns full repeated pages when their source version is unknown and performs explicit verification", async () => {
    const installed = installHost({ pageTexts: ["Complete evidence."] });
    const args = { libraryID: 1, key: "ITEMKEY1", start: 1, end: 1 };
    const context = { taskId: "read-ledger", turnId: "same-turn" };
    const get = async (extra = {}) => {
      const r = await installed.execute(
        "get_pages",
        { ...args, ...extra },
        undefined,
        context,
      );
      assert.ok(r.ok);
      return r.data as {
        pages: Array<{
          text: string;
          omitted?: boolean;
          rereadReason?: string;
        }>;
      };
    };
    assert.equal((await get()).pages[0].text.trim(), "Complete evidence.");
    assert.equal((await get()).pages[0].text.trim(), "Complete evidence.");
    assert.equal((await get()).pages[0].omitted, undefined);
    const reread = await get({
      rereadReason: "Verify the denominator before finalizing",
    });
    assert.equal(reread.pages[0].text.trim(), "Complete evidence.");
    assert.match(reread.pages[0].rereadReason!, /denominator/);
  });

  it("bounds page batches with nextPage and caps annotation page size without rejecting a larger request", async () => {
    const installed = installHost({
      pageTexts: ["First page.", "Second page."],
    });
    Reflect.set(installed.host, "physicalPageText", async () =>
      "Evidence. ".repeat(1400),
    );
    const read = await installed.execute("get_pages", {
      libraryID: 1,
      key: "ITEMKEY1",
      start: 1,
      end: 2,
    });
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal((read.data as { nextPage: number }).nextPage, 2);
    assert.equal((read.data as { pages: unknown[] }).pages.length, 1);
    const annotations = await installed.execute("get_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      limit: 100,
    });
    assert.ok(annotations.ok);
    assert.equal((annotations.data as { pageSize: number }).pageSize, 50);
    assert.equal(
      (annotations.data as { requestedLimit: number }).requestedLimit,
      100,
    );
  });
  it("reuses an unchanged physical source, really verifies, and rejects a stale reader", async () => {
    const installed = installHost({
      pageTexts: ["Complete evidence.", "Next page."],
    });
    const oldIO = Reflect.get(globalThis, "IOUtils");
    const pdf = Zotero.Items.get(200);
    assert.ok(pdf);
    Reflect.set(pdf, "getFilePathAsync", async () => "/fixture/source.pdf");
    let modified = 1;
    Reflect.set(globalThis, "IOUtils", {
      stat: async () => ({ size: 100, lastModified: modified }),
    });
    let reads = 0;
    Reflect.set(
      installed.host,
      "physicalPageText",
      async () => `physical read ${++reads}`,
    );
    const get = async (extra = {}, budget = 4000) => {
      const r = await installed.execute(
        "get_pages",
        { libraryID: 1, key: "ITEMKEY1", start: 1, end: 1, ...extra },
        undefined,
        { taskId: "versioned", outputBudgetTokens: budget },
      );
      assert.ok(r.ok, JSON.stringify(r));
      return r.data as {
        pages: Array<{ text: string; reused?: boolean }>;
        nextPage: number | null;
      };
    };
    try {
      assert.equal((await get()).pages[0].text, "physical read 1");
      assert.equal((await get()).pages[0].reused, true);
      assert.equal(reads, 1);
      assert.equal(
        (await get({ rereadReason: "Verify after writing" })).pages[0].text,
        "physical read 2",
      );
      assert.equal((await get({ end: 2 }, 128)).nextPage, 2);
      modified++;
      const changed = await installed.execute(
        "get_pages",
        { libraryID: 1, key: "ITEMKEY1", start: 1, end: 1 },
        undefined,
        { taskId: "versioned" },
      );
      assert.equal(changed.ok, false);
      assert.match(!changed.ok ? changed.message : "", /file changed/);
      assert.equal(reads, 2);
    } finally {
      Reflect.set(globalThis, "IOUtils", oldIO);
    }
  });
  it("keeps page-boundary fragments readable without presenting them as complete selectable evidence", async () => {
    const passages = await pdfPassages(
      positionedChars([
        "executed successfully. Unfortunately, subsequent tasks failed. The remaining",
      ]),
      12,
      "source",
      runtimeDigest,
    );
    assert.equal(passages.length, 3);
    assert.equal(passages[0].anchor, undefined);
    assert.ok(passages[1].anchor);
    assert.equal(passages[2].anchor, undefined);
    assert.match(
      renderPdfPassages(passages, 5000).text,
      /\[unanchored\] executed successfully\./,
    );
  });

  it("keeps font/paragraph breaks inside a sentence and never exposes an anchor for a clipped passage", async () => {
    const chars = positionedChars([
      "The claim is",
      "conditional. Another claim.",
    ]);
    chars[11].paragraphBreakAfter = true;
    const passages = await pdfPassages(chars, 1, "source", runtimeDigest);
    assert.equal(passages.length, 2);
    assert.match(passages[0].text, /claim is\n\nconditional\./);
    const rendered = renderPdfPassages(passages, 15);
    assert.equal(rendered.truncated, true);
    assert.doesNotMatch(rendered.text, /\[anchor:/);
  });
  it("keeps an ordinary sentence intact when reading order moves to the next column", async () => {
    const first = positionedChars(["The claim is"]);
    const next = positionedChars(["conditional on complete observations."]);
    for (const char of first)
      char.rect = char.rect!.map((value, i) => (i % 2 ? value - 600 : value));
    for (const char of next)
      char.rect = char.rect!.map((value, i) => (i % 2 ? value : value + 300));
    const passages = await pdfPassages(
      [...first, ...next],
      2,
      "columns",
      runtimeDigest,
    );
    assert.equal(passages.length, 1);
    assert.ok(passages[0].anchor);
    assert.match(passages[0].text, /The claim is\s+conditional/);
  });
  async function readAnchors(installed: InstalledHost) {
    const result = await installed.execute("get_pages", {
      libraryID: 1,
      key: "ITEMKEY1",
      start: 1,
      end: 1,
    });
    assert.equal(result.ok, true);
    const text =
      (result.ok &&
        (result.data as { pages: { text: string }[] }).pages[0].text) ||
      "";
    return {
      text,
      anchors: [...text.matchAll(/\[anchor:([^\]]+)\]/g)].map((m) => m[1]),
    };
  }

  it("changes an owned text selection inside its PDF while preserving key, color and origin", async () => {
    const installed = installHost({
      nativeChars: [positionedChars(["First evidence. Second evidence."])],
    });
    const { anchors } = await readAnchors(installed);
    const saved = await installed.execute(
      "commit_annotations",
      {
        libraryID: 1,
        key: "ITEMKEY1",
        annotations: [{ anchor: anchors[0], comment: "first" }],
      },
      undefined,
      { taskId: "creator", agent: "native" },
    );
    assert.equal(saved.ok, true);
    const key = installed.saved[0].key as string;
    const before = await installed.host.ownership.owned("1_PDFKEY01", key);
    const original = installed.native.get(key)!;
    const changed = await installed.execute(
      "update_annotation",
      { libraryID: 1, key, anchor: anchors[1], comment: "reviewed" },
      undefined,
      { taskId: "reviewer", agent: "codex" },
    );
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(original.annotationText, "Second evidence.");
    assert.equal(original.annotationComment, "reviewed");
    const after = await installed.host.ownership.owned("1_PDFKEY01", key);
    assert.equal(after?.batchId, before?.batchId);
    assert.equal(after?.createdAt, before?.createdAt);
    assert.equal(after?.agent, "native");
    assert.equal(installed.native.size, 1);
  });
  it("commits a single read anchor without propose, copied quotation, page or native search", async () => {
    const installed = installHost({
      nativeChars: [
        positionedChars(["The ﬂow is task-", "driven. The result is partial."]),
      ],
      failMatchPositions: true,
    });
    const { text, anchors } = await readAnchors(installed);
    assert.match(anchors[0], /^a001[0-9a-f]{12}$/);
    assert.equal(anchorPage(anchors[0]), 1);
    assert.match(text, /ﬂow is task-\ndriven\./);
    assert.equal(anchors.length, 2);
    const args = {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { anchor: anchors[0], comment: "流程受任务引导；这不等于完整覆盖。" },
      ],
    };
    const result = await installed.execute("commit_annotations", args);
    assert.equal(result.ok, true);
    assert.equal(installed.saved.length, 1);
    assert.equal(installed.saved[0].text, "The ﬂow is task-\ndriven.");
    assert.deepEqual(installed.saved[0].position, {
      pageIndex: 0,
      rects: [
        [10, 800, 90, 810],
        [10, 788, 45, 798],
      ],
    });
    assert.equal(installed.saved[0].comment, args.annotations[0].comment);
    const operation = (
      await installed.service.listOperations({ name: "commit_annotations" })
    )[0];
    const preview = operation.args.annotations as {
      quote: string;
      page: number;
      anchor?: string;
    }[];
    assert.equal(preview[0].quote, installed.saved[0].text);
    assert.equal(preview[0].page, 1);
    assert.equal(preview[0].anchor, undefined);
  });

  it("distinguishes repeated text by position and retains good entries alongside a bad anchor", async () => {
    const installed = installHost({
      nativeChars: [
        positionedChars(["Repeated evidence.", "Repeated evidence."]),
      ],
      normalizedMatchCount: 2,
    });
    const { anchors } = await readAnchors(installed);
    const result = await installed.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { anchor: anchors[0], comment: "第一处证据。" },
        { anchor: anchors[1], type: "underline", comment: "第二处证据。" },
        { anchor: "p1:0-1:0000000000000000", comment: "错误引用。" },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.effect, "partial");
    assert.equal(installed.native.size, 2);
    assert.notDeepEqual(
      installed.saved[0].position,
      installed.saved[1].position,
    );
    assert.equal(installed.saved[0].text, installed.saved[1].text);
    assert.equal(
      result.ok && (result.data as { skipped: unknown[] }).skipped.length,
      1,
    );
  });

  it("rejects edited, stale, out-of-bounds and wrong-PDF references without guessing", async () => {
    const chars = positionedChars(["Evidence remains conditional."]);
    const passages = await pdfPassages(chars, 1, "original", runtimeDigest);
    assert.notEqual(
      passages[0].anchor,
      (await pdfPassages(chars, 1, "replacement", runtimeDigest))[0].anchor,
    );
    const installed = installHost({ nativeChars: [chars] });
    const { anchors } = await readAnchors(installed);
    chars[0].rect![0] += 1;
    for (const candidate of [
      { anchor: anchors[0] },
      { anchor: anchors[0].replace(/^a001/, "a002") },
      { anchor: "invented" },
      { anchor: anchors[0], page: 2 },
      { anchor: anchors[0], quote: "Evidence" },
    ]) {
      const result = await installed.execute("commit_annotations", {
        libraryID: 1,
        key: "ITEMKEY1",
        annotations: [candidate],
      });
      assert.equal(result.ok, false);
    }
    assert.equal(installed.native.size, 0);
  });

  it("resolves previously issued complete references but never guesses a missing checksum", async () => {
    const passages = await pdfPassages(
      positionedChars(["The evidence is conditional."]),
      9,
      "source",
      runtimeDigest,
    );
    assert.equal(
      resolvePassage(passages, passages[0].legacyAnchor!),
      passages[0],
    );
    assert.equal(anchorPage(passages[0].legacyAnchor!), 9);
    assert.equal(
      resolvePassage(
        passages,
        ` [anchor:${passages[0].anchor!.toUpperCase()}] `,
      ),
      passages[0],
    );
    assert.throws(
      () =>
        resolvePassage(
          passages,
          passages[0].legacyAnchor!.split(":").slice(0, 2).join(":"),
        ),
      /does not match/,
    );
  });

  it("retries direct anchors without duplicating or restoring a manually removed mark", async () => {
    const installed = installHost({
      nativeChars: [positionedChars(["Stable evidence."])],
    });
    const { anchors } = await readAnchors(installed);
    const request = () => ({
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [{ anchor: anchors[0], comment: "保留边界。" }],
    });
    assert.equal(
      (await installed.execute("commit_annotations", request())).ok,
      true,
    );
    assert.equal(
      (await installed.execute("commit_annotations", request())).ok,
      true,
    );
    assert.equal(installed.saved.length, 1);
    installed.native.clear();
    await installed.execute("commit_annotations", request());
    assert.equal(installed.native.size, 0);
    assert.equal(installed.saved.length, 1);
  });

  it("does not discard an anchored success when a compatibility search times out", async () => {
    const installed = installHost({
      nativeChars: [positionedChars(["Located evidence."])],
    });
    const { anchors } = await readAnchors(installed);
    (
      installed.host as unknown as { locateCandidate: () => Promise<never> }
    ).locateCandidate = async () => {
      throw new ToolTimeout("slow search");
    };
    const result = await installed.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "Slow quote" },
        { anchor: anchors[0], comment: "已定位证据。" },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.effect, "partial");
    assert.equal(installed.saved.length, 1);
  });

  it("does not expose a selectable anchor for text without native coordinates", async () => {
    const passages = await pdfPassages(
      [{ u: "Scanned/OCR text without positions." }],
      1,
      "source",
      runtimeDigest,
    );
    assert.equal(passages[0].anchor, undefined);
    assert.match(passages[0].text, /Scanned/);
  });
});

describe("PDF quote layout equivalence", () => {
  it("keeps table headers and numeric cells in physical column order despite scrambled extraction", () => {
    const layout = spatialPageText([
      { text: "4", rect: [600, 31, 10, 10] },
      { text: "baseline", rect: [600, 10, 70, 10] },
      { text: "9", rect: [300, 30, 10, 10] },
      { text: "method", rect: [300, 10, 65, 10] },
      { text: "forms", rect: [50, 30, 40, 10] },
    ]).split("\n");
    assert.equal(layout.length, 2);
    assert.equal(layout[0].indexOf("method"), layout[1].indexOf("9"));
    assert.equal(layout[0].indexOf("baseline"), layout[1].indexOf("4"));
    assert.match(layout[1], /forms\s+9\s+4/);
  });
  const chars = (text: string) =>
    [...text].map((u) => ({ u, lineBreakAfter: false }));
  it("repairs proven line-break hyphens, ligatures and quotation typography without changing the source query", () => {
    const source = [
      ...chars("The “workﬂow” responsi"),
      { u: "-", lineBreakAfter: true },
      ...chars("bilities are split."),
    ];
    assert.deepEqual(
      layoutQuoteVariants(source, 'The "workflow" responsibilities are split.'),
      ["The “workﬂow” responsi- bilities are split."],
    );
    const compound = [
      ...chars("task"),
      { u: "-", lineBreakAfter: true },
      ...chars("driven"),
    ];
    assert.deepEqual(layoutQuoteVariants(compound, "task-driven"), [
      "task- driven",
    ]);
  });
  it("does not remove lexical hyphens, splice passages or accept paraphrases", () => {
    assert.deepEqual(
      layoutQuoteVariants(
        chars("Please re-sign the contract."),
        "Please resign the contract.",
      ),
      [],
    );
    assert.deepEqual(
      layoutQuoteVariants(
        chars("Evidence with a material condition."),
        "Evidence ... condition.",
      ),
      [],
    );
    assert.deepEqual(
      layoutQuoteVariants(chars("Some tasks failed."), "All tasks failed."),
      [],
    );
  });
  it("retains multiple equivalent queries so native search must check their combined ambiguity", () => {
    const source = [
      ...chars("responsibilities and responsi"),
      { u: "-", lineBreakAfter: true },
      ...chars("bilities"),
    ];
    assert.deepEqual(layoutQuoteVariants(source, "responsibilities").sort(), [
      "responsi- bilities",
      "responsibilities",
    ]);
  });
});

function installLibrary() {
  let sequence = 0,
    saves = 0,
    failAt = Infinity,
    fallbackCalls = 0;
  const native = new Map<string, MockItem>();
  const db = new Map<string, string>();
  // Match Zotero DataObject's identified/unloaded transition. A predetermined
  // key is not an ordinary field: it requires a DB load before editing data.
  class MockDataObject {
    id = ++sequence;
    private _key = `KEY${String(this.id).padStart(5, "0")}`;
    private identified = false;
    private primaryLoaded = false;
    libraryID = 0;
    get key() {
      return this._key;
    }
    set key(value: string) {
      if (!this.libraryID) throw new Error("libraryID must be set before key");
      if (this.primaryLoaded)
        throw new Error("Cannot change key after object is already loaded");
      this.identified = true;
      this._key = value;
    }
    protected requireData() {
      if (this.identified && !this.primaryLoaded)
        throw new Error("UnloadedDataException: primaryData not loaded");
      this.primaryLoaded = true;
    }
    async loadPrimaryData() {
      // A missing row marks every datatype loaded in the native implementation.
      this.primaryLoaded = true;
    }
  }
  class MockItem extends MockDataObject {
    parentID?: number;
    note = "";
    tags: string[] = [];
    relatedItems: string[] = [];
    collections: number[] = [];
    fields: Record<string, string> = {};
    constructor(public itemType = "journalArticle") {
      super();
    }
    isNote() {
      return this.itemType === "note";
    }
    isAttachment() {
      return this.itemType === "attachment";
    }
    isAnnotation() {
      return false;
    }
    getNote() {
      return this.note;
    }
    setNote(value: string) {
      this.requireData();
      this.note = value;
    }
    getAttachments() {
      return [...native.values()]
        .filter((item) => item.isAttachment() && item.parentID === this.id)
        .map((item) => item.id);
    }
    getTags() {
      return this.tags.map((tag) => ({ tag }));
    }
    addTag(tag: string) {
      if (!this.tags.includes(tag)) this.tags.push(tag);
    }
    removeTag(tag: string) {
      this.tags = this.tags.filter((entry) => entry !== tag);
    }
    addRelatedItem(item: MockItem) {
      this.relatedItems.push(item.key);
    }
    addToCollection(id: number) {
      this.collections.push(id);
    }
    removeFromCollection(id: number) {
      this.collections = this.collections.filter((value) => value !== id);
    }
    getField(name: string) {
      return this.fields[name] ?? "";
    }
    setField(name: string, value: string) {
      this.requireData();
      if (name === "invalidField") throw new Error("Invalid field");
      this.fields[name] = value;
    }
    toJSON() {
      return {
        fields: this.fields,
        note: this.note,
        tags: this.tags,
        relatedItems: this.relatedItems,
        collections: this.collections,
      };
    }
    async save() {
      if (++saves === failAt) throw new Error("Injected transaction failure");
      this.libraryID ||= 1;
      native.set(this.key, this);
      db.set(this.key, JSON.stringify(this.toJSON()));
      return this.id;
    }
    async saveTx() {
      return this.save();
    }
    async reload() {
      if (db.has(this.key)) Object.assign(this, JSON.parse(db.get(this.key)!));
    }
  }
  const createdCollections = new Map<string, MockCollection>();
  class MockCollection extends MockDataObject {
    private _name = "";
    parentID?: number;
    get name() {
      return this._name;
    }
    set name(value: string) {
      this.requireData();
      this._name = value;
    }
    toJSON() {
      return { name: this.name };
    }
    getChildItems() {
      return [];
    }
    async save() {
      if (++saves === failAt) throw new Error("Injected transaction failure");
      createdCollections.set(this.key, this);
      return this.id;
    }
    async saveTx() {
      return this.save();
    }
  }
  const searches = new Map<string, MockSearch>();
  class MockSearch extends MockDataObject {
    private _name = "";
    private conditions: Array<{
      condition: string;
      operator: string;
      value: string;
    }> = [];
    constructor(params: { libraryID?: number; name?: string } = {}) {
      super();
      if (params.name !== undefined) this.name = params.name;
      if (params.libraryID !== undefined) this.libraryID = params.libraryID;
    }
    get name() {
      return this._name;
    }
    set name(value: string) {
      this.requireData();
      this._name = value;
    }
    addCondition(condition: string, operator: string, value: string) {
      this.requireData();
      this.conditions.push({ condition, operator, value });
    }
    async saveTx() {
      if (++saves === failAt) throw new Error("Injected transaction failure");
      searches.set(this.key, this);
      return this.id;
    }
  }
  const a = new MockItem(),
    b = new MockItem(),
    note = new MockItem("note");
  for (const item of [a, b, note]) {
    item.libraryID = 1;
    native.set(item.key, item);
    db.set(item.key, JSON.stringify(item.toJSON()));
  }
  let collectionMembers = [a.id];
  const collection = {
    id: 90,
    key: "COLLECT1",
    libraryID: 1,
    name: "Research",
    toJSON: () => ({ name: collection.name }),
    getChildItems: () => collectionMembers,
  };
  const zotero = {
    Item: MockItem,
    Collection: MockCollection,
    Search: MockSearch,
    Libraries: { userLibraryID: 1, get: () => ({ editable: true }) },
    Groups: { getGroupIDFromLibraryID: () => 0 },
    DataObjectUtilities: {
      generateKey: () => `NEW${String(++sequence).padStart(5, "0")}`,
    },
    Items: {
      getByLibraryAndKey: (library: number, key: string) =>
        library === 1 ? (native.get(key) ?? false) : false,
      get: (id: number) => [...native.values()].find((item) => item.id === id),
      getAll: async () => [...native.values()].map((item) => item.id),
    },
    Collections: {
      getByLibraryAndKey: (_library: number, key: string) =>
        key === collection.key
          ? collection
          : (createdCollections.get(key) ?? false),
    },
    Searches: {
      getByLibraryAndKey: (_library: number, key: string) =>
        searches.get(key) ?? false,
    },
    DB: {
      executeTransaction: async (work: () => Promise<unknown>) => {
        const before = new Map(db);
        try {
          return await work();
        } catch (error) {
          db.clear();
          for (const [key, value] of before) db.set(key, value);
          throw error;
        }
      },
    },
    Utilities: { extractIdentifiers: () => [{ DOI: "10.1234/example" }] },
    HTTP: {
      request: async () => {
        fallbackCalls++;
        throw new Error("Unexpected fallback import");
      },
    },
    Translate: {
      Search: class {
        setIdentifier() {}
        setTranslator() {}
        async getTranslators() {
          return [{}];
        }
        async translate() {
          return [a];
        }
      },
    },
    Attachments: {
      addAvailableFiles: async (_items: MockItem[]) => {},
      importFromURL: async ({ parentItemID }: { parentItemID: number }) => {
        const item = new MockItem("attachment");
        item.parentID = parentItemID;
        await item.save();
        return item;
      },
    },
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = zotero;
  const storage = memoryJsonStorage();
  const host = new ZoteroToolHost(storage);
  const service = new ToolExecutionService(memoryJsonStorage(), (operation) =>
    host.reconcile(operation),
  );
  host.setOperationReader(service);
  return {
    a,
    b,
    note,
    native,
    createdCollections,
    searches,
    zotero,
    host,
    collection,
    storage,
    service,
    provider: service.wrap(new ZoteroToolProvider(host)),
    failNextSave: (offset = 1) => {
      failAt = saves + offset;
    },
    changeCollection: () => {
      collectionMembers = [b.id];
    },
    fallbackCalls: () => fallbackCalls,
    saveCount: () => saves,
  };
}

describe("native write contracts", () => {
  it("rejects both invalid planned-key initialization orders in the native fixture", () => {
    const { zotero } = installLibrary();
    const cases = [
      () => {
        const object = new zotero.Collection();
        return {
          object,
          edit: () => {
            object.name = "Collection";
          },
        };
      },
      () => {
        const object = new zotero.Search();
        return {
          object,
          edit: () => object.addCondition("title", "contains", "paper"),
        };
      },
      () => {
        const object = new zotero.Item();
        return { object, edit: () => object.setField("title", "Paper") };
      },
      () => {
        const object = new zotero.Item("note");
        return { object, edit: () => object.setNote("Evidence") };
      },
    ];
    for (const create of cases) {
      const identified = create();
      identified.object.libraryID = 1;
      identified.object.key = "PLANNED1";
      assert.throws(identified.edit, /UnloadedDataException/);
      const loaded = create();
      loaded.object.libraryID = 1;
      loaded.edit();
      assert.throws(() => {
        loaded.object.key = "PLANNED2";
      }, /Cannot change key after object is already loaded/);
    }
    const namedSearch = new zotero.Search({
      libraryID: 1,
      name: "Already loaded",
    });
    assert.throws(() => {
      namedSearch.key = "PLANNED3";
    }, /Cannot change key after object is already loaded/);
  });

  it("loads every planned-key object before editing and replays creation with the same durable key", async () => {
    const env = installLibrary();
    const cases: Array<{
      name: string;
      kind: string;
      args: Record<string, unknown>;
    }> = [
      {
        name: "create_collection",
        kind: "collection",
        args: { name: "Reviewed collection" },
      },
      {
        name: "create_saved_search",
        kind: "search",
        args: { name: "Reviewed search", query: "evidence" },
      },
      {
        name: "create_item",
        kind: "item",
        args: { itemType: "journalArticle", title: "Reviewed article" },
      },
      {
        name: "create_note",
        kind: "item",
        args: { content: "Reviewed content" },
      },
      {
        name: "propose_note",
        kind: "item",
        args: {
          title: "Reviewed note",
          markdown: "Evidence",
          parentKey: env.a.key,
        },
      },
    ];
    for (const { name, kind, args } of cases) {
      const context: ToolExecutionContext = { operationId: `create:${name}` };
      assert.equal(await env.provider.prepare!(name, args, context), null);
      const key = context.plannedKeys?.[kind];
      assert.ok(key);
      const result = await env.provider.call(name, args, undefined, context);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.ok && (result.data as { key: string }).key, key);
      const count = env.saveCount();
      const replay = await env.provider.call(name, args, undefined, context);
      assert.equal(replay.ok, true);
      assert.deepEqual(replay.ok && replay.data, result.ok && result.data);
      assert.equal(replay.operationId, result.operationId);
      assert.equal(
        env.saveCount(),
        count,
        "replay must not create a second object",
      );
      const receipt = await env.service.getOperation(context.operationId!);
      assert.equal(
        (receipt?.intent?.recovery.plannedKeys as Record<string, string>)[kind],
        key,
      );
    }
    assert.equal(env.createdCollections.size, 1);
    assert.equal(env.searches.size, 1);
    assert.equal(env.native.size, 6);
  });

  it("creates an artifact collection using the key persisted before its transaction", async () => {
    const env = installLibrary();
    const host = Object.create(AgentHost.prototype) as {
      applyCollectionDiff(
        body: Extract<ArtifactBody, { type: "collection_diff" }>,
        state: unknown,
        operationId: string,
        snapshot: WritebackSnapshot,
      ): Promise<string>;
    };
    Object.assign(host, { execution: env.service });
    const body: Extract<ArtifactBody, { type: "collection_diff" }> = {
      type: "collection_diff",
      name: "Artifact collection",
      operations: [{ op: "add", item: { libraryID: 1, key: env.a.key } }],
    };
    const snapshot = captureWritebackSnapshot([env.a], undefined, {
      target: "zotero_collection",
      body,
    });
    const target = await host.applyCollectionDiff(
      body,
      { record: { id: "artifact-task", lockedContext: { items: [] } } },
      "artifact-batch",
      snapshot,
    );
    const [receipt] = await env.service.listOperations({
      name: "artifact.collection_diff",
    });
    assert.equal(target, `1:${receipt.args.createdCollectionKey}`);
    assert.equal(receipt.result?.effect, "applied");
    const created = env.createdCollections.get(
      String(receipt.args.createdCollectionKey),
    )!;
    assert.equal(created.name, body.name);
    assert.deepEqual(env.a.collections, [created.id]);
  });

  it("keeps standalone note semantics and rejects an invalid explicit parent without fallback", async () => {
    const { provider, a, native } = installLibrary();
    const invalid = await provider.call("create_note", {
      libraryID: "1",
      parentKey: "MISSING1",
      content: "Evidence",
    });
    assert.equal(invalid.ok, false);
    assert.equal(!invalid.ok && invalid.code, "not_found");
    assert.equal(native.size, 3);
    const result = await provider.call("create_note", {
      content: "Independent note",
    });
    assert.equal(result.ok, true);
    const created = native.get(
      (result.ok ? (result.data as { key: string }) : { key: "" }).key,
    )!;
    assert.equal(created.parentID, undefined);
    const context = {
      taskId: "read",
      operationId: "note",
      source: { libraryID: 1, key: a.key },
    };
    const proposed = await provider.call(
      "propose_note",
      { title: "Review", markdown: "Finding" },
      undefined,
      context,
    );
    assert.equal(proposed.ok, true);
    assert.equal(
      native.get(
        (proposed.ok ? (proposed.data as { key: string }) : { key: "" }).key,
      )?.parentID,
      a.id,
    );
  });

  it("deduplicates note append replay and preserves changes made during approval", async () => {
    const { provider, note } = installLibrary();
    const args = { libraryID: 1, key: note.key, content: "One addition" };
    await provider.call("append_to_note", { ...args }, undefined, {
      operationId: "append",
    });
    await provider.call("append_to_note", { ...args }, undefined, {
      operationId: "append",
    });
    assert.equal(note.note.match(/One addition/g)?.length, 1);
    const context = { operationId: "overwrite" };
    await provider.prepare!("update_note", args, context);
    note.setNote("Human edit");
    await note.save();
    const stale = await provider.call("update_note", args, undefined, context);
    assert.equal(stale.effect, "none");
    assert.equal(stale.ok, false);
    assert.equal(note.note, "Human edit");
  });

  it("prechecks all tag and metadata arguments and rolls back both sides of a relation", async () => {
    const { provider, a, b, failNextSave } = installLibrary();
    for (const args of [{ add: [1] }, { add: ["x"], remove: ["x"] }]) {
      const invalid = await provider.call("batch_update_tags", {
        libraryID: 1,
        key: a.key,
        ...args,
      });
      assert.equal(invalid.effect, "none");
      assert.equal(invalid.ok, false);
    }
    const badMetadata = await provider.call("update_item_metadata", {
      libraryID: 1,
      key: a.key,
      fields: { title: "Do not save", invalidField: "bad" },
    });
    assert.equal(badMetadata.ok, false);
    assert.deepEqual(a.fields, {});
    failNextSave(2);
    const rollback = await provider.call("link_related_items", {
      libraryID: 1,
      key: a.key,
      relatedKey: b.key,
    });
    assert.equal(rollback.effect, "none");
    assert.deepEqual(a.relatedItems, []);
    assert.deepEqual(b.relatedItems, []);
  });

  it("checks collection membership changes even when names and titles are unchanged", () => {
    const { a, collection, changeCollection } = installLibrary();
    const snapshot = captureWritebackSnapshot([a], collection);
    verifyWritebackSnapshot(snapshot);
    changeCollection();
    assert.throws(
      () => verifyWritebackSnapshot(snapshot),
      /changed during approval/,
    );
  });

  it("retains imported items when downloads fail and never falls back after a lost translator response", async () => {
    const env = installLibrary();
    env.zotero.Attachments.addAvailableFiles = async () => {
      throw new Error("Download disconnected");
    };
    const partial = await env.provider.call("add_item", {
      identifier: "10.1234/example",
      libraryID: "1",
    });
    assert.equal(partial.ok, true);
    assert.equal(partial.effect, "partial");
    assert.equal(env.native.has(env.a.key), true);
    env.zotero.Translate.Search.prototype.translate = async () => {
      const created = new env.zotero.Item();
      await created.save();
      throw new Error("Response lost after item creation");
    };
    const unknown = await env.provider.call("add_item", {
      identifier: "10.1234/another",
      libraryID: 1,
    });
    assert.equal(unknown.effect, "unknown");
    assert.equal(env.fallbackCalls(), 0);
    assert.equal(
      (!unknown.ok
        ? (unknown.details as { createdCandidates: unknown[] })
        : { createdCandidates: [] }
      ).createdCandidates.length,
      1,
    );
  });
});

interface InstalledHost {
  host: ZoteroToolHost;
  execute: ZoteroToolHost["execute"];
  service: ToolExecutionService;
  storage: JsonStorage;
  native: Map<string, Record<string, unknown>>;
  saved: Array<Record<string, unknown>>;
  erased: string[];
  refreshed: string[][];
  unset: string[][];
  navigated: Array<Record<string, unknown>>;
}

function installHost(
  options: {
    libraryID?: number;
    failSaveAt?: number;
    loseResponseAt?: number;
    failRefresh?: boolean;
    useReaderPageView?: boolean;
    pageTexts?: string[];
    missingQuotes?: string[];
    delayedFind?: boolean;
    normalizedMatchCount?: number;
    nativeMatchPages?: number[];
    failMatchPositions?: boolean;
    nativeChars?: PdfPageChar[][];
    multiplePdfs?: boolean;
  } = {},
): InstalledHost {
  const libraryID = options.libraryID ?? 1;
  const saved: Array<Record<string, unknown>> = [];
  const erased: string[] = [];
  const refreshed: string[][] = [];
  const unset: string[][] = [];
  const navigated: Array<Record<string, unknown>> = [];
  let keyIndex = 0;
  let query = "";
  let searchPolls = 0;
  const readerClones = new WeakSet<object>();
  const native = new Map<string, Record<string, unknown>>();
  const storage = memoryJsonStorage();

  const parent = {
    id: 100,
    libraryID,
    key: "ITEMKEY1",
    isAttachment: () => false,
    isNote: () => false,
    getAttachments: () => (options.multiplePdfs ? [200, 201] : [200]),
  };
  const attachment = {
    id: 200,
    libraryID,
    key: "PDFKEY01",
    parentItemID: 100,
    isAttachment: () => true,
    isFileAttachment: () => true,
    isNote: () => false,
    attachmentContentType: "application/pdf",
    getDisplayTitle: () => "Main paper",
    attachmentFilename: "paper.pdf",
    getAnnotations: () => [...native.values()],
  };
  const supplement = {
    ...attachment,
    id: 201,
    key: "PDFKEY02",
    getDisplayTitle: () => "Supplementary information",
    attachmentFilename: "supplement.pdf",
    getAnnotations: () => [],
  };
  const viewport = {
    width: 1000,
    height: 1000,
    convertToPdfPoint: (x: number, y: number): [number, number] => [
      x,
      1000 - y,
    ],
    convertToViewportPoint: (x: number, y: number): [number, number] => [
      x,
      1000 - y,
    ],
  };
  const pdfPage = {
    getViewport: () => viewport,
    render: () => ({ promise: Promise.resolve() }),
  };
  const pdfDocument = {
    numPages: options.nativeChars?.length ?? options.pageTexts?.length ?? 4,
    getPage: async (page: number) =>
      options.useReaderPageView
        ? {}
        : {
            ...pdfPage,
            getTextContent: async () => ({
              items: [{ str: options.pageTexts?.[page - 1] ?? "" }],
            }),
          },
  };
  const completedMatches = () =>
    Array.from({ length: pdfDocument.numPages }, (_, page) =>
      options.nativeMatchPages && !options.nativeMatchPages.includes(page + 1)
        ? []
        : Array.from(
            { length: options.normalizedMatchCount ?? 1 },
            (_, index) => index,
          ),
    );
  const controller = {
    _pdfDocument: {},
    state: { query: "previous query" },
    _dirtyMatch: false,
    _pendingFindMatches: new Set<number>(),
    pageMatches: [[0], [0], [0], [0]],
    find: async () => undefined,
    getMatchPositionsAsync: async (page: number) => {
      if (options.failMatchPositions)
        throw new Error("Native position unavailable");
      return options.missingQuotes?.includes(query) ||
        (options.nativeMatchPages &&
          !options.nativeMatchPages.includes(page + 1))
        ? []
        : Array.from(
            {
              length: controller._dirtyMatch
                ? 1
                : (options.normalizedMatchCount ?? 1),
            },
            (_, index) => ({
              rects: [[10 + index * 100, 20, 40 + index * 100, 35]],
            }),
          );
    },
  };
  const view = {
    initializedPromise: Promise.resolve(),
    _findController: controller,
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument,
        pdfViewer: options.useReaderPageView
          ? { getPageView: () => ({ pdfPage }) }
          : undefined,
      },
    },
    _ensureBasicPageData: async () => undefined,
    _pdfPages: options.nativeChars?.map((chars) => ({ chars })),
    setFindState: async (state: { query: string }) => {
      // Reader ignores an un-cloned chrome object across its window boundary.
      if (!readerClones.has(state)) return;
      query = state.query;
      controller.state = { query };
      controller._dirtyMatch = Boolean(options.delayedFind);
      if (!options.delayedFind) controller.pageMatches = completedMatches();
      searchPolls = 0;
    },
    getAnnotationMeta: (position: { pageIndex: number }) => ({
      pageLabel: String(position.pageIndex + 1),
      sortIndex: `${String(position.pageIndex).padStart(5, "0")}|000010|00000`,
    }),
    _getPageLabel: (pageIndex: number) => String(pageIndex + 1),
  };
  const reader = {
    itemID: attachment.id,
    _instanceID: "reader-instance",
    _initPromise: Promise.resolve(),
    _waitForReader: async () => undefined,
    _internalReader: { _primaryView: view },
    setAnnotations: async (items: Array<{ key: string }>) => {
      refreshed.push(items.map((item) => item.key));
      if (options.failRefresh) throw new Error("refresh failed");
    },
    unsetAnnotations: async (keys: string[]) => {
      unset.push([...keys]);
    },
    navigate: async (location: Record<string, unknown>) => {
      navigated.push(location);
    },
  };

  (globalThis as unknown as { Components: unknown }).Components = {
    utils: {
      cloneInto: (value: object) => {
        const cloned = structuredClone(value);
        readerClones.add(cloned);
        return cloned;
      },
    },
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    Libraries: { userLibraryID: 1 },
    Groups: {
      getGroupIDFromLibraryID: (id: number) => (id === 1 ? 0 : 77),
    },
    Items: {
      getByLibraryAndKey: (id: number, key: string) =>
        id !== libraryID
          ? null
          : key === parent.key
            ? parent
            : key === attachment.key
              ? attachment
              : options.multiplePdfs && key === supplement.key
                ? supplement
                : (native.get(key) ?? null),
      get: (id: number) =>
        id === attachment.id
          ? attachment
          : options.multiplePdfs && id === supplement.id
            ? supplement
            : id === parent.id
              ? parent
              : null,
    },
    Reader: {
      _readers: [reader],
      open: async () => reader,
    },
    Promise: {
      delay: async () => {
        if (controller._dirtyMatch && ++searchPolls >= 3) {
          controller._dirtyMatch = false;
          controller.pageMatches = completedMatches();
        }
      },
    },
    DataObjectUtilities: {
      generateKey: () => `ANNKEY0${++keyIndex}`,
    },
    Annotations: {
      DEFAULT_COLOR: "#ffd400",
      saveFromJSON: async (
        _attachment: unknown,
        json: Record<string, unknown>,
      ) => {
        saved.push(json);
        if (options.failSaveAt === saved.length) {
          throw new Error("save failed");
        }
        const annotation = {
          libraryID,
          parentItemID: attachment.id,
          getTags: () => (json.tags ?? []) as Array<{ tag: string }>,
          saveTx: async () => undefined,
          isAnnotation: () => true,
          annotationType: json.type,
          annotationText: json.text,
          annotationComment: json.comment,
          annotationColor: json.color,
          annotationPageLabel: json.pageLabel,
          annotationSortIndex: json.sortIndex,
          annotationPosition: JSON.stringify(json.position),
          key: String(json.key),
          eraseTx: async () => {
            erased.push(String(json.key));
            native.delete(String(json.key));
          },
        };
        native.set(annotation.key, annotation);
        if (options.loseResponseAt === saved.length)
          throw new Error("Response lost after Zotero saved the annotation");
        return annotation;
      },
    },
  };

  const host = new ZoteroToolHost(storage);
  const service = new ToolExecutionService(memoryJsonStorage(), (operation) =>
    host.reconcile(operation),
  );
  host.setOperationReader(service);
  const provider = service.wrap(new ZoteroToolProvider(host));
  return {
    host,
    execute: (name, args, signal, context) =>
      provider.call(name, args, signal, context),
    service,
    storage,
    native,
    saved,
    erased,
    refreshed,
    unset,
    navigated,
  };
}

describe("multiple PDF task sources", () => {
  it("captures every candidate's baseline without reading or choosing a PDF", async () => {
    const { host, saved } = installHost({ multiplePdfs: true });
    await host.freezeTaskPdf({ taskId: "multiple" }, 1, "ITEMKEY1");
    for (const key of ["PDFKEY01", "PDFKEY02"])
      assert.equal(
        Object.keys((await host.ownership.read(`1_${key}`)).batches).length,
        1,
      );
    assert.equal(saved.length, 0);
  });

  it("preserves an explicit attachment and rejects an unrelated one", async () => {
    const { host } = installHost({ multiplePdfs: true });
    await host.freezeTaskPdf({ taskId: "selected" }, 1, "ITEMKEY1", "PDFKEY02");
    assert.equal(
      Object.keys((await host.ownership.read("1_PDFKEY01")).batches).length,
      0,
    );
    assert.equal(
      Object.keys((await host.ownership.read("1_PDFKEY02")).batches).length,
      1,
    );
    const parent = Zotero.Items.getByLibraryAndKey(1, "ITEMKEY1")!;
    assert.ok(parent);
    assert.equal((await findPdf(parent, "PDFKEY02"))?.key, "PDFKEY02");
    await assert.rejects(findPdf(parent, "FOREIGN"), /not found/);
  });

  it("returns named choices as a recoverable tool result and reuses the task attachment", async () => {
    const { host, execute } = installHost({ multiplePdfs: true });
    const args = { libraryID: 1, key: "ITEMKEY1", start: 1, end: 1 };
    const result = await execute("get_pages", { ...args });
    assert.ok(!result.ok);
    assert.equal(result.code, "invalid_args");
    assert.equal(result.effect, "none");
    assert.doesNotMatch(result.message, /PDFKEY|specify attachmentKey/);
    const details = result.details as {
      reason: string;
      attachments: Array<{
        attachmentKey: string;
        title: string;
        filename: string;
      }>;
      nextAction: string;
    };
    assert.equal(details.reason, "multiple_pdf_attachments");
    assert.deepEqual(
      details.attachments.map(({ attachmentKey, title, filename }) => ({
        attachmentKey,
        title,
        filename,
      })),
      [
        {
          attachmentKey: "PDFKEY01",
          title: "Main paper",
          filename: "paper.pdf",
        },
        {
          attachmentKey: "PDFKEY02",
          title: "Supplementary information",
          filename: "supplement.pdf",
        },
      ],
    );
    assert.match(details.nextAction, /attachmentKey/);
    const selected: Record<string, unknown> = { ...args };
    assert.equal(
      await host.prepare("get_pages", selected, {
        source: { libraryID: 1, key: "ITEMKEY1", attachmentKey: "PDFKEY02" },
      }),
      null,
    );
    assert.equal(selected.attachmentKey, "PDFKEY02");
    const foreign = await host.prepare(
      "get_pages",
      { ...args },
      {
        source: { libraryID: 2, key: "ITEMKEY1", attachmentKey: "PDFKEY02" },
      },
    );
    assert.equal(foreign?.code, "invalid_args");
  });

  it("lists PDFs through metadata without first requiring a PDF choice", async () => {
    const { execute } = installHost({ multiplePdfs: true });
    for (const name of [
      "get_item",
      "get_item_metadata",
      "get_paper_metadata",
    ]) {
      const result = await execute(name, { libraryID: 1, key: "ITEMKEY1" });
      assert.ok(result.ok, JSON.stringify(result));
      const data = result.data as {
        pdfAttachments: Array<{ filename: string }>;
      };
      assert.deepEqual(
        data.pdfAttachments.map((pdf) => pdf.filename),
        ["paper.pdf", "supplement.pdf"],
      );
    }
  });
});

describe("ZoteroToolHost PDF annotation commit", () => {
  it("writes highlight, underline, and image notes then refreshes once", async () => {
    const installed = installHost({ libraryID: 5 });
    const result = await installed.execute("commit_annotations", {
      libraryID: 5,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "Core claim" },
        {
          type: "underline",
          page: 2,
          quote: "Read this carefully",
          color: "#123ABC",
          comment: "Method detail",
        },
        {
          type: "image",
          page: 3,
          rect: [100, 200, 300, 400],
          comment: "Figure evidence",
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      installed.saved.map((json) => ({
        type: json.type,
        color: json.color,
        text: json.text,
        comment: json.comment,
      })),
      [
        {
          type: "highlight",
          color: "#ffd400",
          text: "Core claim",
          comment: "",
        },
        {
          type: "underline",
          color: "#123abc",
          text: "Read this carefully",
          comment: "Method detail",
        },
        {
          type: "image",
          color: "#a28ae5",
          text: "",
          comment: "Figure evidence",
        },
      ],
    );
    assert.deepEqual(installed.saved[2]?.position, {
      pageIndex: 2,
      rects: [[100, 400, 400, 800]],
    });
    assert.deepEqual(installed.refreshed, [
      ["ANNKEY01", "ANNKEY02", "ANNKEY03"],
    ]);
    assert.deepEqual(installed.navigated, [{ annotationID: "ANNKEY01" }]);
    if (result.ok) {
      const data = result.data as {
        itemKey: string;
        attachmentKey: string;
        annotationKey: string;
        annotationKeys: string[];
        zoteroUri: string;
        annotations: Array<{ zoteroUri: string }>;
      };
      assert.equal(data.itemKey, "ITEMKEY1");
      assert.equal(data.attachmentKey, "PDFKEY01");
      assert.equal(data.annotationKey, "ANNKEY01");
      assert.deepEqual(data.annotationKeys, [
        "ANNKEY01",
        "ANNKEY02",
        "ANNKEY03",
      ]);
      assert.equal(
        data.zoteroUri,
        "zotero://open-pdf/groups/77/items/PDFKEY01?annotation=ANNKEY01&page=1",
      );
      assert.match(
        data.annotations[2]!.zoteroUri,
        /annotation=ANNKEY03&page=3$/,
      );
    }
  });

  it("accepts the legacy highlight list", async () => {
    const installed = installHost();
    const result = await installed.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      highlights: [{ text: "Legacy quote", page: 4 }],
    });

    assert.equal(result.ok, true);
    assert.equal(installed.saved[0]?.type, "highlight");
    assert.equal(installed.saved[0]?.color, "#ffd400");
  });

  it("uses the Reader PDFPageView when the document page is Xray-wrapped", async () => {
    const installed = installHost({ useReaderPageView: true });
    const result = await installed.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        {
          type: "image",
          page: 2,
          rect: [100, 200, 300, 400],
          comment: "Reader page view",
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(installed.saved[0]?.position, {
      pageIndex: 1,
      rects: [[100, 400, 400, 800]],
    });
  });

  it("retains earlier annotations and reports a verified failed later save as partial", async () => {
    const installed = installHost({ failSaveAt: 2 });
    const result = await installed.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "First" },
        { type: "underline", page: 2, quote: "Second" },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.effect, "partial");
    assert.deepEqual(installed.erased, []);
    assert.deepEqual(installed.unset, []);
    assert.deepEqual(installed.refreshed, [["ANNKEY01"]]);
    assert.equal(installed.native.size, 1);
  });

  it("keeps saved annotations when Reader refresh fails", async () => {
    const installed = installHost({ failRefresh: true });
    const result = await installed.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "First" },
        { type: "underline", page: 2, quote: "Second" },
      ],
    });

    assert.equal(result.ok, true);
    assert.match(result.warnings?.join(" ") ?? "", /refresh failed/);
    assert.deepEqual(installed.erased, []);
    assert.deepEqual(installed.unset, []);
    assert.equal(installed.native.size, 2);
  });
});

describe("annotation recovery and review pipeline", () => {
  const ref = { libraryID: 1, key: "ITEMKEY1" };
  const draft = (quote: string, page = 1) => ({
    type: "highlight",
    page,
    quote,
  });
  it("normalizes an unambiguous text explanation alias but rejects conflicting prose", async () => {
    const installed = installHost();
    const result = await installed.execute("propose_annotations", {
      ...ref,
      annotations: [
        { ...draft("Evidence"), content: "中文说明" },
        {
          ...draft("Other evidence"),
          content: "冲突说明",
          comment: "既有说明",
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data as {
      annotations: Array<{ comment?: string; status: string; error?: string }>;
    };
    assert.equal(data.annotations[0].comment, "中文说明");
    assert.equal(data.annotations[0].status, "pending");
    assert.equal(data.annotations[1].status, "skipped");
    assert.equal(installed.saved.length, 0);
  });
  it("passes a Reader-owned search state and waits for the new normalized results", async () => {
    const installed = installHost({ delayedFind: true });
    const result = await installed.execute("commit_annotations", {
      ...ref,
      annotations: [draft("A uniquely located claim")],
    });
    assert.equal(result.ok, true);
    assert.equal(installed.saved.length, 1);
    assert.equal(installed.saved[0].text, "A uniquely located claim");
  });

  it("rejects normalized ambiguity after the asynchronous search completes", async () => {
    const installed = installHost({
      delayedFind: true,
      normalizedMatchCount: 2,
      failMatchPositions: true,
    });
    const result = await installed.execute("commit_annotations", {
      ...ref,
      annotations: [draft("A claim with a normalized duplicate")],
    });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /ambiguous/);
    assert.equal(installed.saved.length, 0);
  });

  it("reports native matches on another physical page without silently relocating the mark", async () => {
    const installed = installHost({ nativeMatchPages: [2] });
    const result = await installed.execute("commit_annotations", {
      ...ref,
      annotations: [draft("A correctly quoted claim", 3)],
    });
    assert.equal(result.ok, false);
    assert.match(
      JSON.stringify(result),
      /Native matches exist on physical pages 2/,
    );
    assert.equal(installed.saved.length, 0);
  });

  it("commits valid entries and reconciles subsequent batches without inspection tokens", async () => {
    const installed = installHost({
      missingQuotes: ["missing A", "missing B"],
    });
    const annotations = [
      ...Array.from({ length: 8 }, (_, index) =>
        draft(`Evidence ${index}`, (index % 4) + 1),
      ),
      draft("missing A"),
      draft("missing B"),
    ];
    const first = await installed.execute(
      "commit_annotations",
      { ...ref, annotations },
      undefined,
      { taskId: "t" },
    );
    assert.equal(first.ok, true);
    assert.equal(first.effect, "partial");
    assert.equal(installed.native.size, 8);
    const retry = await installed.execute(
      "commit_annotations",
      { ...ref, annotations: [draft("repaired")] },
      undefined,
      { taskId: "t" },
    );
    assert.equal(retry.ok, true);
    assert.equal(installed.native.size, 9);
    assert.equal(
      (
        await installed.execute("get_annotations", { ...ref }, undefined, {
          taskId: "t",
        })
      ).ok,
      true,
    );
    const repaired = await installed.execute(
      "commit_annotations",
      { ...ref, annotations: [draft("repaired")] },
      undefined,
      { taskId: "t" },
    );
    assert.equal(repaired.ok, true);
    assert.equal(installed.native.size, 9);
    const consumed = await installed.execute(
      "commit_annotations",
      { ...ref, annotations: [draft("last")] },
      undefined,
      { taskId: "t" },
    );
    assert.equal(consumed.ok, true);
    assert.equal(installed.native.size, 10);
  });
  it("persists candidates and canonical receipts across hosts without read-tool tokens", async () => {
    const installed = installHost();
    const proposed = await installed.execute(
      "propose_annotations",
      { ...ref, annotations: [draft("Evidence")] },
      undefined,
      { taskId: "t" },
    );
    assert.equal(proposed.ok, true);
    const restoredHost = new ZoteroToolHost(installed.storage);
    restoredHost.setOperationReader(installed.service);
    const restored = {
      execute: installed.service.wrap(new ZoteroToolProvider(restoredHost))
        .call,
    };
    const committed = await restored.execute(
      "commit_annotations",
      { libraryID: "1", key: "PDFKEY01" },
      undefined,
      { taskId: "t", operationId: "op1" },
    );
    assert.equal(committed.ok, true);
    assert.equal(installed.native.size, 1);
    const replay = await restored.execute(
      "commit_annotations",
      { libraryID: "1", key: "PDFKEY01" },
      undefined,
      { taskId: "t", operationId: "op1" },
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(replay)),
      JSON.parse(JSON.stringify(committed)),
    );
    assert.equal(installed.native.size, 1);
    const restartedHost = new ZoteroToolHost(installed.storage);
    restartedHost.setOperationReader(installed.service);
    const restarted = {
      execute: installed.service.wrap(new ZoteroToolProvider(restartedHost))
        .call,
    };
    assert.equal(
      (
        await restarted.execute(
          "commit_annotations",
          { ...ref, annotations: [draft("Evidence")] },
          undefined,
          { taskId: "t2" },
        )
      ).ok,
      true,
    );
    await restarted.execute("get_annotations", { ...ref }, undefined, {
      taskId: "t2",
    });
    assert.equal(
      (
        await restarted.execute(
          "commit_annotations",
          { ...ref, annotations: [draft("Evidence")] },
          undefined,
          { taskId: "t2" },
        )
      ).ok,
      true,
    );
    assert.equal(installed.native.size, 1);
  });
  it("allows unrelated existing annotation edits while preparing a new candidate", async () => {
    const installed = installHost();
    await installed.execute("commit_annotations", {
      ...ref,
      annotations: [draft("Evidence")],
    });
    await installed.execute("get_annotations", { ...ref });
    installed.native.get("ANNKEY01")!.annotationComment = "Manually edited";
    const result = await installed.execute("commit_annotations", {
      ...ref,
      annotations: [draft("Next")],
    });
    assert.equal(result.ok, true);
    assert.equal(installed.native.size, 2);
    assert.equal(
      installed.native.get("ANNKEY01")!.annotationComment,
      "Manually edited",
    );
  });
  it("uses the same unique anchor for a highlight and underline, without consuming another match", async () => {
    const installed = installHost();
    const result = await installed.execute("commit_annotations", {
      ...ref,
      annotations: [
        draft("Same passage"),
        { ...draft("Same passage"), type: "underline" },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(installed.native.size, 2);
  });
  it("returns explanation feedback for review without adding a content gate", async () => {
    const installed = installHost();
    const result = await installed.execute(
      "propose_annotations",
      {
        ...ref,
        annotations: [
          draft("Key finding"),
          { ...draft("Background"), importance: "supporting" },
        ],
      },
      undefined,
      { annotationPolicy: "key_explanations" },
    );
    assert.equal(result.ok, true);
    if (result.ok)
      assert.equal(
        (result.data as { reviewIssues: unknown[] }).reviewIssues.length,
        1,
      );
    assert.equal(installed.native.size, 0);
  });
  it("preserves physical blank pages and never invents indexed pagination", async () => {
    const installed = installHost({ pageTexts: ["First", "", "Third"] });
    const count = await installed.execute("get_page_count", { ...ref });
    assert.equal(
      count.ok && (count.data as { pageCount: number }).pageCount,
      3,
    );
    const pages = await installed.execute("get_pages", {
      ...ref,
      start: 1,
      end: 3,
    });
    assert.equal(pages.ok, true);
    if (pages.ok)
      assert.match(
        (pages.data as { pages: Array<{ zoteroUri: string }> }).pages[2]
          .zoteroUri,
        /open-pdf\/library\/items\/.*\?page=3$/,
      );
    if (pages.ok)
      assert.deepEqual(
        (
          pages.data as { pages: Array<{ page: number; text: string }> }
        ).pages.map((page) => [page.page, page.text.trim()]),
        [
          [1, "First"],
          [2, ""],
          [3, "Third"],
        ],
      );
  });
  it("clones empty-page fallback parameters into the Reader before PDF Worker dispatch", async () => {
    const installed = installHost({ pageTexts: [""] });
    const globals = globalThis as unknown as {
      Zotero: {
        Reader: {
          _readers: Array<{
            _internalReader: {
              _primaryView: {
                _iframeWindow: {
                  PDFViewerApplication: {
                    pdfDocument: {
                      getPageData?: (arg: unknown) => Promise<unknown>;
                    };
                  };
                };
              };
            };
          }>;
        };
      };
      Components: {
        utils: { cloneInto: (value: unknown, target?: unknown) => unknown };
      };
    };
    const view = globals.Zotero.Reader._readers[0]._internalReader._primaryView;
    const cloned = new WeakSet<object>();
    globals.Components.utils.cloneInto = (value, target) => {
      assert.equal(target, view._iframeWindow);
      const copy = { ...(value as object) };
      cloned.add(copy);
      return copy;
    };
    view._iframeWindow.PDFViewerApplication.pdfDocument.getPageData = async (
      arg,
    ) => {
      assert.ok(
        cloned.has(arg as object),
        "Privileged params cannot be posted to PDF Worker",
      );
      return { chars: [] };
    };
    const result = await installed.execute("get_pages", {
      ...ref,
      start: 1,
      end: 1,
    });
    assert.equal(result.ok, true);
  });
});

it("freezes eligible candidates without blocking unrelated annotation edits", async () => {
  const installed = installHost({ missingQuotes: ["unlocatable"] });
  const args: Record<string, unknown> = {
    libraryID: "1",
    key: "ITEMKEY1",
    annotations: [
      {
        type: "highlight",
        page: "1",
        quote: "Evidence",
        comment: "The result supports the primary claim.",
      },
      { type: "highlight", page: 1, quote: "unlocatable" },
      { type: "highlight", page: 1, quote: "A", text: "B" },
    ],
  };
  const context: import("@confucius/protocol").ToolExecutionContext = {
    taskId: "review",
    operationId: "approved",
  };
  assert.equal(
    await installed.host.prepare("commit_annotations", args, context),
    null,
  );
  assert.equal(installed.native.size, 0);
  assert.equal((args.annotations as unknown[]).length, 1);
  assert.equal((args.annotations as Array<{ page: number }>)[0].page, 1);
  const actual = await installed.execute(
    "commit_annotations",
    args,
    undefined,
    context,
  );
  assert.equal(actual.effect, "partial");
  assert.equal(installed.native.size, 1);
  await installed.execute(
    "get_annotations",
    { libraryID: 1, key: "ITEMKEY1" },
    undefined,
    { taskId: "review" },
  );
  const nextArgs = {
    libraryID: 1,
    key: "ITEMKEY1",
    annotations: [{ type: "highlight", page: 1, quote: "Next" }],
  };
  const nextContext = { taskId: "review", operationId: "next" };
  assert.equal(
    await installed.host.prepare("commit_annotations", nextArgs, nextContext),
    null,
  );
  installed.native.get("ANNKEY01")!.annotationComment =
    "User changed this while approval was open";
  const changed = await installed.execute(
    "commit_annotations",
    nextArgs,
    undefined,
    nextContext,
  );
  assert.equal(changed.ok, true);
  assert.equal(installed.native.size, 2);
  assert.equal(
    installed.native.get("ANNKEY01")!.annotationComment,
    "User changed this while approval was open",
  );
});

it("returns real annotations with an unsaved warning when receipt storage is corrupt", async () => {
  const installed = installHost();
  await installed.execute("commit_annotations", {
    libraryID: 1,
    key: "ITEMKEY1",
    annotations: [{ type: "highlight", page: 1, quote: "Evidence" }],
  });
  const broken = new ZoteroToolHost({
    read: async () => {
      throw new Error("corrupt record");
    },
    write: async () => {
      throw new Error("locked");
    },
  });
  const result = await broken.execute("get_annotations", {
    libraryID: 1,
    key: "ITEMKEY1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    (result.data as { annotations: unknown[] }).annotations.length,
    1,
  );
  assert.match(result.warnings?.join(" ") ?? "", /receipt store/);
});

it("does not recreate a committed entry removed by the user", async () => {
  const installed = installHost();
  const args = {
    libraryID: 1,
    key: "ITEMKEY1",
    annotations: [
      { id: "stable", type: "highlight", page: 1, quote: "Evidence" },
    ],
  };
  await installed.execute("commit_annotations", args);
  installed.native.delete("ANNKEY01");
  await installed.execute("get_annotations", {
    libraryID: 1,
    key: "ITEMKEY1",
  });
  const result = await installed.execute("commit_annotations", {
    libraryID: 1,
    key: "ITEMKEY1",
    annotations: [
      { id: "stable", type: "highlight", page: 1, quote: "Evidence" },
    ],
  });
  assert.equal(result.effect, "none");
  assert.equal(installed.native.size, 0);
});

it("repairs only failed entries of a partial batch and stores outcomes only in the operation journal", async () => {
  const env = installHost({ failSaveAt: 2 });
  const context = {
    taskId: "partial",
    runId: "run-partial",
    intentRevision: 1,
  };
  const first = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "first", type: "highlight", page: 1, quote: "First" },
        { id: "second", type: "highlight", page: 2, quote: "Second" },
        { id: "third", type: "highlight", page: 3, quote: "Third" },
      ],
    },
    undefined,
    { ...context, operationId: "partial-first" },
  );
  assert.equal(first.effect, "partial");
  const repaired = await env.execute(
    "commit_annotations",
    { libraryID: 1, key: "ITEMKEY1" },
    undefined,
    { ...context, operationId: "partial-repair" },
  );
  assert.equal(repaired.ok, true);
  assert.equal(env.native.size, 3);
  assert.deepEqual(
    env.saved.map((entry) => entry.text),
    ["First", "Second", "Second", "Third"],
  );
  const record = await env.storage.read<Record<string, unknown>>("1_PDFKEY01");
  assert.equal(record?.version, 2);
  assert.equal("operations" in record!, false);
  assert.equal("operationProposals" in record!, false);
  assert.equal(JSON.stringify(record).includes("annotationKey"), false);
  assert.equal(
    (await env.service.listOperations({ name: "commit_annotations" })).length,
    2,
  );
  const work = await env.host.workForTask("partial", 0, undefined, {
    runId: "run-partial",
    intentRevision: 1,
    sourceRefs: ["1:ITEMKEY1"],
  });
  assert.equal(work.missing.length, 0);
  assert.equal(work.completed.length, 1);
});

it("reconciles a lost annotation response through native objects without a model read", async () => {
  const env = installHost({ loseResponseAt: 1 });
  const result = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "lost", type: "highlight", page: 1, quote: "Evidence" },
      ],
    },
    undefined,
    { operationId: "lost-response", taskId: "lost" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.effect, "applied");
  assert.equal(env.native.size, 1);
  const saved = await env.service.getOperation("lost-response");
  assert.ok(saved);
  const verified = await env.host.reconcile({ ...saved, result: undefined });
  assert.equal(verified?.ok, true);
  assert.equal(verified?.effect, "applied");
  assert.equal(env.saved.length, 1);
});

it("migrates legacy annotation receipts before removing duplicated proposal outcomes", async () => {
  const env = installHost();
  await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "old", type: "highlight", page: 1, quote: "Old evidence" },
      ],
    },
    undefined,
    { operationId: "legacy-source", taskId: "legacy" },
  );
  const operation = (await env.service.getOperation("legacy-source"))!;
  const recovery = operation.intent!.recovery as {
    expectedAfter: Record<string, string>;
  };
  const record = (await env.storage.read<{
    version: number;
    proposals: Record<string, { entries: unknown[] }>;
    latest: Record<string, string>;
  }>("1_PDFKEY01"))!;
  const proposalId = recovery.expectedAfter.annotationProposal;
  const entries = JSON.parse(recovery.expectedAfter.annotationEntries) as Array<
    Record<string, unknown>
  >;
  entries[0].status = "committed";
  record.proposals[proposalId].entries = entries;
  await env.storage.write("1_PDFKEY01", {
    ...record,
    version: 1,
    operations: { "imported-receipt": operation.result },
    operationProposals: {
      "imported-receipt": { proposalId, args: JSON.stringify(operation.args) },
    },
  });
  const read = await env.execute(
    "get_annotations",
    { libraryID: 1, key: "ITEMKEY1" },
    undefined,
    { taskId: "legacy" },
  );
  assert.equal(read.ok, true);
  assert.ok(await env.service.getOperation("imported-receipt"));
  const migrated =
    (await env.storage.read<Record<string, unknown>>("1_PDFKEY01"))!;
  assert.equal(migrated.version, 2);
  assert.equal("operations" in migrated, false);
  env.native.clear();
  const retry = await env.execute(
    "commit_annotations",
    { libraryID: 1, key: "ITEMKEY1" },
    undefined,
    { taskId: "legacy" },
  );
  assert.equal(retry.effect, "none");
  assert.equal(env.native.size, 0);
});

it("projects only candidates belonging to the current run and current sources", async () => {
  const env = installHost();
  await env.execute(
    "propose_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [{ type: "highlight", page: 1, quote: "Evidence" }],
    },
    undefined,
    { taskId: "task", runId: "old-run", intentRevision: 1 },
  );
  assert.equal(
    (await env.host.workForTask("task", 0, undefined, { runId: "new-run" }))
      .missing.length,
    0,
  );
  assert.equal(
    (
      await env.host.workForTask("task", 0, undefined, {
        runId: "old-run",
        sourceRefs: ["1:OTHER"],
      })
    ).missing.length,
    0,
  );
  assert.equal(
    (
      await env.host.workForTask("task", 0, undefined, {
        runId: "old-run",
        sourceRefs: ["1:ITEMKEY1"],
      })
    ).missing.length,
    1,
  );
});

it("keeps pending candidates on Continue and withdraws them from a later intent", async () => {
  const env = installHost();
  const context = { taskId: "steer", runId: "run-steer", intentRevision: 1 };
  await env.execute(
    "propose_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "pending", type: "highlight", page: 1, quote: "Evidence" },
      ],
    },
    undefined,
    context,
  );
  const continuing = await env.host.workForTask("steer", 0, undefined, context);
  assert.equal(continuing.missing.length, 1);
  const steered = { ...context, intentRevision: 2 };
  assert.deepEqual(await env.host.workForTask("steer", 0, undefined, steered), {
    completed: [],
    missing: [],
  });
  const implicit = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
    },
    undefined,
    steered,
  );
  assert.equal(implicit.ok, false);
  assert.equal(env.saved.length, 0);
  assert.equal(
    (await env.host.workForTask("steer", 0, undefined, context)).missing.length,
    1,
  );
});

it("uses the latest revised batch while explicit reuse adopts an older proposal ID", async () => {
  const env = installHost();
  const context = { taskId: "adopt", runId: "run-adopt", intentRevision: 1 };
  const first = await env.execute(
    "propose_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "first", type: "highlight", page: 1, quote: "First" },
      ],
    },
    undefined,
    context,
  );
  assert.equal(first.ok, true);
  const id = (first.ok ? first.data : undefined) as { proposalId: string };
  const next = { ...context, intentRevision: 2 };
  const latest = await env.execute(
    "propose_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "newer", type: "highlight", page: 2, quote: "Newer" },
      ],
    },
    undefined,
    next,
  );
  assert.equal(latest.ok, true);
  assert.equal(
    (await env.host.workForTask("adopt", 0, undefined, next)).missing[0].id,
    (latest.ok ? (latest.data as { proposalId: string }) : undefined)
      ?.proposalId,
  );
  const provider = env.service.wrap(new ZoteroToolProvider(env.host));
  assert.equal(
    await provider.prepare!(
      "commit_annotations",
      {
        libraryID: 1,
        key: "ITEMKEY1",
        proposalId: id.proposalId,
      },
      { ...next },
    ),
    null,
  );
  const active = await env.host.workForTask("adopt", 0, undefined, next);
  assert.deepEqual(
    active.missing.map((gap) => gap.id),
    [id.proposalId],
  );
  const record = (await env.storage.read<{
    latest: Record<string, string>;
    proposals: Record<
      string,
      { intentRevision: number; entries: Array<{ id: string }> }
    >;
  }>("1_PDFKEY01"))!;
  assert.equal(record.latest.adopt, id.proposalId);
  assert.equal(record.proposals[id.proposalId].intentRevision, 2);
  assert.deepEqual(
    record.proposals[id.proposalId].entries.map((entry) => entry.id),
    ["first"],
  );
  assert.equal(env.saved.length, 0);
});

it("keeps current candidates visible and implicitly committable after an old scope updates latest", async () => {
  const env = installHost();
  const current = { taskId: "late", runId: "current", intentRevision: 2 };
  const proposed = await env.execute(
    "propose_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "current-entry", type: "highlight", page: 1, quote: "Current" },
      ],
    },
    undefined,
    current,
  );
  assert.equal(proposed.ok, true);
  const currentId = (
    proposed.ok ? (proposed.data as { proposalId: string }) : undefined
  )?.proposalId;
  await env.execute(
    "propose_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "late-entry", type: "highlight", page: 2, quote: "Old" },
      ],
    },
    undefined,
    { ...current, runId: "older", intentRevision: 1 },
  );
  assert.deepEqual(
    (
      await env.host.workForTask(current.taskId, 0, undefined, current)
    ).missing.map((entry) => entry.id),
    [currentId],
  );
  const committed = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
    },
    undefined,
    current,
  );
  assert.equal(committed.ok, true);
  assert.deepEqual(
    env.saved.map((entry) => entry.text),
    ["Current"],
  );
});

it("adopts a partial batch in a later intent and writes only its remaining entries", async () => {
  const env = installHost({ failSaveAt: 2 });
  const context = {
    taskId: "rebind-partial",
    runId: "run-partial",
    intentRevision: 1,
  };
  const first = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { id: "saved", type: "highlight", page: 1, quote: "First" },
        { id: "retry", type: "highlight", page: 2, quote: "Second" },
      ],
    },
    undefined,
    { ...context, operationId: "before-steering" },
  );
  assert.equal(first.effect, "partial");
  const original = (await env.service.getOperation("before-steering"))!;
  const id = original.args.proposalId;
  const next = { ...context, intentRevision: 2 };
  assert.equal(
    (await env.host.workForTask(context.taskId, 0, undefined, next)).missing
      .length,
    0,
  );
  const repaired = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      proposalId: id,
    },
    undefined,
    { ...next, operationId: "after-steering" },
  );
  assert.equal(repaired.ok, true);
  assert.deepEqual(
    env.saved.map((entry) => entry.text),
    ["First", "Second", "Second"],
  );
  assert.equal(env.native.size, 2);
  assert.deepEqual(await env.service.getOperation("before-steering"), original);
  const work = await env.host.workForTask(context.taskId, 0, undefined, next);
  assert.equal(work.missing.length, 0);
  assert.equal(work.completed[0].id, id);
  assert.equal(work.completed[0].revision, 2);
});

it("clears old denied projections when a candidate is explicitly adopted by a later intent", async () => {
  const env = installHost();
  const provider = env.service.wrap(new ZoteroToolProvider(env.host));
  const args: Record<string, unknown> = {
    libraryID: 1,
    key: "ITEMKEY1",
    annotations: [
      { id: "declined", type: "highlight", page: 1, quote: "Evidence" },
    ],
  };
  const context = {
    taskId: "adopt-denied",
    runId: "run-denied",
    intentRevision: 1,
    operationId: "denied-original",
  };
  assert.equal(
    await provider.prepare!("commit_annotations", args, context),
    null,
  );
  await provider.recordDenied!("commit_annotations", args, context);
  assert.equal(
    (await env.host.workForTask(context.taskId, 0, undefined, context)).missing
      .length,
    0,
  );
  const record = (await env.storage.read<{
    proposals: Record<string, { entries: Array<Record<string, unknown>> }>;
  }>("1_PDFKEY01"))!;
  // Also cover a reused in-memory/legacy candidate carrying a derived marker.
  record.proposals[String(args.proposalId)].entries[0].resolved = "denied";
  await env.storage.write("1_PDFKEY01", record);
  const next = {
    taskId: context.taskId,
    runId: context.runId,
    intentRevision: 2,
    operationId: "denied-readopted",
  };
  const mismatch = await provider.prepare!(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      proposalId: args.proposalId,
      annotations: [
        { id: "different", type: "highlight", page: 2, quote: "Different" },
      ],
    },
    { ...next },
  );
  assert.equal(mismatch?.ok, false);
  assert.equal(
    (await env.host.workForTask(context.taskId, 0, undefined, next)).missing
      .length,
    0,
  );
  assert.equal(
    await provider.prepare!(
      "commit_annotations",
      {
        libraryID: 1,
        key: "ITEMKEY1",
        proposalId: args.proposalId,
      },
      { ...next },
    ),
    null,
  );
  const work = await env.host.workForTask(context.taskId, 0, undefined, next);
  assert.deepEqual(
    work.missing.map((gap) => gap.id),
    [args.proposalId],
  );
  assert.equal(work.completed.length, 0);
  assert.equal(
    (await env.service.getOperation("denied-original"))?.context.intentRevision,
    1,
  );
});

it("treats a declined concrete annotation intent as resolved without requesting approval again", async () => {
  const env = installHost();
  const provider = env.service.wrap(new ZoteroToolProvider(env.host));
  const args = {
    libraryID: 1,
    key: "ITEMKEY1",
    annotations: [
      { id: "declined", type: "highlight", page: 1, quote: "Evidence" },
    ],
  };
  const context = {
    taskId: "declined-task",
    runId: "declined-run",
    intentRevision: 1,
    operationId: "declined-op",
  };
  assert.equal(
    await provider.prepare!("commit_annotations", args, context),
    null,
  );
  await provider.recordDenied!("commit_annotations", args, context);
  const work = await env.host.workForTask("declined-task", 0, undefined, {
    runId: "declined-run",
    sourceRefs: ["1:ITEMKEY1"],
  });
  assert.equal(work.missing.length, 0);
  assert.equal(work.completed.length, 1);
  assert.equal(env.native.size, 0);
});

it("does not restart a tool deadline for a later domain stage", async () => {
  const context = {
    executionScope: {
      signal: new AbortController().signal,
      deadlineAt: Date.now() - 1,
    },
  };
  const progress = new ToolProgress(context, undefined, 120_000);
  let called = false;
  try {
    await assert.rejects(
      progress.run("late-stage", 60_000, async () => {
        called = true;
      }),
      ToolTimeout,
    );
    assert.equal(called, false);
  } finally {
    progress.close();
  }
});

it("compares the fields being changed while preserving unrelated metadata and tags", async () => {
  const env = installLibrary();
  const args = {
    libraryID: 1,
    key: env.a.key,
    fields: { title: "Prepared title" },
  };
  const context = { operationId: "scoped-metadata" };
  assert.equal(
    await env.provider.prepare!("update_item_metadata", args, context),
    null,
  );
  env.a.setField("abstractNote", "Human abstract");
  env.a.addTag("human-tag");
  await env.a.save();
  const result = await env.provider.call(
    "update_item_metadata",
    args,
    undefined,
    context,
  );
  assert.equal(result.ok, true);
  assert.equal(env.a.getField("abstractNote"), "Human abstract");
  assert.deepEqual(env.a.tags, ["human-tag"]);
  const secondArgs = {
    libraryID: 1,
    key: env.a.key,
    fields: { title: "Another title" },
  };
  const secondContext = { operationId: "conflicting-metadata" };
  await env.provider.prepare!(
    "update_item_metadata",
    secondArgs,
    secondContext,
  );
  env.a.setField("title", "Human title");
  await env.a.save();
  const conflict = await env.provider.call(
    "update_item_metadata",
    secondArgs,
    undefined,
    secondContext,
  );
  assert.equal(conflict.effect, "none");
  assert.equal(env.a.getField("title"), "Human title");
});

it("writeback snapshots ignore unrelated tags and check only edited tag memberships", () => {
  const env = installLibrary();
  const snapshot = captureWritebackSnapshot([env.a], undefined, {
    target: "zotero_tags",
    body: {
      type: "collection_diff",
      name: "Tags",
      operations: [
        {
          op: "tag_add",
          item: { libraryID: 1, key: env.a.key },
          value: "reviewed",
        },
      ],
    },
  });
  env.a.addTag("human-tag");
  env.a.setField("title", "Human title");
  verifyWritebackSnapshot(snapshot);
  env.a.addTag("reviewed");
  assert.throws(
    () => verifyWritebackSnapshot(snapshot),
    /changed during approval/,
  );
});

it("PDF reads and annotation writes reuse the reader without opening or selecting it", async () => {
  const installed = installHost({ pageTexts: ["Core claim"] });
  Zotero.Reader.open = async () => {
    throw new Error("Reader.open would activate the existing reader");
  };
  const ref = { libraryID: 1, key: "ITEMKEY1" };
  for (const [name, args] of [
    ["get_page_count", ref],
    ["get_pages", { ...ref, start: 1, end: 1 }],
    ["inspect_pdf_page", { ...ref, page: 1 }],
    [
      "commit_annotations",
      {
        ...ref,
        annotations: [{ type: "highlight", text: "Core claim", page: 1 }],
      },
    ],
  ] as const) {
    const result = await installed.execute(name, args);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(installed.saved.length, 1);
});

it("restores an unloaded PDF in its existing tab without selecting or duplicating it", async () => {
  const installed = installHost();
  const reader = Zotero.Reader._readers.pop()!;
  const tab = {
    id: "unloaded-pdf",
    type: "reader-unloaded",
    data: { itemID: 200, secondViewState: { pageIndex: 2 } },
  };
  let opens = 0;
  Object.assign(Zotero, {
    getMainWindow: () => ({
      setTimeout,
      clearTimeout,
      Zotero_Tabs: {
        getTabIDByItemID: () => tab.id,
        _getTab: () => ({ tab }),
        markAsLoaded: (id: string) => {
          assert.equal(id, tab.id);
          assert.equal(tab.type, "reader-loading");
          tab.type = "reader";
        },
        select: () => assert.fail("Background loading must not select a tab"),
      },
    }),
  });
  Zotero.Reader.open = async (id, location, options) => {
    opens++;
    assert.equal(id, 200);
    assert.equal(location, undefined);
    assert.equal(options?.openInBackground, true);
    assert.equal(options?.allowDuplicate, true);
    assert.equal(options?.tabID, tab.id);
    assert.equal(tab.type, "reader-loading");
    Zotero.Reader._readers.push(reader);
    return reader;
  };
  for (let i = 0; i < 2; i++) {
    const result = await installed.execute("get_page_count", {
      libraryID: 1,
      key: "ITEMKEY1",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(opens, 1);
  assert.equal(tab.type, "reader");
  assert.equal(Zotero.Reader._readers.length, 1);
});

it("a failed background open leaves an unloaded tab available to retry", async () => {
  const installed = installHost();
  Zotero.Reader._readers.length = 0;
  const tab = { id: "unloaded-pdf", type: "reader-unloaded" };
  Object.assign(Zotero, {
    getMainWindow: () => ({
      setTimeout,
      clearTimeout,
      Zotero_Tabs: {
        getTabIDByItemID: () => tab.id,
        _getTab: () => ({ tab }),
      },
    }),
  });
  Zotero.Reader.open = async () => {
    assert.equal(tab.type, "reader-loading");
    throw new Error("Unable to open PDF");
  };
  const result = await installed.execute("get_page_count", {
    libraryID: 1,
    key: "ITEMKEY1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /Unable to open PDF/);
  assert.equal(tab.type, "reader-unloaded");
});

it("isolates cancellation of a background reader open and reuses in-flight initialization", async () => {
  const installed = installHost();
  const reader = Zotero.Reader._readers.pop() as unknown as {
    _initPromise: Promise<void>;
  };
  let release!: () => void;
  reader._initPromise = new Promise((resolve) => {
    release = resolve;
  });
  let opens = 0;
  const original = Zotero.Reader.open;
  Zotero.Reader.open = (async (...args: Parameters<typeof original>) => {
    opens++;
    assert.equal(args[2]?.openInBackground, true);
    assert.equal(args[2]?.tabID, undefined);
    return original(...args);
  }) as typeof original;
  const controller = new AbortController();
  const stages: string[] = [];
  const first = installed.execute(
    "get_page_count",
    { libraryID: 1, key: "ITEMKEY1" },
    controller.signal,
    { onProgress: (event) => stages.push(event.stage) },
  );
  const second = installed.execute("get_page_count", {
    libraryID: 1,
    key: "ITEMKEY1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await first).effect, "none");
  const count = stages.length;
  release();
  assert.equal((await second).ok, true);
  assert.equal(opens, 1);
  assert.equal(stages.length, count);
  assert.ok(stages.includes("initializing_pdf"));
});

it("changes conflicting colors, retains the original batch across Agents, and protects human annotations", async () => {
  const env = installHost();
  const first = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        {
          type: "highlight",
          quote: "Original evidence",
          page: 1,
          comment: "old",
        },
      ],
    },
    undefined,
    { taskId: "first", agent: "native", taskTitle: "First batch" },
  );
  assert.equal(first.ok, true);
  const key = String(env.saved[0].key);
  const original = await env.host.ownership.owned("1_PDFKEY01", key);
  const second = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        {
          type: "highlight",
          quote: "Other evidence",
          page: 2,
          color: "#FFD400",
        },
      ],
    },
    undefined,
    { taskId: "second", agent: "kimi", taskTitle: "Second batch" },
  );
  assert.equal(second.ok, true);
  assert.notEqual(env.saved[1].color, env.saved[0].color);
  assert.ok(JSON.stringify(env.saved[1].tags).includes("Second batch"));
  const edited = await env.execute(
    "update_annotation_comment",
    { libraryID: 1, key, comment: "corrected" },
    undefined,
    { taskId: "second", agent: "kimi" },
  );
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const modified = await env.host.ownership.owned("1_PDFKEY01", key);
  assert.equal(modified?.batchId, original?.batchId);
  assert.equal(modified?.agent, "native");
  assert.equal(modified?.modifiedBy?.agent, "kimi");
  assert.ok(modified?.modifiedAt);
  env.native.set("HUMAN", {
    ...env.native.get(key),
    key: "HUMAN",
    annotationColor: "#123456",
  });
  for (const name of [
    "update_annotation_comment",
    "delete_annotation",
    "update_item_metadata",
  ]) {
    const denied = await env.execute(
      name,
      {
        libraryID: 1,
        key: "HUMAN",
        comment: "forbidden",
        fields: { title: "forbidden" },
      },
      undefined,
      { taskId: "third", agent: "codex" },
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "permission_denied");
  }
  const deleted = await env.execute(
    "delete_annotation",
    { libraryID: 1, key },
    undefined,
    { taskId: "third", agent: "codex" },
  );
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.ok(!env.native.has(key));
  assert.ok(env.native.has("HUMAN"));
  const view = await env.host.annotationBatchView(1, "PDFKEY01");
  assert.equal(view.existingCount, 1);
  assert.equal(view.total, 2);
});

it("rejects edits made stale by human changes after approval preview", async () => {
  const env = installHost();
  await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", quote: "Evidence", page: 1, comment: "old" },
      ],
    },
    undefined,
    { taskId: "creator" },
  );
  const key = String(env.saved[0].key);
  const args = { libraryID: 1, key, comment: "agent change" };
  const context: ToolExecutionContext = { taskId: "editor" };
  assert.equal(
    await env.host.prepare("update_annotation", args, context),
    null,
  );
  env.native.get(key)!.annotationComment = "human edit";
  const result = await env.host.execute(
    "update_annotation",
    args,
    undefined,
    context,
  );
  assert.equal(result.ok, false);
  assert.equal(env.native.get(key)!.annotationComment, "human edit");
});

it("legacy creation receipts grant edit permission without inventing a batch, agent or creation date", async () => {
  const env = installHost();
  const saved = await env.execute(
    "commit_annotations",
    {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "Legacy proof", comment: "old" },
      ],
    },
    undefined,
    { taskId: "old-task" },
  );
  assert.equal(saved.ok, true);
  const key = env.saved[0].key as string;
  await env.storage.write("ownership_1_PDFKEY01", {
    version: 1,
    batches: {},
    marks: {},
    filter: { mode: "all", batchIds: [], includeExisting: false },
  });
  const read = await env.execute("get_annotations", {
    libraryID: 1,
    key: "ITEMKEY1",
  });
  assert.equal(read.ok, true);
  const mark = await env.host.ownership.owned("1_PDFKEY01", key);
  assert.equal(mark?.taskId, "old-task");
  assert.equal(mark?.batchId, undefined);
  assert.equal(mark?.createdAt, undefined);
  assert.equal(mark?.agent, undefined);
  assert.ok(mark?.proofOperationId);
});
