import { createWorkspaceButton, openActionMenu } from "./workspaceControls";
import type { ResearchTaskRecord } from "@confucius/protocol";
const NS = "http://www.w3.org/1999/xhtml";
export function createTaskList(
  doc: Document,
  pane: HTMLElement,
  options: {
    text: (key: string) => string;
    status: (task: ResearchTaskRecord) => string;
    open: (id: string) => void;
    remove: (id: string) => void;
  },
): (tasks: ResearchTaskRecord[], active: string | null) => void {
  const search = doc.createElementNS(NS, "input") as HTMLInputElement;
  search.type = "search";
  search.className = "confucius-task-search";
  search.placeholder = options.text("workspace-task-search");
  search.setAttribute("aria-label", search.placeholder);
  const list = doc.createElementNS(NS, "div") as HTMLElement;
  pane.append(search, list);
  let tasks: ResearchTaskRecord[] = [],
    active: string | null = null,
    signature = "";
  const rows = new Map<
    string,
    {
      row: HTMLElement;
      open: HTMLButtonElement;
      title: HTMLElement;
      meta: HTMLElement;
    }
  >();
  const headings = new Map<string, HTMLElement>();
  const empty = doc.createElementNS(NS, "p") as HTMLElement;
  empty.className = "confucius-task-empty";
  empty.textContent = options.text("workspace-no-tasks");
  function taskRow(task: ResearchTaskRecord): HTMLElement {
    let entry = rows.get(task.id);
    if (!entry) {
      const row = doc.createElementNS(NS, "div") as HTMLElement;
      row.className = "confucius-task-row";
      row.dataset.taskId = task.id;
      const open = doc.createElementNS(NS, "button") as HTMLButtonElement;
      open.type = "button";
      open.className = "confucius-task-open";
      const title = doc.createElementNS(NS, "span") as HTMLElement;
      const meta = doc.createElementNS(NS, "small") as HTMLElement;
      open.append(title, meta);
      open.addEventListener("click", () => options.open(task.id));
      const trigger = createWorkspaceButton(doc, "", "···");
      trigger.classList.add("confucius-task-menu-trigger");
      trigger.setAttribute(
        "aria-label",
        options.text("workspace-task-actions"),
      );
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.addEventListener("click", () =>
        openActionMenu(trigger, [
          {
            label: options.text("workspace-delete-task"),
            danger: true,
            run: () => options.remove(task.id),
          },
        ]),
      );
      row.append(open, trigger);
      entry = { row, open, title, meta };
      rows.set(task.id, entry);
    }
    entry.row.setAttribute("data-active", String(task.id === active));
    entry.row.setAttribute("data-task-status", task.status);
    entry.open.setAttribute("aria-current", String(task.id === active));
    const title = task.title || task.id;
    if (entry.title.textContent !== title) entry.title.textContent = title;
    const meta = `${options.status(task)} · ${new Date(task.updatedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    if (entry.meta.textContent !== meta) entry.meta.textContent = meta;
    return entry.row;
  }
  function render() {
    const focused = list.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement)
      : null;
    const filtered = tasks.filter((task) =>
      `${task.title} ${task.id}`
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
    );
    const running = (task: ResearchTaskRecord) =>
      task.status === "running" || task.status === "awaiting_approval";
    const children: HTMLElement[] = [];
    for (const [key, subset] of [
      ["workspace-tasks-running", filtered.filter(running)],
      ["workspace-tasks-recent", filtered.filter((task) => !running(task))],
    ] as const) {
      if (!subset.length) continue;
      let heading = headings.get(key);
      if (!heading) {
        heading = doc.createElementNS(NS, "h3") as HTMLElement;
        heading.textContent = options.text(key);
        headings.set(key, heading);
      }
      children.push(heading, ...subset.map(taskRow));
    }
    if (!filtered.length) children.push(empty);
    // Move existing rows only when order changes; streaming metadata updates
    // leave focused buttons and expanded action menus mounted.
    let cursor: Node | null = list.firstChild;
    for (const child of children) {
      if (child !== cursor) list.insertBefore(child, cursor);
      cursor = child.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      list.removeChild(cursor);
      cursor = next;
    }
    for (const id of rows.keys())
      if (!tasks.some((task) => task.id === id)) rows.delete(id);
    if (focused && list.contains(focused) && doc.activeElement !== focused)
      focused.focus({ preventScroll: true });
    if (focused && !focused.isConnected) search.focus({ preventScroll: true });
  }
  search.addEventListener("input", render);
  pane.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (event.defaultPrevented || key.isComposing) return;
    const items = Array.from(
      list.querySelectorAll(".confucius-task-open"),
    ) as HTMLButtonElement[];
    if (!items.length) return;
    const current = items.indexOf(doc.activeElement as HTMLButtonElement);
    if (key.key === "ArrowDown" && doc.activeElement === search) {
      event.preventDefault();
      items[0].focus();
    } else if (
      current >= 0 &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(key.key)
    ) {
      event.preventDefault();
      const next =
        key.key === "Home"
          ? 0
          : key.key === "End"
            ? items.length - 1
            : (current + (key.key === "ArrowUp" ? -1 : 1) + items.length) %
              items.length;
      items[next].focus({ preventScroll: true });
      items[next].scrollIntoView({ block: "nearest" });
    } else if (key.key === "Escape" && list.contains(doc.activeElement)) {
      event.preventDefault();
      search.focus({ preventScroll: true });
    }
  });
  return (updated, selected) => {
    const next = JSON.stringify([
      updated.map((task) => [task.id, task.title, task.status, task.updatedAt]),
      selected,
    ]);
    tasks = updated;
    active = selected;
    if (next !== signature) {
      signature = next;
      render();
    }
  };
}
