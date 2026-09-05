import { bindMenuNavigation, createMenuSurface } from "./workspaceMenus";

const NS = "http://www.w3.org/1999/xhtml";

/** A stable icon slot previews dismissal without moving the label or caret. */
export function createComposerStatusChip(
  doc: Document,
  id: string,
  kind: "plan" | "preset",
  dismiss: () => void | Promise<void>,
): { node: HTMLButtonElement; label: HTMLElement; resetPreview: () => void } {
  const node = doc.createElementNS(NS, "button") as HTMLButtonElement;
  node.id = id;
  node.type = "button";
  node.className = "confucius-composer-status";
  node.hidden = true;
  node.setAttribute("aria-keyshortcuts", "Delete Backspace");
  const glyph = doc.createElementNS(NS, "span");
  glyph.className = "confucius-composer-status-glyph";
  glyph.setAttribute("aria-hidden", "true");
  for (const [name, path] of [
    [
      "state",
      kind === "plan"
        ? "M8 5h11M8 12h11M8 19h11M3 5h.01M3 12h.01M3 19h.01"
        : "M12 3 21 12 12 21 3 12Z",
    ],
    ["dismiss", "m6 6 12 12M18 6 6 18"],
  ]) {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("data-icon", name);
    const shape = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    svg.appendChild(shape);
    glyph.appendChild(svg);
  }
  const label = doc.createElementNS(NS, "span") as HTMLElement;
  label.className = "confucius-composer-status-label";
  node.append(glyph, label);
  let previewTimer: number | undefined;
  const resetPreview = () => {
    doc.defaultView?.clearTimeout(previewTimer);
    previewTimer = undefined;
    delete node.dataset.dismissPreview;
  };
  const preview = () => {
    resetPreview();
    if (node.disabled || node.hidden) return;
    node.dataset.dismissPreview = "true";
    previewTimer = doc.defaultView?.setTimeout(resetPreview, 1600);
  };
  node.addEventListener("pointerenter", (event) => {
    if ((event as PointerEvent).pointerType !== "touch") preview();
  });
  node.addEventListener("pointerleave", resetPreview);
  node.addEventListener("focus", preview);
  node.addEventListener("blur", resetPreview);
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (node.disabled || node.hidden) return;
    resetPreview();
    void dismiss();
  });
  node.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (
      key.isComposing ||
      key.keyCode === 229 ||
      !["Delete", "Backspace"].includes(key.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    node.click();
  });
  return { node, label, resetPreview };
}

export function createWorkspaceButton(
  doc: Document,
  id: string,
  label: string,
  variant: "primary" | "outline" = "outline",
): HTMLButtonElement {
  const button = doc.createElementNS(NS, "button") as HTMLButtonElement;
  button.type = "button";
  if (id) button.id = id;
  button.className = "confucius-button";
  button.dataset.variant = variant === "primary" ? "primary" : "quiet";
  button.textContent = label;
  return button;
}

/** Keep keyboard navigation inside a dialog without taking focus on updates. */
export function bindDialogNavigation(
  overlay: HTMLElement,
  close: () => void,
): void {
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (event.defaultPrevented || key.isComposing || key.keyCode === 229)
      return;
    if (key.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (key.key !== "Tab") return;
    const items = Array.from(
      overlay.querySelectorAll(
        'button, input, textarea, select, a[href], summary, [tabindex="0"]',
      ),
    ) as HTMLElement[];
    const visible = items.filter(
      (node) =>
        !node.hasAttribute("disabled") &&
        node.tabIndex >= 0 &&
        node.getClientRects().length > 0,
    );
    if (!visible.length) return;
    const current = overlay.ownerDocument?.activeElement;
    const first = visible[0],
      last = visible[visible.length - 1];
    if (
      key.shiftKey &&
      (current === first || !visible.includes(current as HTMLElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !key.shiftKey &&
      (current === last || !visible.includes(current as HTMLElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  });
}

export function bindTabNavigation(tabs: HTMLElement): void {
  tabs.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (event.defaultPrevented || key.isComposing) return;
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(key.key)
    )
      return;
    const items = Array.from(
      tabs.querySelectorAll('[role="tab"]'),
    ) as HTMLElement[];
    const current = items.indexOf(
      tabs.ownerDocument?.activeElement as HTMLElement,
    );
    if (current < 0) return;
    const next =
      key.key === "Home"
        ? 0
        : key.key === "End"
          ? items.length - 1
          : (current +
              (["ArrowLeft", "ArrowUp"].includes(key.key) ? -1 : 1) +
              items.length) %
            items.length;
    event.preventDefault();
    items[next].click();
    items[next].focus({ preventScroll: true });
    items[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

/** A single anchored surface, including in XUL documents without a body. */
export function openActionMenu(
  anchor: HTMLElement,
  actions: Array<{ label: string; danger?: boolean; run: () => void }>,
): void {
  const doc = anchor.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win || !doc.documentElement) return;
  const old = doc.getElementById("confucius-task-action-menu");
  const wasOpen = anchor.getAttribute("aria-expanded") === "true";
  old?.remove();
  if (wasOpen) {
    anchor.setAttribute("aria-expanded", "false");
    return;
  }
  const menu = createMenuSurface(doc, {
    id: "confucius-task-action-menu",
    role: "menu",
    "aria-label": anchor.getAttribute("aria-label") ?? "",
  });
  const close = (restore = true) => {
    menu.remove();
    cleanup();
    if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const outside = (event: Event) => {
    if (
      !menu.contains(event.target as Node) &&
      !anchor.contains(event.target as Node)
    )
      close(false);
  };
  const cleanup = () => {
    anchor.setAttribute("aria-expanded", "false");
    doc.removeEventListener("mousedown", outside, true);
    win.removeEventListener("resize", onResize);
    observer.disconnect();
  };
  const onResize = () => close(false);
  const observer = new win.MutationObserver(() => {
    if (!menu.isConnected || !anchor.isConnected) {
      menu.remove();
      cleanup();
    }
  });
  for (const action of actions) {
    const item = createWorkspaceButton(doc, "", action.label);
    item.className = "confucius-menu-row";
    item.setAttribute("role", "menuitem");
    if (action.danger) item.dataset.danger = "true";
    item.addEventListener("click", () => {
      close();
      action.run();
    });
    menu.appendChild(item);
  }
  menu.style.font = win.getComputedStyle(anchor)?.font ?? "inherit";
  menu.style.width = `${Math.min(220, win.innerWidth - 16)}px`;
  (doc.body ?? doc.documentElement)?.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - box.width, win.innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, win.innerHeight - box.height - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
  bindMenuNavigation(menu, close);
  doc.addEventListener("mousedown", outside, true);
  win.addEventListener("resize", onResize);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  menu.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}
