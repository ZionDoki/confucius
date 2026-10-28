/**
 * Flex-Annotations-Organizer-Tools: Outline lesen, Annotationen listen,
 * Kontext liefern und Zuweisungen schreiben. Eigenständige Datei, damit das
 * Feature später aus dem Plugin entfernbar bleibt, ohne ZoteroToolHost.ts zu
 * zerschneiden. Die reine Outline-Logik (ohne Zotero-Zugriff) liegt in
 * @confucius/zotero-tools (organizerLogic.ts).
 */

import type { ToolExecutionContext, ToolFailure } from "@confucius/protocol";
import type {
  ToolErrorCode,
  ToolResult,
  ToolTransientMedia,
} from "@confucius/protocol";
import { buildWorkCitation } from "./workCitation";
import {
  COLLECTION_TAG_PREFIX,
  HEADING_PREFIX,
  OUTLINE_TAG,
  TOOL_META,
  buildHeadingLookup,
  extractSurroundingContext,
  flattenOutline,
  headingTag,
  outlineCollectionTag,
  parseOutline,
  type FlatHeading,
  type OutlineNode,
} from "@confucius/zotero-tools";

function ok(
  toolName: string,
  data: unknown,
  transientMedia?: ToolTransientMedia[],
): ToolResult {
  return { ok: true, toolName, data, transientMedia };
}

function fail(
  toolName: string,
  code: ToolErrorCode,
  message: string,
  details?: unknown,
): ToolFailure {
  return { ok: false, toolName, code, message, details };
}

function asItem(value: unknown): Zotero.Item | null {
  if (!value || value === false || Array.isArray(value)) {
    return null;
  }
  return value as Zotero.Item;
}

function asCollection(value: unknown): Zotero.Collection | null {
  if (!value || value === false || Array.isArray(value)) {
    return null;
  }
  return value as Zotero.Collection;
}

function defaultLibraryID(args: Record<string, unknown>): number {
  if (typeof args.libraryID === "number" && Number.isInteger(args.libraryID)) {
    return args.libraryID;
  }
  return Zotero.Libraries.userLibraryID;
}

function getItem(libraryID: number, key: string): Zotero.Item | null {
  return asItem(Zotero.Items.getByLibraryAndKey(libraryID, key));
}

function annotationCreationTime(
  item: Zotero.Item | null,
  field: "dateAdded" | "dateModified" = "dateAdded",
): number {
  const stamp = String(item?.[field] ?? "");
  const time = Date.parse(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(stamp)
      ? stamp.replace(" ", "T") + "Z"
      : stamp,
  );
  return Number.isFinite(time) ? time : Date.now();
}

/** Kurze Alias-Namen, mit denen das Modell die Organizer-Tools ansprechen kann. */
export const ORGANIZER_TOOL_ALIASES: Record<string, string> = {
  outline_get: "organizer_get_outline",
  annotations_list: "organizer_list_annotations",
  annotation_context: "organizer_get_annotation_context",
  annotations_assign: "organizer_assign_annotations",
  annotations_unassign: "organizer_unassign_annotations",
};

/** Schreibende Organizer-Tools (kanonische Namen). */
export const ORGANIZER_WRITE_TOOL_NAMES = [
  "organizer_assign_annotations",
  "organizer_unassign_annotations",
] as const;

/** Lesende Organizer-Tools (kanonische Namen). */
export const ORGANIZER_READ_TOOL_NAMES = [
  "organizer_get_outline",
  "organizer_list_annotations",
  "organizer_get_annotation_context",
] as const;

/** Alias-Auflösung: kanonischer Name für ein Tool-Etikett. */
export function resolveOrganizerToolName(name: string): string {
  return ORGANIZER_TOOL_ALIASES[name] ?? name;
}

export function isOrganizerWriteTool(canonicalName: string): boolean {
  return (ORGANIZER_WRITE_TOOL_NAMES as readonly string[]).includes(
    canonicalName,
  );
}

export function isOrganizerReadTool(canonicalName: string): boolean {
  return (ORGANIZER_READ_TOOL_NAMES as readonly string[]).includes(
    canonicalName,
  );
}

