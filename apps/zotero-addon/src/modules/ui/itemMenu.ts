import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { openWorkspace } from "./workspaceWindow";
import type { LaunchIntent, TaskTemplateId } from "@confucius/protocol";

/**
 * Library-pane entry points on #zotero-itemmenu: "deep-read this item" for a
 * single PDF-backed selection and "triage selection" for a multi-selection.
 * Both queue a skill launch on the host and open the workspace; the workspace
 * poll consumes the queue and prefills the composer with the /slug.
 */

const DEEP_READ_ID = `${config.addonRef}-item-deep-read`;
const TRIAGE_ID = `${config.addonRef}-item-triage`;

const SINGLE_ENTRIES: ReadonlyArray<{
  id: string;
  templateId: TaskTemplateId;
  labelKey: string;
}> = [
  {
    id: DEEP_READ_ID,
    templateId: "deep-read",
    labelKey: "itemmenu-deep-read",
  },
  {
    id: `${config.addonRef}-item-evidence-audit`,
    templateId: "evidence-audit",
    labelKey: "itemmenu-evidence-audit",
  },
  {
    id: `${config.addonRef}-item-related-work`,
    templateId: "related-work",
    labelKey: "itemmenu-related-work",
  },
  {
    id: `${config.addonRef}-item-paper-note`,
    templateId: "paper-note",
    labelKey: "itemmenu-paper-note",
  },
];

const MULTI_ENTRIES: ReadonlyArray<{
  id: string;
  templateId: TaskTemplateId;
  labelKey: string;
}> = [
  {
    id: `${config.addonRef}-item-compare`,
    templateId: "compare",
    labelKey: "itemmenu-compare",
  },
  {
    id: TRIAGE_ID,
    templateId: "triage",
    labelKey: "itemmenu-triage",
  },
  {
    id: `${config.addonRef}-item-synthesis`,
    templateId: "synthesis",
    labelKey: "itemmenu-synthesis",
  },
  {
    id: `${config.addonRef}-item-literature-map`,
    templateId: "literature-map",
    labelKey: "itemmenu-literature-map",
  },
];

interface ZoteroPaneLike {
  getSelectedItems?: () => unknown[];
}

function paneFor(win: Window): ZoteroPaneLike | undefined {
  return (win as Window & { ZoteroPane?: ZoteroPaneLike }).ZoteroPane;
}

function selectedItems(win: Window): Zotero.Item[] {
  const pane = paneFor(win);
  const items = pane?.getSelectedItems?.() || [];
  return items.filter(
    (item): item is Zotero.Item => !!item && !Array.isArray(item),
  );
}

/** Duck-typed item shape so the PDF probe stays unit-testable without Zotero. */
export interface MenuProbeItem {
  isAttachment?: () => boolean;
  isNote?: () => boolean;
  attachmentContentType?: string | false;
  getAttachments?: () => number[] | false;
}

/**
 * Sync mirror of findPdf: enough for menu visibility on loaded items.
 * `getAttachment` stands in for Zotero.Items.get.
 */
export function hasPdfForMenu(
  item: MenuProbeItem,
  getAttachment: (id: number) => MenuProbeItem | false | undefined,
): boolean {
  if (item.isAttachment?.()) {
    return item.attachmentContentType === "application/pdf";
  }
  if (item.isNote?.()) {
    return false;
  }
  const ids = item.getAttachments?.() || [];
  return ids.some((id) => {
    const attachment = getAttachment(id);
    return (
      !!attachment &&
      !Array.isArray(attachment) &&
      attachment.attachmentContentType === "application/pdf"
    );
  });
}

function hasPdf(item: Zotero.Item): boolean {
  return hasPdfForMenu(
    item,
    (id) => Zotero.Items.get(id) as Zotero.Item | false,
  );
}

function queueLaunch(intent: LaunchIntent): void {
  const instance = (
    Zotero as unknown as Record<
      string,
      | { hooks?: { host?: { queueLaunch?: (value: LaunchIntent) => void } } }
      | undefined
    >
  )[config.addonInstance];
  instance?.hooks?.host?.queueLaunch?.(intent);
}

function launchWithTemplate(templateId: TaskTemplateId): void {
  queueLaunch({ templateId, autoStart: true });
  openWorkspace()?.focus();
}

function createMenuItem(
  doc: Document,
  id: string,
  label: string,
  onCommand: () => void,
): HTMLElement | null {
  const create = (
    doc as Document & {
      createXULElement?: (name: string) => HTMLElement;
    }
  ).createXULElement;
  if (typeof create !== "function") {
    return null;
  }
  const item = create.call(doc, "menuitem");
  item.id = id;
  item.setAttribute("label", label);
  item.addEventListener("command", onCommand);
  return item;
}

function onItemMenuShowing(win: Window, doc: Document): void {
  const items = selectedItems(win);
  const singleVisible = items.length === 1 && hasPdf(items[0]);
  for (const entry of SINGLE_ENTRIES) {
    const node = doc.getElementById(entry.id) as HTMLElement | null;
    if (node) {
      node.setAttribute("label", getString(entry.labelKey));
      node.hidden = !singleVisible;
    }
  }
  for (const entry of MULTI_ENTRIES) {
    const node = doc.getElementById(entry.id) as HTMLElement | null;
    if (node) {
      node.setAttribute("label", getString(entry.labelKey));
      node.hidden = items.length < 2;
    }
  }
}

export function registerItemMenu(win?: Window): void {
  const main = win ?? Zotero.getMainWindow();
  const doc = main.document;
  const menu = doc.getElementById("zotero-itemmenu");
  if (!menu) {
    ztoolkit.log("[Confucius] item context menu not found");
    return;
  }
  try {
    if (
      [...SINGLE_ENTRIES, ...MULTI_ENTRIES].every((entry) =>
        doc.getElementById(entry.id),
      )
    ) {
      return;
    }
    const entries = [...SINGLE_ENTRIES, ...MULTI_ENTRIES];
    const nodes = entries.map((entry) =>
      createMenuItem(doc, entry.id, getString(entry.labelKey), () =>
        launchWithTemplate(entry.templateId),
      ),
    );
    if (nodes.every((node) => node !== null)) {
      for (const node of nodes) menu.appendChild(node as HTMLElement);
      menu.addEventListener("popupshowing", () => onItemMenuShowing(main, doc));
    }
  } catch (error) {
    ztoolkit.log("[Confucius] item menu registration failed", error);
  }
}

export function unregisterItemMenu(win?: Window): void {
  const main = win ?? Zotero.getMainWindow();
  const doc = main.document;
  for (const id of [...SINGLE_ENTRIES, ...MULTI_ENTRIES].map(
    (entry) => entry.id,
  )) {
    doc.getElementById(id)?.remove();
  }
}
