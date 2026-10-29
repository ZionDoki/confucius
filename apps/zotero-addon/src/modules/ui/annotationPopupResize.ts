const NS = "http://www.w3.org/1999/xhtml";
export const POPUP_CORNERS = ["nw", "ne", "sw", "se"] as const;
export type PopupCorner = (typeof POPUP_CORNERS)[number];
export type PopupSize = { width: number; height: number };
type Rect = PopupSize & { left: number; top: number };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

/** Resize one corner while the opposite corner stays anchored inside the pane. */
function resizedRect(
  start: Rect,
  bounds: Rect,
  corner: PopupCorner,
  dx: number,
  dy: number,
  minHeight: number,
): Rect {
  const west = corner.includes("w"),
    north = corner.includes("n");
  const right = start.left + start.width,
    bottom = start.top + start.height;
  const maxWidth = west
    ? right - bounds.left
    : bounds.left + bounds.width - start.left;
  const maxHeight = north
    ? bottom - bounds.top
    : bounds.top + bounds.height - start.top;
  const width = clamp(
    start.width + (west ? -dx : dx),
    Math.min(260, maxWidth),
    maxWidth,
  );
  const height = clamp(
    start.height + (north ? -dy : dy),
    Math.min(minHeight, maxHeight),
    maxHeight,
  );
  return {
    left: west ? right - width : start.left,
    top: north ? bottom - height : start.top,
    width,
    height,
  };
}