/**
 * Vereinheitlicht Argument-Aliase (collectionKey -> collection,
 * annotationKey -> key), bevor Schema-Validierung und Ausführung laufen.
 */
export function normalizeOrganizerToolArgs(
  args: Record<string, unknown>,
): void {
  if (args && typeof args === "object") {
    if (!args.collection && args.collectionKey) {
      args.collection = args.collectionKey;
    }
    if (!args.key && args.annotationKey) {
      args.key = args.annotationKey;
    }
  }
}

/** Struktur der Prepare-Ablehnung (identisch zu ZoteroToolHost.prepare). */
export type OrganizerRejection = {
  ok: false;
  toolName: string;
  code: ToolErrorCode;
  effect: "none";
  message: string;
};

export function rejectOrganizer(
  toolName: string,
  message: string,
  code: ToolErrorCode = "invalid_args",
): OrganizerRejection {
  return { ok: false, toolName, code, effect: "none", message };
}

/**
 * Validate-and-prepare für die schreibenden Organizer-Tools vor einem
 * Approval: Bibliotheksrechte prüfen, Argumente normalisieren, Ressourcen
 * für Rollback sammeln und die vorbereitete Operation im Kontext ablegen.
 */
export async function prepareOrganizerWrite(
  organizer: OrganizerTools,
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<OrganizerRejection | null> {
  const canonicalName = resolveOrganizerToolName(name);
  const reject = (message: string, code?: ToolErrorCode) =>
    rejectOrganizer(name, message, code);

  const libraryID = defaultLibraryID(args);
  const library = Zotero.Libraries.get?.(libraryID);
  if (library && library.editable === false)
    return reject("Zotero library is read-only", "permission_denied");
  const colRef = String(args.collection ?? args.collectionKey ?? "").trim();
  if (!colRef) return reject("collection is required");
  const col = organizer.getCollectionByRef(libraryID, colRef);
  if (!col)
    return reject(
      `Collection "${colRef}" was not found in library ${libraryID}`,
      "not_found",
    );
  let assignments = args.assignments;
  if (!Array.isArray(assignments)) {
    if (Array.isArray(args.keys)) {
      const h = Array.isArray(args.headings) ? (args.headings as string[]) : [];
      assignments = (args.keys as string[]).map((k) => ({
        key: k,
        headings: h,
      }));
    } else if (typeof args.key === "string" && args.key) {
      const h = Array.isArray(args.headings) ? (args.headings as string[]) : [];
      assignments = [{ key: args.key, headings: h }];
    }
  }
  if (!Array.isArray(assignments))
    return reject("assignments must be an array");

  try {
    const topmost = organizer.getTopmostCollection(col);
    const note = await organizer.findOutlineNote(libraryID, topmost.key);
    if (note) {
      const roots = parseOutline(note.getNote?.() || "");
      const headings = flattenOutline(roots);
      organizer.cacheOutline(libraryID, topmost.key, roots, headings);
      if (col.key !== topmost.key) {
        organizer.cacheOutline(libraryID, col.key, roots, headings);
      }
      if (colRef) {
        organizer.cacheOutline(libraryID, colRef, roots, headings);
      }
    }
  } catch {
    // Outline caching during prepare is best-effort
  }

  const resources = [`zotero-collection:${col.libraryID}:${col.key}`];
  for (const entry of assignments as Array<{ key?: string }>) {
    const k = String(entry?.key ?? "").trim();
    if (k) resources.push(`zotero:${libraryID}:${k}`);
  }
  context.resources = [
    ...new Set([...(context.resources ?? []), ...resources]),
  ];
  context.preparedOperation = {
    schemaVersion: 1,
    domain: TOOL_META[canonicalName]?.catalog ?? "library.write",
    name,
    args: JSON.parse(JSON.stringify(args)),
    resources: context.resources,
    recovery: {},
  };
  return null;
}

/**
 * Validate-and-prepare für die lesenden Organizer-Tools: Zielreferenzen
 * prüfen, damit dem Modell ein frühzeitiger not_found statt eines Fehlers
 * beim eigentlichen Aufruf entgegenschlägt.
 */
export function prepareOrganizerRead(
  organizer: OrganizerTools,
  name: string,
  args: Record<string, unknown>,
): OrganizerRejection | null {
  const canonicalName = resolveOrganizerToolName(name);
  const reject = (message: string, code?: ToolErrorCode) =>
    rejectOrganizer(name, message, code);

  const libraryID = defaultLibraryID(args);
  const colRef = String(args.collection ?? args.collectionKey ?? "").trim();
  if (canonicalName === "organizer_list_annotations" && !colRef) {
    return reject("collection is required");
  }
  if (colRef) {
    const col = organizer.getCollectionByRef(libraryID, colRef);
    if (!col)
      return reject(
        `Collection "${colRef}" was not found in library ${libraryID}`,
        "not_found",
      );
  }
  if (canonicalName === "organizer_get_annotation_context") {
    const key = String(args.key ?? args.annotationKey ?? "").trim();
    if (!key) return reject("key is required");
    const item = getItem(libraryID, key);
    if (!item || !item.isAnnotation?.())
      return reject(
        `Annotation ${key} not found in library ${libraryID}`,
        "not_found",
      );
  }
  return null;
}

/**
 * Zustandshaltiger Host für die Organizer-Tools: hält den Outline- und
 * Annotation-Cache und implementiert die fünf Tools gegen die Zotero-API.
 */
export class OrganizerTools {
  private outlineCache = new Map<
    string,
    { roots: OutlineNode[]; headings: FlatHeading[] }
  >();

  private annotationCache = new Map<
    string,
    {
      key: string;
      text: string;
      comment: string;
      pageLabel: string;
      color: string;
      workTitle: string;
      workCitation: string;
      libraryID: number;
    }
  >();

  public cacheAnnotation(
    key: string,
    data: {
      key: string;
      text: string;
      comment: string;
      pageLabel: string;
      color: string;
      workTitle: string;
      workCitation: string;
      libraryID: number;
    },
  ): void {
    this.annotationCache.set(key, data);
  }

  public getCachedAnnotation(key: string) {
    return this.annotationCache.get(key);
  }

  public cacheOutline(
    libraryID: number,
    keyOrRef: string | null | undefined,
    roots: OutlineNode[],
    headings: FlatHeading[],
  ): void {
    const norm = (keyOrRef ?? "").trim().toLowerCase();
    this.outlineCache.set(`${libraryID}:${norm}`, { roots, headings });
  }

  public getOutlineCache(
    libraryID: number,
    colRef?: string | null,
  ): { roots: OutlineNode[]; headings: FlatHeading[] } | undefined {
    const ref = (colRef ?? "").trim();
    if (ref) {
      const direct = this.outlineCache.get(`${libraryID}:${ref.toLowerCase()}`);
      if (direct) return direct;
      const col = this.getCollectionByRef(libraryID, ref);
      if (col) {
        const byKey = this.outlineCache.get(
          `${libraryID}:${col.key.toLowerCase()}`,
        );
        if (byKey) return byKey;
        const topmost = this.getTopmostCollection(col);
        const byTop = this.outlineCache.get(
          `${libraryID}:${topmost.key.toLowerCase()}`,
        );
        if (byTop) return byTop;
        const colItems = (col as any).getChildItems?.() ?? [];
        const topItems = (topmost as any).getChildItems?.() ?? [];
        const note = [...colItems, ...topItems].find(
          (it: any) =>
            it &&
            typeof it.isNote === "function" &&
            it.isNote() &&
            it.getTags?.().some((t: any) => t.tag === OUTLINE_TAG),
        );
        if (note) {
          const roots = parseOutline(note.getNote?.() || "");
          const headings = flattenOutline(roots);
          this.cacheOutline(libraryID, col.key, roots, headings);
          this.cacheOutline(libraryID, topmost.key, roots, headings);
          return { roots, headings };
        }
      }
    }
    return (
      this.outlineCache.get(`${libraryID}:`) ??
      this.outlineCache.get(`${libraryID}:all`)
    );
  }

  /**
   * Asynchronously resolve outline hierarchy from cache or by finding the outline note.
   */
  public async resolveOutline(
    libraryID: number,
    colRef?: string | null,
  ): Promise<{ roots: OutlineNode[]; headings: FlatHeading[] } | undefined> {
    const cached = this.getOutlineCache(libraryID, colRef);
    if (cached) return cached;
    let col: Zotero.Collection | null = null;
    let topmostKey: string | null = null;
    const ref = (colRef ?? "").trim();
    if (ref) {
      col = this.getCollectionByRef(libraryID, ref);
      if (col) {
        const topmost = this.getTopmostCollection(col);
        topmostKey = topmost.key;
      }
    }
    let note = await this.findOutlineNote(libraryID, topmostKey);
    if (!note && col?.key && col.key !== topmostKey) {
      note = await this.findOutlineNote(libraryID, col.key);
    }
    if (!note && col) {
      const colItems = (col as any).getChildItems?.() ?? [];
      const topItems =
        topmostKey && topmostKey !== col.key
          ? ((
              this.getCollectionByRef(libraryID, topmostKey) as any
            )?.getChildItems?.() ?? [])
          : [];
      note =
        [...colItems, ...topItems].find(
          (it: any) =>
            it &&
            typeof it.isNote === "function" &&
            it.isNote() &&
            it.getTags?.().some((t: any) => t.tag === OUTLINE_TAG),
        ) ?? null;
    }
    if (!note) {
      note = await this.findOutlineNote(libraryID, null);
    }
    if (!note) {
      return undefined;
    }
    const roots = parseOutline(note.getNote?.() || "");
    const headings = flattenOutline(roots);
    if (topmostKey) {
      this.cacheOutline(libraryID, topmostKey, roots, headings);
    }
    if (col?.key) {
      this.cacheOutline(libraryID, col.key, roots, headings);
    }
    if (ref) {
      this.cacheOutline(libraryID, ref, roots, headings);
    }
    if (!topmostKey && !col?.key) {
      this.cacheOutline(libraryID, "", roots, headings);
    }
    return { roots, headings };
  }

  /** Look up a collection by key, or by name or id if key lookup fails. */
  public getCollectionByRef(
    libraryID: number,
    ref: string,
  ): Zotero.Collection | null {
    if (!ref) return null;
    const byKey = asCollection(
      Zotero.Collections.getByLibraryAndKey(libraryID, ref),
    );
    if (byKey) return byKey;
    if (/^\d+$/.test(ref)) {
      const byId = asCollection(Zotero.Collections.get?.(Number(ref)));
      if (byId && byId.libraryID === libraryID) return byId;
    }
    const all = Zotero.Collections.getByLibrary?.(libraryID) ?? [];
    return (
      all.find(
        (c) =>
          c.name.toLowerCase() === ref.toLowerCase() ||
          c.key === ref ||
          String(c.id) === ref,
      ) ?? null
    );
  }

  /** Walk up from a collection to its top-level ancestor. */
  public getTopmostCollection(
    collection: Zotero.Collection,
  ): Zotero.Collection {
    let cur = collection;
    const visited = new Set<number>([cur.id]);
    while (cur.parentID) {
      if (visited.has(cur.parentID)) break;
      const parent = asCollection(Zotero.Collections.get?.(cur.parentID));
      if (!parent) break;
      visited.add(parent.id);
      cur = parent;
    }
    return cur;
  }

  /** Get all collection IDs for a collection and all its subcollections. */
  private getCollectionScopeIDs(
    libraryID: number,
    rootCol: Zotero.Collection,
  ): Set<number> {
    const ids = new Set<number>([rootCol.id]);
    const queue = [rootCol.id];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      let children: Zotero.Collection[] = [];
      if (typeof Zotero.Collections.getByParent === "function") {
        children = Zotero.Collections.getByParent(pid) || [];
      } else {
        const curCol = asCollection(Zotero.Collections.get?.(pid));
        if (typeof curCol?.getChildCollections === "function") {
          const raw = curCol.getChildCollections();
          children = ((raw as any[]) ?? [])
            .map((entry) =>
              typeof entry === "number"
                ? asCollection(Zotero.Collections.get?.(entry))
                : asCollection(entry),
            )
            .filter((c): c is Zotero.Collection => Boolean(c));
        } else if (typeof Zotero.Collections.getByLibrary === "function") {
          children = (Zotero.Collections.getByLibrary(libraryID) || []).filter(
            (c) => c.parentID === pid,
          );
        }
      }
      for (const child of children) {
        if (!ids.has(child.id)) {
          ids.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return ids;
  }

  /** Find the newest outline note matching the collection or library-wide marker. */
  public async findOutlineNote(
    libraryID: number,
    collectionKey: string | null,
  ): Promise<Zotero.Item | null> {
    let ids: number[] = [];
    if (typeof (Zotero as any).Search === "function") {
      const search = new (Zotero as any).Search({ libraryID });
      (search as any).libraryID = libraryID;
      search.addCondition("tag", "is", OUTLINE_TAG);
      ids = (await search.search()) as number[];
    } else if (typeof Zotero.Items?.getAll === "function") {
      const all = (await Zotero.Items.getAll(
        libraryID,
        true,
        false,
      )) as unknown as Array<Zotero.Item | number>;
      ids = all
        .map((it) => (typeof it === "number" ? it : it?.id))
        .filter((id): id is number => typeof id === "number");
    }
    const items = (await Zotero.Items.getAsync(ids)) as Zotero.Item[];
    const notes = items.filter(
      (item) => item && item.isNote?.() && !(item as any).deleted,
    );

    const matching = notes.filter((note) => {
      const tags = note.getTags().map((t) => t.tag);
      if (collectionKey === null) {
        return !tags.some((t) => t.startsWith(COLLECTION_TAG_PREFIX));
      }
      return tags.includes(outlineCollectionTag(collectionKey));
    });

    let best: Zotero.Item | null = null;
    for (const n of matching) {
      if (!best) {
        best = n;
        continue;
      }
      const timeA = annotationCreationTime(n, "dateModified");
      const timeB = annotationCreationTime(best, "dateModified");
      if (timeA > timeB || (timeA === timeB && n.id > best.id)) {
        best = n;
      }
    }
    return best;
  }

  /** Dispatch und Ausführung eines Organizer-Tools (kanonischer Name oder Alias). */
  async run(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    switch (name) {
      case "organizer_get_outline":
      case "outline_get":
        return this.getOutline(args);
      case "organizer_list_annotations":
      case "annotations_list":
        return this.listAnnotations(args);
      case "organizer_get_annotation_context":
      case "annotation_context":
        return this.getAnnotationContext(args);
      case "organizer_assign_annotations":
      case "annotations_assign":
        return this.assignAnnotations(args, context);
      case "organizer_unassign_annotations":
      case "annotations_unassign":
        return this.unassignAnnotations(args, context);
      default:
        return fail(
          "organizer",
          "not_found",
          `Unknown organizer tool: ${name}`,
        );
    }
  }

  private async getOutline(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const colRef = String(args.collection ?? args.collectionKey ?? "").trim();

    let topmostKey: string | null = null;
    let col: Zotero.Collection | null = null;

    if (colRef) {
      col = this.getCollectionByRef(libraryID, colRef);
      if (!col) {
        return fail(
          "organizer_get_outline",
          "not_found",
          `Collection "${colRef}" was not found in library ${libraryID}`,
        );
      }
      const topmost = this.getTopmostCollection(col);
      topmostKey = topmost.key;
    }

    const note = await this.findOutlineNote(libraryID, topmostKey);
    if (!note) {
      if (topmostKey) {
        return fail(
          "organizer_get_outline",
          "not_found",
          `No Flex Annotations outline found for collection "${colRef}" (topmost: ${topmostKey}). Please create an outline in Organizer first.`,
        );
      }
      return fail(
        "organizer_get_outline",
        "not_found",
        "No library-wide Flex Annotations outline found.",
      );
    }

    const roots = parseOutline(note.getNote?.() || "");
    const headings = flattenOutline(roots);

    this.cacheOutline(libraryID, topmostKey, roots, headings);
    if (col?.key) {
      this.cacheOutline(libraryID, col.key, roots, headings);
    }
    if (colRef) {
      this.cacheOutline(libraryID, colRef, roots, headings);
    }
    if (!topmostKey) {
      this.cacheOutline(libraryID, "", roots, headings);
    }

    return ok("organizer_get_outline", {
      libraryID,
      collectionKey: col?.key ?? null,
      topmostCollectionKey: topmostKey,
      noteKey: note.key,
      headings,
      outline: headings,
      roots,
      tree: roots,
    });
  }

  private async listAnnotations(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const colRef = String(args.collection ?? args.collectionKey ?? "").trim();
    if (!colRef) {
      return fail(
        "organizer_list_annotations",
        "invalid_args",
        "collection is required",
      );
    }

    const col = this.getCollectionByRef(libraryID, colRef);
    if (!col) {
      return fail(
        "organizer_list_annotations",
        "not_found",
        `Collection "${colRef}" was not found in library ${libraryID}`,
      );
    }

    const topmost = this.getTopmostCollection(col);
    const scopeColIDs = this.getCollectionScopeIDs(libraryID, topmost);

    const note = await this.findOutlineNote(libraryID, topmost.key);
    const roots = note ? parseOutline(note.getNote?.() || "") : [];
    const outlineHeadings = flattenOutline(roots);
    const outlineTags = new Set(outlineHeadings.map((h) => h.tag));
    this.cacheOutline(libraryID, topmost.key, roots, outlineHeadings);
    if (col.key !== topmost.key) {
      this.cacheOutline(libraryID, col.key, roots, outlineHeadings);
    }
    if (colRef) {
      this.cacheOutline(libraryID, colRef, roots, outlineHeadings);
    }

    const unassignedOnly = args.unassignedOnly !== false;

    const workIDs = new Set<number>();
    for (const cid of scopeColIDs) {
      const c = Zotero.Collections.get(cid);
      if (!c) continue;
      const raw = (c.getChildItems?.() ?? []) as unknown as Array<
        Zotero.Item | number
      >;
      for (const it of raw) {
        const id = typeof it === "number" ? it : it?.id;
        if (typeof id === "number") workIDs.add(id);
      }
    }

    const works = (await Zotero.Items.getAsync(
      Array.from(workIDs),
    )) as Zotero.Item[];
    const candidateAnnotations: Array<{
      annotation: Zotero.Item;
      attachment: Zotero.Item;
      work: Zotero.Item;
    }> = [];

    for (const work of works) {
      if (!work || work.isNote?.() || work.isAnnotation?.()) continue;
      const attachments = work.isAttachment?.()
        ? [work]
        : ((await Zotero.Items.getAsync(
            (work.getAttachments?.() ?? []) as number[],
          )) as Zotero.Item[]);
      for (const attachment of attachments) {
        if (!attachment || !attachment.isAttachment?.()) continue;
        const annIDs = (attachment.getAnnotations?.(false) ?? []) as Array<
          number | Zotero.Item
        >;
        const rawAnnotations = annIDs.map((entry) =>
          typeof entry === "object" && entry
            ? entry
            : Zotero.Items.get(entry as number),
        );
        for (const ann of rawAnnotations) {
          if (!ann || !ann.isAnnotation?.() || (ann as any).deleted) continue;
          candidateAnnotations.push({
            annotation: ann,
            attachment,
            work,
          });
        }
      }
    }

    const items: Array<Record<string, unknown>> = [];
    for (const { annotation, attachment, work } of candidateAnnotations) {
      const text = annotation.annotationText || "";
      const comment = annotation.annotationComment || "";
      const type = annotation.annotationType || "";
      if (["image", "ink"].includes(type) && !text && !comment) continue;

      const tags = annotation.getTags().map((t) => t.tag);
      const assignedHeadings = tags
        .filter((t) => outlineTags.has(t))
        .map((t) => t.slice(HEADING_PREFIX.length));

      if (unassignedOnly && assignedHeadings.length > 0) {
        continue;
      }

      items.push({
        key: annotation.key,
        type,
        text,
        comment,
        pageLabel: annotation.annotationPageLabel || "",
        color: annotation.annotationColor || "",
        tags,
        assignedHeadings,
        headings: assignedHeadings,
        work: {
          key: work.key,
          title: work.getDisplayTitle?.() || work.getField?.("title") || "",
          creators:
            (work as any).firstCreator ||
            work
              .getCreators?.()
              ?.map(
                (c: any) =>
                  `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
                  c.name ||
                  "",
              )
              .filter(Boolean)
              .join(", ") ||
            "",
        },
        attachmentKey: attachment.key,
        libraryID: annotation.libraryID,
      });

      const { title: workTitle, citation: workCitation } =
        buildWorkCitation(work);

      this.cacheAnnotation(annotation.key, {
        key: annotation.key,
        text,
        comment,
        pageLabel: annotation.annotationPageLabel || "",
        color: annotation.annotationColor || "",
        workTitle,
        workCitation,
        libraryID: annotation.libraryID,
      });
    }

    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, 100));
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit < items.length ? offset + limit : null;

    return ok("organizer_list_annotations", {
      collectionKey: col.key,
      topmostCollectionKey: topmost.key,
      total: items.length,
      offset,
      limit,
      nextOffset,
      annotations: page,
    });
  }

  private async getAnnotationContext(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? args.annotationKey ?? "").trim();
    if (!key) {
      return fail(
        "organizer_get_annotation_context",
        "invalid_args",
        "key is required",
      );
    }

    const item = getItem(libraryID, key);
    if (!item || !item.isAnnotation?.()) {
      return fail(
        "organizer_get_annotation_context",
        "not_found",
        `Annotation ${key} not found in library ${libraryID}`,
      );
    }

    const parent = item.parentItemID
      ? asItem(Zotero.Items.get(item.parentItemID))
      : null;
    if (!parent) {
      return fail(
        "organizer_get_annotation_context",
        "not_found",
        `Parent attachment for annotation ${key} not found`,
      );
    }

    const text = (await parent.attachmentText) || "";
    const quote = item.annotationText || "";
    const chars = Math.max(100, Math.min(Number(args.chars) || 1000, 5000));

    const extracted = extractSurroundingContext(text, quote, chars);

    return ok("organizer_get_annotation_context", {
      key: item.key,
      quote,
      comment: item.annotationComment || "",
      pageLabel: item.annotationPageLabel || "",
      context: extracted ? extracted.context : text ? text.slice(0, chars) : "",
      contextFound: Boolean(extracted),
      attachmentKey: parent.key,
      libraryID,
    });
  }

  private async assignAnnotations(
    args: Record<string, unknown>,
    _context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const colRef = String(args.collection ?? args.collectionKey ?? "").trim();
    if (!colRef) {
      return fail(
        "organizer_assign_annotations",
        "invalid_args",
        "collection is required",
      );
    }

    const col = this.getCollectionByRef(libraryID, colRef);
    if (!col) {
      return fail(
        "organizer_assign_annotations",
        "not_found",
        `Collection "${colRef}" was not found in library ${libraryID}`,
      );
    }

    const assignments = args.assignments;
    if (!Array.isArray(assignments)) {
      return fail(
        "organizer_assign_annotations",
        "invalid_args",
        "assignments must be an array",
      );
    }

    const dryRun = Boolean(args.dryRun);
    const topmost = this.getTopmostCollection(col);
    const scopeColIDs = this.getCollectionScopeIDs(libraryID, topmost);

    const note = await this.findOutlineNote(libraryID, topmost.key);
    if (!note) {
      return fail(
        "organizer_assign_annotations",
        "not_found",
        `No organizer outline found for collection "${colRef}". Create an outline first.`,
      );
    }

    const roots = parseOutline(note.getNote?.() || "");
    const headingLookup = buildHeadingLookup(roots);

    const assigned: Array<{ key: string; added: string[] }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    const unknownHeadings: string[] = [];

    for (const entry of assignments as Array<{
      key?: string;
      headings?: string[];
      reason?: string;
    }>) {
      const key = String(entry?.key ?? "").trim();
      if (!key) continue;

      if (!entry.headings || !entry.headings.length) {
        skipped.push({ key, reason: "no heading" });
        continue;
      }

      const item = getItem(libraryID, key);
      if (!item || !item.isAnnotation?.()) {
        skipped.push({ key, reason: "annotation not found" });
        continue;
      }

      if ((item as any).isEditable?.() === false) {
        skipped.push({ key, reason: "item not editable" });
        continue;
      }

      const att = item.parentItemID
        ? asItem(Zotero.Items.get(item.parentItemID))
        : null;
      const work = att?.parentItemID
        ? asItem(Zotero.Items.get(att.parentItemID))
        : att;
      const workCols = (work?.getCollections?.() ?? []) as number[];
      const inScope = workCols.some((cid) => scopeColIDs.has(cid));
      if (!inScope) {
        skipped.push({ key, reason: "work not in collection" });
        continue;
      }

      const validTags: string[] = [];
      for (const h of entry.headings) {
        const match = headingLookup.get(h.trim().toLowerCase());
        if (match) {
          if (!validTags.includes(match.tag)) {
            validTags.push(match.tag);
          }
        } else {
          if (!unknownHeadings.includes(h)) {
            unknownHeadings.push(h);
          }
        }
      }

      if (!validTags.length) {
        skipped.push({ key, reason: "no valid heading" });
        continue;
      }

      const currentTags = new Set(item.getTags().map((t) => t.tag));
      const toAdd = validTags.filter((t) => !currentTags.has(t));
      if (!toAdd.length) {
        skipped.push({ key, reason: "already assigned" });
        continue;
      }

      if (!dryRun) {
        for (const tag of toAdd) {
          item.addTag(tag);
        }
        if (typeof item.saveTx === "function") {
          await item.saveTx();
        } else {
          await item.save();
        }
      }
      assigned.push({ key, added: toAdd });
    }

    return ok("organizer_assign_annotations", {
      assigned,
      skipped,
      unknownHeadings,
    });
  }

  private async unassignAnnotations(
    args: Record<string, unknown>,
    _context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const colRef = String(args.collection ?? args.collectionKey ?? "").trim();
    if (!colRef) {
      return fail(
        "organizer_unassign_annotations",
        "invalid_args",
        "collection is required",
      );
    }

    const col = this.getCollectionByRef(libraryID, colRef);
    if (!col) {
      return fail(
        "organizer_unassign_annotations",
        "not_found",
        `Collection "${colRef}" was not found in library ${libraryID}`,
      );
    }

    let assignments = args.assignments;
    if (!Array.isArray(assignments)) {
      if (Array.isArray(args.keys)) {
        const h = Array.isArray(args.headings)
          ? (args.headings as string[])
          : [];
        assignments = (args.keys as string[]).map((k) => ({
          key: k,
          headings: h,
        }));
      } else if (typeof args.key === "string" && args.key) {
        const h = Array.isArray(args.headings)
          ? (args.headings as string[])
          : [];
        assignments = [{ key: args.key, headings: h }];
      } else {
        return fail(
          "organizer_unassign_annotations",
          "invalid_args",
          "assignments or keys must be provided",
        );
      }
    }

    const dryRun = Boolean(args.dryRun);
    const topmost = this.getTopmostCollection(col);
    const note = await this.findOutlineNote(libraryID, topmost.key);
    const roots = note ? parseOutline(note.getNote?.() || "") : [];
    const outlineTags = new Set(flattenOutline(roots).map((h) => h.tag));

    const unassigned: Array<{ key: string; removed: string[] }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];

    for (const entry of assignments as Array<{
      key?: string;
      headings?: string[];
    }>) {
      const key = String(entry?.key ?? "").trim();
      if (!key) continue;

      const item = getItem(libraryID, key);
      if (!item || !item.isAnnotation?.()) {
        skipped.push({ key, reason: "annotation not found" });
        continue;
      }

      if ((item as any).isEditable?.() === false) {
        skipped.push({ key, reason: "item not editable" });
        continue;
      }

      const currentTags = new Set(item.getTags().map((t) => t.tag));
      let toRemove: string[];
      if (entry.headings && entry.headings.length) {
        toRemove = entry.headings
          .map((h) => headingTag(h))
          .filter((t) => currentTags.has(t));
      } else {
        toRemove = Array.from(currentTags).filter((t) => outlineTags.has(t));
      }

      if (!toRemove.length) {
        skipped.push({ key, reason: "heading not assigned" });
        continue;
      }

      if (!dryRun) {
        for (const tag of toRemove) {
          item.removeTag(tag);
        }
        if (typeof item.saveTx === "function") {
          await item.saveTx();
        } else {
          await item.save();
        }
      }
      unassigned.push({ key, removed: toRemove });
    }

    return ok("organizer_unassign_annotations", {
      unassigned,
      skipped,
    });
  }
}
