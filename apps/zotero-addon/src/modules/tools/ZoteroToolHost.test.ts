import { memoryJsonStorage, type JsonStorage } from "../host/RuntimeStorage";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZoteroToolHost } from "./ZoteroToolHost";
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
  const native = new Map<string, Record<string, unknown>>();
  const storage = memoryJsonStorage();

  const parent = {
    id: 100,
    libraryID,
    key: "ITEMKEY1",
    isAttachment: () => false,
    isNote: () => false,
    getAttachments: () => [200],
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
    getAnnotations: () => [...native.values()],
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
    numPages: options.pageTexts?.length ?? 4,
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
  const controller = {
    _pdfDocument: {},
    _pendingFindMatches: new Set<number>(),
    pageMatches: [[0], [0], [0], [0]],
    find: async () => undefined,
    getMatchPositionsAsync: async () =>
      options.missingQuotes?.includes(query)
        ? []
        : [{ rects: [[10, 20, 40, 35]] }],
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
    setFindState: async (state: { query: string }) => {
      query = state.query;
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
    utils: { cloneInto: (value: unknown) => value },
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
              : (native.get(key) ?? null),
      get: (id: number) =>
        id === attachment.id ? attachment : id === parent.id ? parent : null,
    },
    Reader: {
      _readers: [reader],
      open: async () => reader,
    },
    Promise: { delay: async () => undefined },
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

it("isolates cancellation of a reader wait and reuses in-flight initialization", async () => {
  const installed = installHost();
  const reader = Zotero.Reader._readers[0] as unknown as {
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
