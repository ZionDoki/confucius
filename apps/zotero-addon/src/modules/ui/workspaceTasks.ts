import { createWorkspaceButton, openActionMenu } from "./workspaceControls";
import type {
  LockedItemContext,
  ResearchTaskRecord,
} from "@confucius/protocol";
import { contextArticles } from "../host/TaskSources";
const NS = "http://www.w3.org/1999/xhtml";

export interface ArticleTaskGroup {
  id: string;
  article: LockedItemContext;
  tasks: ResearchTaskRecord[];
}

/** A conversation can belong to several papers, but appears once per paper. */
export function articleTaskGroups(
  tasks: readonly ResearchTaskRecord[],
): ArticleTaskGroup[] {
  const groups = new Map<string, ArticleTaskGroup>();
  for (const task of [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const sources = [
      ...new Map(
        [
          ...(task.articleSources ?? []),
          ...contextArticles(task.run?.sources ?? task.lockedContext),
          ...contextArticles(task.lockedContext),
        ].map((item) => [`${item.libraryID}:${item.key}`, item]),
      ).values(),
    ];
    for (const item of sources) {
      const id = `${item.libraryID}:${item.key}`;
      let group = groups.get(id);
      if (!group) {
        group = { id, article: { ...item }, tasks: [] };
        groups.set(id, group);
      }
      if (!group.tasks.some((entry) => entry.id === task.id))
        group.tasks.push(task);
    }
  }
  return [...groups.values()];
}

export function createTaskList(
  doc: Document,
  pane: HTMLElement,
  options: {
    text: (key: string) => string;
    status: (task: ResearchTaskRecord) => string;
    open: (id: string) => void;
    remove: (id: string) => void;
    exportTrace: (id: string) => void;
    isExporting?: (id: string) => boolean;
    newForArticle?: (article: LockedItemContext) => void;
  },
): (tasks: ResearchTaskRecord[], active: string | null) => void {
  const search = doc.createElementNS(NS, "input") as HTMLInputElement;
  search.type = "search";
  search.className = "confucius-task-search";
  search.placeholder = options.text("workspace-task-search");
  search.setAttribute("aria-label", search.placeholder);
  const list = doc.createElementNS(NS, "div") as HTMLElement;
  list.className = "confucius-task-sections";
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
  const collapsedSections = new Set<string>();
  const expandedArticles = new Set<string>();
  const folders = new Map<
    string,
    {
      row: HTMLElement;
      toggle: HTMLButtonElement;
      title: HTMLElement;
      count: HTMLElement;
      article: LockedItemContext;
    }
  >();
  const empty = doc.createElementNS(NS, "p") as HTMLElement;
  empty.className = "confucius-task-empty";
  empty.textContent = options.text("workspace-no-tasks");
  function taskRow(task: ResearchTaskRecord, group = "recent"): HTMLElement {
    const rowKey = `${group}/${task.id}`;
    let entry = rows.get(rowKey);
    if (!entry) {
      const row = doc.createElementNS(NS, "div") as HTMLElement;
      row.className = "confucius-task-row";
      row.dataset.taskId = task.id;
      row.dataset.taskGroup = group;
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
            label: options.text(
              options.isExporting?.(task.id)
                ? "workspace-export-trace-running"
                : "workspace-export-trace",
            ),
            disabled: options.isExporting?.(task.id),
            run: () => options.exportTrace(task.id),
          },
          {
            label: options.text("workspace-delete-task"),
            danger: true,
            run: () => options.remove(task.id),
          },
        ]),
      );
      row.append(open, trigger);
      entry = { row, open, title, meta };
      rows.set(rowKey, entry);
    }
    entry.row.setAttribute("data-active", String(task.id === active));
    entry.row.setAttribute("data-task-status", task.status);
    entry.open.setAttribute("aria-current", String(task.id === active));
    const title = task.title || task.id;
    if (entry.title.textContent !== title) entry.title.textContent = title;
    const meta = `${options.status(task)} · ${new Date(task.updatedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    if (entry.meta.textContent !== meta) entry.meta.textContent = meta;
    entry.open.title = `${title}\n${meta}`;
    entry.open.setAttribute("aria-label", `${title} · ${meta}`);
    return entry.row;
  }

  function section(key: string): HTMLElement {
    let heading = headings.get(key);
    if (!heading) {
      heading = doc.createElementNS(NS, "button") as HTMLButtonElement;
      (heading as HTMLButtonElement).type = "button";
      heading.className = "confucius-task-section-toggle";
      heading.addEventListener("click", () => {
        if (collapsedSections.has(key)) collapsedSections.delete(key);
        else collapsedSections.add(key);
        render();
      });
      headings.set(key, heading);
    }
    const open = !collapsedSections.has(key);
    heading.textContent = `${options.text(key)} ${open ? "⌄" : "›"}`;
    heading.setAttribute("aria-expanded", String(open));
    return heading;
  }

  function articleRow(group: ArticleTaskGroup): HTMLElement {
    let folder = folders.get(group.id);
    if (!folder) {
      const row = doc.createElementNS(NS, "div") as HTMLElement;
      row.className = "confucius-article-row";
      const toggle = doc.createElementNS(NS, "button") as HTMLButtonElement;
      toggle.type = "button";
      toggle.className = "confucius-article-toggle";
      const title = doc.createElementNS(NS, "span") as HTMLElement;
      const count = doc.createElementNS(NS, "small") as HTMLElement;
      toggle.append(title, count);
      toggle.addEventListener("click", () => {
        if (expandedArticles.has(group.id)) expandedArticles.delete(group.id);
        else expandedArticles.add(group.id);
        render();
      });
      const create = createWorkspaceButton(doc, "", "+");
      create.classList.add("confucius-article-new");
      create.title = options.text("workspace-article-new-chat");
      create.setAttribute("aria-label", create.title);
      create.hidden = !options.newForArticle;
      create.addEventListener("click", () =>
        options.newForArticle?.(folders.get(group.id)!.article),
      );
      row.append(toggle, create);
      folder = { row, toggle, title, count, article: group.article };
      folders.set(group.id, folder);
    }
    folder.article = group.article;
    folder.row.dataset.articleId = group.id;
    folder.row.dataset.active = String(
      group.tasks.some((task) => task.id === active),
    );
    const expanded =
      expandedArticles.has(group.id) || Boolean(search.value.trim());
    folder.toggle.setAttribute("aria-expanded", String(expanded));
    folder.title.textContent =
      group.article.title || options.text("workspace-mention-untitled");
    folder.toggle.title = folder.title.textContent;
    folder.count.textContent = String(group.tasks.length);
    return folder.row;
  }
  function render() {
    const focused = list.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement)
      : null;
    const filtered = tasks.filter((task) =>
      `${task.title} ${task.id} ${articleTaskGroups([task])
        .map((group) => group.article.title)
        .join(" ")}`
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
    );
    const children: HTMLElement[] = [];
    const groups = articleTaskGroups(filtered);
    children.push(section("workspace-task-articles"));
    if (!collapsedSections.has("workspace-task-articles")) {
      for (const group of groups) {
        children.push(articleRow(group));
        if (expandedArticles.has(group.id) || search.value.trim())
          children.push(...group.tasks.map((task) => taskRow(task, group.id)));
      }
    }
    children.push(section("workspace-tasks-recent"));
    if (!collapsedSections.has("workspace-tasks-recent")) {
      children.push(
        ...[...filtered]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((task) => taskRow(task)),
      );
      if (!filtered.length) children.push(empty);
    }
    // Move existing rows only when order changes; streaming metadata updates
    // leave focused buttons and expanded action menus mounted.
    const retained = new Set(children);
    for (const child of Array.from(list.children))
      if (!retained.has(child as HTMLElement)) child.remove();
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
    for (const [key, entry] of rows)
      if (!tasks.some((task) => task.id === entry.row.dataset.taskId))
        rows.delete(key);
    const articleIds = new Set(
      articleTaskGroups(tasks).map((group) => group.id),
    );
    for (const id of folders.keys())
      if (!articleIds.has(id)) folders.delete(id);
    if (focused && list.contains(focused) && doc.activeElement !== focused)
      focused.focus({ preventScroll: true });
    if (focused && !focused.isConnected) search.focus({ preventScroll: true });
  }
  search.addEventListener("input", render);
  pane.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (event.defaultPrevented || key.isComposing) return;
    const items = Array.from(
      list.querySelectorAll(
        ".confucius-task-open, .confucius-article-toggle, .confucius-task-section-toggle",
      ),
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
      updated.map((task) => [
        task.id,
        task.title,
        task.status,
        task.updatedAt,
        task.lockedContext,
      ]),
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
