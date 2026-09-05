import { markScrollContainer } from "./workspaceScrollbars";

const NS = "http://www.w3.org/1999/xhtml";

/** Shared surface for composer menus, including those portalled into Zotero. */
export function createMenuSurface(
  doc: Document,
  attributes: Record<string, string>,
  picker = false,
): HTMLElement {
  const menu = doc.createElementNS(NS, "div") as HTMLElement;
  menu.className = "confucius-menu-surface";
  if (picker) menu.classList.add("confucius-menu-picker");
  for (const [name, value] of Object.entries(attributes))
    menu.setAttribute(name, value);
  menu.style.overflowX = "hidden";
  menu.style.overflowY = picker ? "hidden" : "auto";
  markScrollContainer(menu);
  return menu;
}

export function createMenuHeading(doc: Document, text: string): HTMLElement {
  const heading = doc.createElementNS(NS, "div") as HTMLElement;
  heading.className = "confucius-menu-heading";
  heading.textContent = text;
  return heading;
}

export function createMenuHeader(
  doc: Document,
  title: string,
  detail: string,
): HTMLElement {
  const header = doc.createElementNS(NS, "div") as HTMLElement;
  header.className = "confucius-menu-header";
  const heading = doc.createElementNS(NS, "strong");
  heading.textContent = title;
  const meta = doc.createElementNS(NS, "span");
  meta.textContent = detail;
  header.append(heading, meta);
  return header;
}

export function createMenuGlyph(doc: Document, text: string): HTMLElement {
  const glyph = doc.createElementNS(NS, "span") as HTMLElement;
  glyph.className = "confucius-menu-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = text;
  return glyph;
}

export function bindMenuNavigation(
  menu: HTMLElement,
  dismiss: () => void,
): void {
  menu.addEventListener("keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    if (
      event.defaultPrevented ||
      keyboard.isComposing ||
      keyboard.keyCode === 229
    )
      return;
    const key = keyboard.key;
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (menu.getAttribute("role") !== "menu") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
    const items = Array.from(
      menu.querySelectorAll("button:not(:disabled)"),
    ) as HTMLButtonElement[];
    if (!items.length) return;
    event.preventDefault();
    const current = items.findIndex(
      (item) => item === menu.ownerDocument?.activeElement,
    );
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? items.length - 1
          : key === "ArrowDown"
            ? (current + 1) % items.length
            : current < 0
              ? items.length - 1
              : (current + items.length - 1) % items.length;
    items[next].focus({ preventScroll: true });
    items[next].scrollIntoView({ block: "nearest" });
  });
}
