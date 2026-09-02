/** Parse/build standard zotero:// URIs. Pure; no Zotero dependency. */

export type ZoteroSelectUri = {
  kind: "select";
  libraryID?: number;
  groupID?: number;
  key: string;
};

export type ZoteroOpenPdfUri = {
  kind: "open-pdf";
  libraryID?: number;
  groupID?: number;
  attachmentKey: string;
  annotationKey?: string;
  page?: number;
};

export type ZoteroUri = ZoteroSelectUri | ZoteroOpenPdfUri;

const SCHEME = /^zotero:\/\/(select|open-pdf|open)\/(.+)$/i;

function parsePage(raw: string | null): number | undefined {
  const value = Number(raw ?? "");
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseZoteroUri(href: string): ZoteroUri | null {
  const match = String(href || "").trim().match(SCHEME);
  if (!match) {
    return null;
  }
  const isSelect = match[1].toLowerCase() === "select";
  const [path, query = ""] = match[2].split("?");
  const segments = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  const page = parsePage(params.get("page"));
  const annotationKey = params.get("annotation") || undefined;

  if (segments[0] === "library" && segments[1] === "items" && segments[2]) {
    const key = safeDecode(segments[2]);
    if (isSelect) {
      return { kind: "select", key };
    }
    const uri: ZoteroOpenPdfUri = { kind: "open-pdf", attachmentKey: key };
    if (annotationKey) {
      uri.annotationKey = annotationKey;
    }
    if (page) {
      uri.page = page;
    }
    return uri;
  }
  if (segments[0] === "groups" && segments[2] === "items" && segments[3]) {
    const groupID = Number(segments[1]);
    if (!Number.isInteger(groupID) || groupID <= 0) {
      return null;
    }
    const key = safeDecode(segments[3]);
    if (isSelect) {
      return { kind: "select", groupID, key };
    }
    const uri: ZoteroOpenPdfUri = {
      kind: "open-pdf",
      groupID,
      attachmentKey: key,
    };
    if (annotationKey) {
      uri.annotationKey = annotationKey;
    }
    if (page) {
      uri.page = page;
    }
    return uri;
  }
  if (!isSelect && segments.length === 2) {
    const zotfile = segments[0].match(/^(\d+)_([A-Za-z0-9]+)$/);
    if (zotfile) {
      const libraryID = Number(zotfile[1]);
      const pathPage = parsePage(segments[1] ?? null);
      const uri: ZoteroOpenPdfUri = {
        kind: "open-pdf",
        attachmentKey: zotfile[2],
      };
      if (libraryID > 0) {
        uri.libraryID = libraryID;
      }
      if (page ?? pathPage) {
        uri.page = page ?? pathPage;
      }
      return uri;
    }
  }
  return null;
}

export function buildSelectUri(key: string, groupID?: number): string {
  const scope = groupID ? `groups/${groupID}` : "library";
  return `zotero://select/${scope}/items/${encodeURIComponent(key)}`;
}

export function buildOpenPdfUri(
  attachmentKey: string,
  options: { groupID?: number; annotationKey?: string; page?: number } = {},
): string {
  const scope = options.groupID ? `groups/${options.groupID}` : "library";
  const params = new URLSearchParams();
  if (options.annotationKey) {
    params.set("annotation", options.annotationKey);
  } else if (options.page) {
    params.set("page", String(options.page));
  }
  const query = params.toString();
  const base = `zotero://open-pdf/${scope}/items/${encodeURIComponent(attachmentKey)}`;
  return query ? `${base}?${query}` : base;
}
