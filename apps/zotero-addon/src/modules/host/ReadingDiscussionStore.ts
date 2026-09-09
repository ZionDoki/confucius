import type { ModelMessage, TurnCheckpoint } from "@confucius/harness";
import type {
  Citation,
  ModelEndpoint,
  ReadingCheckpoint,
  ReadingDiscussionRecord,
  ReadingState,
  RuntimeModelSelection,
  ContextWindowState,
  ReadingDiscussionEvent,
} from "@confucius/protocol";
import {
  ResourceLocks,
  runtimePath,
  runtimeIoPath,
  writeRuntimeText,
} from "./RuntimeStorage";

export interface DiscussionSeed {
  paperTitle: string;
  checkpoint: ReadingCheckpoint;
  citations: Citation[];
  before?: string;
  after?: string;
}

export interface StoredReadingDiscussion {
  record: ReadingDiscussionRecord;
  seed: DiscussionSeed;
  nativeModel?: Omit<ModelEndpoint, "apiKey">;
  runtimeModel?: RuntimeModelSelection;
  externalSessionId?: string;
  checkpoint?: TurnCheckpoint;
  history?: ModelMessage[];
  window?: ContextWindowState;
  archive?: Array<{
    id: string;
    windowId: string;
    message: ModelMessage;
    toolName?: string;
  }>;
  toolCalls: number;
  events?: ReadingDiscussionEvent[];
}

interface ReadingDocument {
  version: 1;
  state: ReadingState;
  discussions: StoredReadingDiscussion[];
}

export interface ReadingDisk {
  read(id: string): Promise<string | null>;
  write(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const safe = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("Invalid reading artifact ID");
  return id;
};
const defaultDisk: ReadingDisk = {
  async read(id) {
    const path = runtimeIoPath(
      runtimePath("reading-discussions", safe(id) + ".json"),
    );
    return (await IOUtils.exists(path)) ? IOUtils.readUTF8(path) : null;
  },
  async write(id, text) {
    await writeRuntimeText(
      runtimePath("reading-discussions", safe(id) + ".json"),
      text,
    );
  },
  async remove(id) {
    await IOUtils.remove(
      runtimeIoPath(runtimePath("reading-discussions", safe(id) + ".json")),
      { ignoreAbsent: true },
    );
  },
};

/** Private storage: deliberately never registered with task HistoryStore or MemoryEngine. */
export class ReadingDiscussionStore {
  private docs = new Map<string, ReadingDocument>();
  private locks = new ResourceLocks();
  constructor(private disk: ReadingDisk = defaultDisk) {}

  async load(artifactId: string): Promise<ReadingDocument> {
    safe(artifactId);
    return this.locks.run([artifactId], async () => {
      const cached = this.docs.get(artifactId);
      if (cached) return cached;
      const raw = await this.disk.read(artifactId);
      const doc: ReadingDocument = raw
        ? JSON.parse(raw)
        : {
            version: 1,
            state: { view: "guide", lens: "reading", expanded: {}, drafts: {} },
            discussions: [],
          };
      if (
        doc.version !== 1 ||
        !doc.state ||
        !Array.isArray(doc.discussions) ||
        !doc.discussions.every(
          (d) =>
            d.record?.artifactId === artifactId &&
            d.seed?.checkpoint &&
            Array.isArray(d.record.messages),
        )
      )
        throw new Error(
          "Reading history is damaged; the original file has been retained",
        );
      // No request resumes itself after a host restart.
      for (const d of doc.discussions)
        if (d.record.status === "running") {
          d.record.status = "interrupted";
          d.record.sequence++;
        }
      this.docs.set(artifactId, doc);
      return doc;
    });
  }

  async save(artifactId: string): Promise<void> {
    await this.load(artifactId);
    await this.locks.run([artifactId], async () => {
      const doc = this.docs.get(artifactId);
      if (doc) await this.disk.write(artifactId, JSON.stringify(doc));
    });
  }

  async state(
    artifactId: string,
    patch?: Partial<ReadingState>,
  ): Promise<ReadingState> {
    const doc = await this.load(artifactId);
    if (patch) {
      if (
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Object.keys(patch).some(
          (key) =>
            ![
              "view",
              "lens",
              "checkpointId",
              "checkpointOffset",
              "discussionCheckpointId",
              "quote",
              "expanded",
              "drafts",
            ].includes(key),
        )
      )
        throw new Error("Invalid reading state");
      if (patch.view !== undefined && !["guide", "report"].includes(patch.view))
        throw new Error("Invalid reading view");
      if (
        patch.lens !== undefined &&
        !["reading", "writing"].includes(patch.lens)
      )
        throw new Error("Invalid reading lens");
      if (
        patch.checkpointId !== undefined &&
        typeof patch.checkpointId !== "string"
      )
        throw new Error("Invalid checkpoint");
      if (
        patch.discussionCheckpointId !== undefined &&
        typeof patch.discussionCheckpointId !== "string"
      )
        throw new Error("Invalid discussion checkpoint");
      if (
        patch.checkpointOffset !== undefined &&
        !Number.isFinite(patch.checkpointOffset)
      )
        throw new Error("Invalid reading position");
      if (
        patch.quote != null &&
        (typeof patch.quote !== "object" ||
          typeof patch.quote.text !== "string" ||
          typeof patch.quote.checkpointId !== "string")
      )
        throw new Error("Invalid reading quotation");
      for (const [key, type] of [
        ["expanded", "boolean"],
        ["drafts", "string"],
      ] as const) {
        const values = patch[key];
        if (
          values !== undefined &&
          (!values ||
            typeof values !== "object" ||
            Array.isArray(values) ||
            Object.values(values).some((v) => typeof v !== type))
        )
          throw new Error("Invalid reading state");
      }
      doc.state = {
        ...doc.state,
        ...patch,
        expanded: { ...doc.state.expanded, ...patch.expanded },
        drafts: { ...doc.state.drafts, ...patch.drafts },
      };
      await this.save(artifactId);
    }
    return JSON.parse(JSON.stringify(doc.state));
  }

  async get(
    artifactId: string,
    discussionId: string,
  ): Promise<StoredReadingDiscussion> {
    const found = (await this.load(artifactId)).discussions.find(
      (d) => d.record.id === discussionId,
    );
    if (!found) throw new Error("Reading discussion not found");
    return found;
  }

  async remove(artifactId: string): Promise<void> {
    await this.locks.run([artifactId], async () => {
      await this.disk.remove(safe(artifactId));
      this.docs.delete(artifactId);
    });
  }
}
