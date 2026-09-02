import { parseZoteroUri, type ZoteroUri } from "@confucius/protocol";
import { getString } from "../../utils/locale";

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

/** Pick an already-open reader for the attachment, if any. */
export function selectExistingReader(
  readers: ReaderLike[],
  itemID: number,
): ReaderLike | null {
  return readers.find((reader) => reader.itemID === itemID) ?? null;
}

function resolveLibraryID(uri: ZoteroUri): number | null {
  if (uri.groupID) {
    return Zotero.Groups.getLibraryIDFromGroupID(uri.groupID) || null;
  }
  return Zotero.Libraries.userLibraryID;
}

function selectItemInMainWindow(item: Zotero.Item): void {
  const win = Zotero.getMainWindow();
  win?.focus();
  Zotero.getActiveZoteroPane?.()?.selectItem?.(item.id);
}

async function focusSelect(
  uri: Extract<ZoteroUri, { kind: "select" }>,
): Promise<OpenLinkResult> {
  const libraryID = resolveLibraryID(uri);
  const found = libraryID
    ? Zotero.Items.getByLibraryAndKey(libraryID, uri.key)
    : null;
  const item = found || null;
  if (!item) {
    return { ok: false, message: getString("workspace-link-not-found") };
  }
  selectItemInMainWindow(item);
  return { ok: true };
}

async function focusOpenPdf(
  uri: Extract<ZoteroUri, { kind: "open-pdf" }>,
): Promise<OpenLinkResult> {
  const libraryID = resolveLibraryID(uri);
  const foundAttachment = libraryID
    ? Zotero.Items.getByLibraryAndKey(libraryID, uri.attachmentKey)
    : null;
  const attachment = foundAttachment || null;
  if (!attachment?.isFileAttachment?.()) {
    const foundParent = attachment?.parentItemID
      ? Zotero.Items.get(attachment.parentItemID)
      : null;
    const parent = foundParent || null;
    if (parent) {
      selectItemInMainWindow(parent);
      return { ok: false, message: getString("workspace-link-pdf-missing") };
    }
    return { ok: false, message: getString("workspace-link-not-found") };
  }
  const location: Record<string, unknown> | null = uri.annotationKey
    ? { annotationID: uri.annotationKey }
    : uri.page
      ? { pageIndex: uri.page - 1 }
      : null;
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
