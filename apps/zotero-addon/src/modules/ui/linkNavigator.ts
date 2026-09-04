import { parseZoteroUri, type ZoteroUri } from "@confucius/protocol";
import { getString } from "../../utils/locale";
import { findPdf } from "../tools/ZoteroToolHost";

export interface OpenLinkResult {
  ok: boolean;
  message?: string;
}

type ReaderLike = {
  itemID: number;
  tabID?: string;
  _window?: Window;
  navigate?: (location: Record<string, unknown>) => Promise<void> | void;
};

type AnnotationLike = {
  key?: string;
  parentItemID?: number | false;
  isAnnotation?: () => boolean;
};

/** Pick an already-open reader for the attachment, if any. */
export function selectExistingReader(
  readers: ReaderLike[],
  itemID: number,
): ReaderLike | null {
  return readers.find((reader) => reader.itemID === itemID) ?? null;
}

/** Resolve annotation first, then degrade to the encoded page if it vanished. */
export function pdfLocationForUri(
  uri: Extract<ZoteroUri, { kind: "open-pdf" }>,
  attachmentID: number,
  annotation: AnnotationLike | null,
): Record<string, unknown> | null {
  if (
    uri.annotationKey &&
    annotation?.key === uri.annotationKey &&
    annotation.parentItemID === attachmentID &&
    annotation.isAnnotation?.() !== false
  ) {
    return { annotationID: uri.annotationKey };
  }
  return uri.page ? { pageIndex: uri.page - 1 } : null;
}

function resolveLibraryID(uri: ZoteroUri): number | null {
  if (uri.groupID) {
    return Zotero.Groups.getLibraryIDFromGroupID(uri.groupID) || null;
  }
  return Zotero.Libraries.userLibraryID;
}

function asItem(value: unknown): Zotero.Item | null {
  if (!value || value === false || Array.isArray(value)) {
    return null;
  }
  return value as Zotero.Item;
}

async function selectItemInMainWindow(item: Zotero.Item): Promise<void> {
  const win = Zotero.getMainWindow() as
    | (Window & {
        ZoteroPane?: {
          selectItem?: (id: number) => Promise<unknown> | unknown;
        };
        Zotero_Tabs?: { select: (id: string) => void };
      })
    | undefined;
  if (!win) {
    return;
  }
  win.focus();
  try {
    win.Zotero_Tabs?.select("zotero-pane");
  } catch {
    // selectItem also requests the library tab.
  }
  await win.ZoteroPane?.selectItem?.(item.id);
}

async function focusSelect(
  uri: Extract<ZoteroUri, { kind: "select" }>,
): Promise<OpenLinkResult> {
  const libraryID = resolveLibraryID(uri);
  const item = asItem(
    libraryID ? Zotero.Items.getByLibraryAndKey(libraryID, uri.key) : null,
  );
  if (!item) {
    return { ok: false, message: getString("workspace-link-not-found") };
  }
  await selectItemInMainWindow(item);
  try {
    const pdf = await findPdf(item);
    if (pdf) {
      await (
        Zotero.Reader as unknown as {
          open: (itemID: number) => Promise<unknown>;
        }
      ).open(pdf.id);
    }
  } catch {
    // Selecting the item is enough if the reader cannot open.
  }
  return { ok: true };
}

async function focusOpenPdf(
  uri: Extract<ZoteroUri, { kind: "open-pdf" }>,
): Promise<OpenLinkResult> {
  const libraryID = resolveLibraryID(uri);
  const attachment = asItem(
    libraryID
      ? Zotero.Items.getByLibraryAndKey(libraryID, uri.attachmentKey)
      : null,
  );
  if (!attachment?.isFileAttachment?.()) {
    const parent = asItem(
      attachment?.parentItemID
        ? Zotero.Items.get(attachment.parentItemID)
        : null,
    );
    if (parent) {
      await selectItemInMainWindow(parent);
      return { ok: false, message: getString("workspace-link-pdf-missing") };
    }
    return { ok: false, message: getString("workspace-link-not-found") };
  }
  const annotation = uri.annotationKey
    ? asItem(
        libraryID
          ? Zotero.Items.getByLibraryAndKey(libraryID, uri.annotationKey)
          : null,
      )
    : null;
  const location = pdfLocationForUri(uri, attachment.id, annotation);
  const readers =
    (Zotero.Reader as unknown as { _readers?: ReaderLike[] })._readers ?? [];
  const existing = selectExistingReader(readers, attachment.id);
  if (existing) {
    const win = Zotero.getMainWindow();
    if (existing.tabID && win) {
      win.focus();
      (
        win as unknown as { Zotero_Tabs?: { select: (id: string) => void } }
      ).Zotero_Tabs?.select(existing.tabID);
    } else {
      existing._window?.focus();
    }
    if (location) {
      await existing.navigate?.(location);
    }
    return { ok: true };
  }
  // Zotero.Reader.open(itemID, location, options) takes the location object
  // directly; wrapping it ({ location }) silently drops the navigation.
  await (
    Zotero.Reader as unknown as {
      open: (
        itemID: number,
        location?: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).open(attachment.id, location ?? undefined);
  return { ok: true };
}

export async function navigateZoteroUri(
  uri: ZoteroUri,
): Promise<OpenLinkResult> {
  try {
    return uri.kind === "select"
      ? await focusSelect(uri)
      : await focusOpenPdf(uri);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openLink(href: string): Promise<OpenLinkResult> {
  const target = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(target)) {
    Zotero.launchURL(target);
    return { ok: true };
  }
  const uri = parseZoteroUri(target);
  if (!uri) {
    return { ok: false, message: getString("workspace-link-invalid") };
  }
  return navigateZoteroUri(uri);
}