/** Own only handles and CSS properties, leaving Zotero's positioning and editor intact. */
export function attachAnnotationPopupResize(
  popup: HTMLElement,
  options: {
    size?: PopupSize;
    label(corner: PopupCorner): string;
    onSize(size: PopupSize | undefined): void;
    schedule(): void;
  },
) {
  const doc = popup.ownerDocument!,
    win = doc.defaultView!;
  let preferred = options.size;
  let shift = { x: 0, y: 0 };
  let annotationID: string | undefined;
  let drag:
    | {
        handle: HTMLElement;
        id: number;
        start: Rect;
        x: number;
        y: number;
        corner: PopupCorner;
        previous?: PopupSize;
        shift: typeof shift;
      }
    | undefined;
  const set = (key: string, value: string) => {
    if (popup.style.getPropertyValue(key) !== value)
      popup.style.setProperty(key, value);
  };
  const bounds = (): Rect => {
    const parent = popup.parentElement?.getBoundingClientRect();
    const left = Math.max(0, parent?.left ?? 0) + 8;
    const top = Math.max(0, parent?.top ?? 0) + 8;
    return {
      left,
      top,
      width: Math.max(
        1,
        Math.min(win.innerWidth, parent?.right ?? win.innerWidth) - 8 - left,
      ),
      height: Math.max(
        1,
        Math.min(win.innerHeight, parent?.bottom ?? win.innerHeight) - 8 - top,
      ),
    };
  };
  const minHeight = () => {
    const height = (selector: string) =>
      popup.querySelector(selector)?.getBoundingClientRect().height ?? 0;
    return Math.max(
      180,
      height(".preview > header") + height(".preview > .tags") + 80,
    );
  };
  const translate = (x: number, y: number) => {
    shift = { x, y };
    set("--confucius-popup-x", `${x}px`);
    set("--confucius-popup-y", `${y}px`);
  };
  const dimensions = (area: Rect) => {
    set(
      "--confucius-annotation-width",
      `${Math.min(preferred?.width ?? 420, area.width)}px`,
    );
    set(
      "--confucius-annotation-max-height",
      `${preferred ? area.height : Math.min(520, area.height)}px`,
    );
    if (preferred) {
      popup.setAttribute("data-confucius-resized", "true");
      set(
        "--confucius-annotation-height",
        `${Math.min(Math.max(preferred.height, minHeight()), area.height)}px`,
      );
    } else {
      popup.removeAttribute("data-confucius-resized");
      popup.style.removeProperty("--confucius-annotation-height");
    }
  };
  const place = (rect: Rect) => {
    preferred = { width: rect.width, height: rect.height };
    dimensions(bounds());
    const current = popup.getBoundingClientRect();
    translate(
      shift.x + rect.left - current.left,
      shift.y + rect.top - current.top,
    );
    options.onSize(preferred);
  };
  const finish = (cancel = false) => {
    if (!drag) return;
    const active = drag;
    drag = undefined;
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", end, true);
    doc.removeEventListener("pointercancel", cancelDrag, true);
    win.removeEventListener("blur", loseFocus);
    popup.removeAttribute("data-confucius-resizing");
    if (active.handle.hasPointerCapture(active.id))
      active.handle.releasePointerCapture(active.id);
    if (cancel) {
      preferred = active.previous;
      translate(active.shift.x, active.shift.y);
      options.onSize(preferred);
    }
    options.schedule();
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!popup.isConnected) {
      finish();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    place(
      resizedRect(
        drag.start,
        bounds(),
        drag.corner,
        event.clientX - drag.x,
        event.clientY - drag.y,
        minHeight(),
      ),
    );
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== drag?.id) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };
  const cancelDrag = (event: PointerEvent) => {
    if (event.pointerId === drag?.id) finish(true);
  };
  const loseFocus = () => finish();
  const handles = POPUP_CORNERS.map((corner) => {
    // Native reader keyboard handling exempts inputs from annotation deletion.
    // A button input keeps Delete/Backspace harmless even for empty comments.
    const handle = doc.createElementNS(NS, "input") as HTMLInputElement;
    handle.type = "button";
    handle.value = "";
    handle.tabIndex = 0;
    handle.className = "confucius-annotation-resize";
    handle.dataset.corner = corner;
    handle.setAttribute("data-tabstop", "1");
    handle.setAttribute("aria-label", options.label(corner));
    handle.title = options.label(corner);
    handle.addEventListener("pointerdown", (rawEvent) => {
      const event = rawEvent as PointerEvent;
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        handle,
        id: event.pointerId,
        start: popup.getBoundingClientRect(),
        x: event.clientX,
        y: event.clientY,
        corner,
        previous: preferred,
        shift: { ...shift },
      };
      popup.setAttribute("data-confucius-resizing", "true");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* Detached or synthetic pointer; document listeners still clean up. */
      }
      doc.addEventListener("pointermove", move, true);
      doc.addEventListener("pointerup", end, true);
      doc.addEventListener("pointercancel", cancelDrag, true);
      win.addEventListener("blur", loseFocus);
    });
    for (const type of ["mousedown", "click", "contextmenu", "dragstart"])
      handle.addEventListener(type, (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    const reset = () => {
      finish();
      preferred = undefined;
      translate(0, 0);
      options.onSize(undefined);
      options.schedule();
    };
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      reset();
    });
    handle.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.isComposing) return;
      event.stopPropagation();
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 24 : 8;
        place(
          resizedRect(
            popup.getBoundingClientRect(),
            bounds(),
            corner,
            event.key === "ArrowLeft"
              ? -step
              : event.key === "ArrowRight"
                ? step
                : 0,
            event.key === "ArrowUp"
              ? -step
              : event.key === "ArrowDown"
                ? step
                : 0,
            minHeight(),
          ),
        );
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        reset();
      }
    });
    popup.appendChild(handle);
    return handle;
  });
  return {
    refresh() {
      const id = popup.querySelector(".editor .content[id]")?.id;
      if (annotationID !== undefined && annotationID !== id) {
        finish();
        translate(0, 0);
      }
      annotationID = id;
      for (const handle of handles)
        if (handle.parentElement !== popup) popup.appendChild(handle);
      const area = bounds();
      dimensions(area);
      const rect = popup.getBoundingClientRect();
      translate(
        shift.x +
          clamp(rect.left, area.left, area.left + area.width - rect.width) -
          rect.left,
        shift.y +
          clamp(rect.top, area.top, area.top + area.height - rect.height) -
          rect.top,
      );
    },
    dispose() {
      finish();
      for (const handle of handles) handle.remove();
      for (const name of ["data-confucius-resized", "data-confucius-resizing"])
        popup.removeAttribute(name);
      for (const name of [
        "--confucius-annotation-width",
        "--confucius-annotation-height",
        "--confucius-annotation-max-height",
        "--confucius-popup-x",
        "--confucius-popup-y",
      ])
        popup.style.removeProperty(name);
    },
  };
}
