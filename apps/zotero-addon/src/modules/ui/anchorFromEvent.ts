/**
 * Resolve an <a href> from a click/mousedown event.
 *
 * Workspace documents are XHTML. Firefox often dispatches those events to the
 * Text node inside the anchor, and Text nodes have no `closest()`. Duck-type
 * the parent chain instead of `instanceof` — plugin code and the window DOM
 * live in different compartments, so instanceof Element is unreliably false.
 */
export function hrefFromEvent(event: {
  target?: unknown;
  composedPath?: () => unknown[];
}): string {
  const seen = new Set<unknown>();
  const queue: unknown[] = [];
  if (typeof event.composedPath === "function") {
    try {
      queue.push(...event.composedPath());
    } catch {
      // Some synthetic events throw from composedPath().
    }
  }
  queue.push(event.target);
  for (const node of queue) {
    const href = hrefFromNodeOrAncestor(node, seen);
    if (href) {
      return href;
    }
  }
  return "";
}

function hrefFromNodeOrAncestor(start: unknown, seen: Set<unknown>): string {
  let node = start;
  for (
    let depth = 0;
    depth < 24 && node && typeof node === "object";
    depth += 1
  ) {
    if (seen.has(node)) {
      break;
    }
    seen.add(node);
    const href = hrefOfAnchor(node);
    if (href) {
      return href;
    }
    const el = node as {
      closest?: (selector: string) => unknown;
      parentElement?: unknown;
      parentNode?: unknown;
    };
    if (typeof el.closest === "function") {
      try {
        const found = hrefOfAnchor(el.closest("a"));
        if (found) {
          return found;
        }
      } catch {
        // Non-Element nodes throw from closest() in some engines.
      }
    }
    node = el.parentElement ?? el.parentNode ?? null;
  }
  return "";
}

function hrefOfAnchor(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const el = node as {
    localName?: string;
    tagName?: string;
    getAttribute?: (name: string) => string | null;
  };
  const tag = String(el.localName || el.tagName || "").toLowerCase();
  if (tag !== "a" || typeof el.getAttribute !== "function") {
    return "";
  }
  const fromData = String(el.getAttribute("data-href") || "").trim();
  if (fromData) {
    return fromData;
  }
  const fromAttr = String(el.getAttribute("href") || "").trim();
  if (fromAttr && !/^chrome:/i.test(fromAttr)) {
    return fromAttr;
  }
  return "";
}
