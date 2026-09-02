import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { openWorkspace } from "./workspaceWindow";

/**
 * Library-pane entry points on #zotero-itemmenu: "deep-read this item" for a
 * single PDF-backed selection and "triage selection" for a multi-selection.
 * Both queue a skill launch on the host and open the workspace; the workspace
 * poll consumes the queue and prefills the composer with the /slug.
 */

const DEEP_READ_ID = `${config.addonRef}-item-deep-read`;
const TRIAGE_ID = `${config.addonRef}-item-triage`;

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

/** Sync mirror of findPdf: enough for menu visibility on loaded items. */
function hasPdf(item: Zotero.Item): boolean {
  if (item.isAttachment?.()) {
    return item.attachmentContentType === "application/pdf";
  }
  if (item.isNote?.()) {
    return false;
  }
  const ids = item.getAttachments?.() || [];
  return ids.some((id) => {
    const attachment = Zotero.Items.get(id) as Zotero.Item | false;
    return (
      !!attachment &&
      !Array.isArray(attachment) &&
      attachment.attachmentContentType === "application/pdf"
    );
  });
}

function queueLaunch(skillSlug: string): void {
  const instance = (
    Zotero as unknown as Record<
      string,
      | { hooks?: { host?: { queueLaunch?: (slug: string) => void } } }
      | undefined
    >
  )[config.addonInstance];
  instance?.hooks?.host?.queueLaunch?.(skillSlug);
}

function launchWithSkill(skillSlug: string): void {
  queueLaunch(skillSlug);
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
  const deepRead = doc.getElementById(DEEP_READ_ID) as HTMLElement | null;
  const triage = doc.getElementById(TRIAGE_ID) as HTMLElement | null;
  if (deepRead) {
    deepRead.hidden = !(items.length === 1 && hasPdf(items[0]));
  }
  if (triage) {
    triage.hidden = items.length < 2;
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
    if (doc.getElementById(DEEP_READ_ID) && doc.getElementById(TRIAGE_ID)) {
      return;
    }
    const deepRead = createMenuItem(
      doc,
      DEEP_READ_ID,
      getString("itemmenu-deep-read"),
      () => launchWithSkill("paper-deep-reading"),
    );
    const triage = createMenuItem(
      doc,
      TRIAGE_ID,
      getString("itemmenu-triage"),
      () => launchWithSkill("library-triage"),
    );
    if (deepRead && triage) {
      menu.appendChild(deepRead);
      menu.appendChild(triage);
      menu.addEventListener("popupshowing", () => onItemMenuShowing(main, doc));
    }
  } catch (error) {
    ztoolkit.log("[Confucius] item menu registration failed", error);
  }
}

export function unregisterItemMenu(win?: Window): void {
  const main = win ?? Zotero.getMainWindow();
  const doc = main.document;
  for (const id of [DEEP_READ_ID, TRIAGE_ID]) {
    doc.getElementById(id)?.remove();
  }
}
