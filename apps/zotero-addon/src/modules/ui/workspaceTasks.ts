import {
  bindTabNavigation,
  createWorkspaceButton,
  openActionMenu,
} from "./workspaceControls";
import type {
  LockedItemContext,
  ResearchTaskRecord,
} from "@confucius/protocol";
import { taskArticles } from "../host/TaskSources";
const NS = "http://www.w3.org/1999/xhtml";

export type TaskOrganization = "articles" | "time";

export interface ArticleTaskGroup {
  id: string;
  article: LockedItemContext;
  tasks: ResearchTaskRecord[];
}

function newestFirst(a: ResearchTaskRecord, b: ResearchTaskRecord): number {
  return (
    b.updatedAt - a.updatedAt ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/** Only creation/submission associates articles; browsing another PDF cannot regroup tasks. */
export function articleTaskGroups(
  tasks: readonly ResearchTaskRecord[],
): ArticleTaskGroup[] {
  const groups = new Map<string, ArticleTaskGroup>();
  for (const task of [...tasks].sort(newestFirst)) {
    for (const item of taskArticles(task)) {
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
  // Article folders keep their place when a conversation receives a new reply.
  return [...groups.values()].sort(
    (a, b) =>
      a.article.title.localeCompare(b.article.title) ||
      a.id.localeCompare(b.id),
  );
}

export function timeTaskGroups(
  tasks: readonly ResearchTaskRecord[],
  now = new Date(),
): { id: string; tasks: ResearchTaskRecord[] }[] {
  const boundary = (days: number) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return date.getTime();
  };
  const periods = [
    ["today", boundary(0)],
    ["yesterday", boundary(1)],
    ["week", boundary(7)],
    ["month", boundary(30)],
    ["older", -Infinity],
  ] as const;
  const sorted = [...tasks].sort(newestFirst);
  return periods.flatMap(([id, start], index) => {
    const end = index ? periods[index - 1][1] : Infinity;
    const members = sorted.filter(
      (task) => task.updatedAt >= start && task.updatedAt < end,
    );
    return members.length ? [{ id, tasks: members }] : [];
  });
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
    newForArticle?: (article: LockedItemContext) => void | Promise<void>;
    organization?: string;
    onOrganizationChange?: (mode: TaskOrganization) => void;
  },
): (tasks: ResearchTaskRecord[], active: string | null) => void {
  const tabs = doc.createElementNS(NS, "div") as HTMLElement;
  tabs.className = "confucius-task-organization";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", options.text("workspace-task-organization"));
  let organization: TaskOrganization =
    options.organization === "time" ? "time" : "articles";
  const scrollPositions = { articles: 0, time: 0 };
  for (const mode of ["articles", "time"] as const) {
    const tab = createWorkspaceButton(
      doc,
      `confucius-tasks-${mode}`,
      options.text(`workspace-tasks-by-${mode}`),
    );
    tab.dataset.organization = mode;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "confucius-task-sections");
    tab.addEventListener("click", () => {
      if (organization === mode) return;
      scrollPositions[organization] = pane.scrollTop;
      organization = mode;
      doc.getElementById("confucius-task-action-menu")?.remove();
      options.onOrganizationChange?.(mode);
      render(true);
      pane.scrollTop = scrollPositions[mode];
    });
    tabs.append(tab);
  }
  bindTabNavigation(tabs);
  const search = doc.createElementNS(NS, "input") as HTMLInputElement;
  search.type = "search";
  search.className = "confucius-task-search";
  search.placeholder = options.text("workspace-task-search");
  search.setAttribute("aria-label", search.placeholder);
  const list = doc.createElementNS(NS, "div") as HTMLElement;
  list.id = "confucius-task-sections";
  list.className = "confucius-task-sections";
  list.setAttribute("role", "tabpanel");
  const navigation = doc.createElementNS(NS, "div") as HTMLElement;
  navigation.className = "confucius-task-navigation";
  navigation.append(tabs, search);
  pane.append(navigation, list);
  let tasks: ResearchTaskRecord[] = [],
    active: string | null = null,
    signature = "";
  let pointerWithin = false;
  let initializedExpansion = false;
  const collapsedSearchArticles = new Set<string>();
  const rows = new Map<
    string,
    {
      row: HTMLElement;
      open: HTMLButtonElement;
      title: HTMLElement;
      meta: HTMLElement;
    }
  >();
  const expandedArticles = new Set<string>(["unfiled"]);
  const groups = new Map<
    string,
    {
      node: HTMLElement;
      heading: HTMLElement;
      body: HTMLElement;
      title: HTMLElement;
      count?: HTMLElement;
      article?: LockedItemContext;
    }
  >();
  const empty = doc.createElementNS(NS, "p") as HTMLElement;
  empty.className = "confucius-task-empty";
  empty.textContent = options.text("workspace-no-tasks");

  function taskRow(task: ResearchTaskRecord, group: string): HTMLElement {
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
    entry.row.dataset.active = String(task.id === active);
    entry.row.dataset.taskStatus = task.status;
    entry.open.setAttribute("aria-current", String(task.id === active));
    const title = task.title || task.id;
    if (entry.title.textContent !== title) entry.title.textContent = title;
    const meta = `${options.status(task)} · ${new Date(task.updatedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    if (entry.meta.textContent !== meta) entry.meta.textContent = meta;
    entry.open.title = `${title}\n${meta}`;
    entry.open.setAttribute("aria-label", `${title} · ${meta}`);
    return entry.row;
  }

  // Background updates must not move a different target under a pointer or keyboard focus.
  function reconcile(
    parent: HTMLElement,
    desired: HTMLElement[],
    preserveOrder: boolean,
  ) {
    const retained = new Set(desired);
    const children = preserveOrder
      ? [
          ...(Array.from(parent.children).filter((node) =>
            retained.has(node as HTMLElement),
          ) as HTMLElement[]),
          ...desired.filter((node) => node.parentNode !== parent),
        ]
      : desired;
    for (const child of Array.from(parent.children))
      if (!retained.has(child as HTMLElement)) child.remove();
    let cursor = parent.firstChild;
    for (const child of children) {
      if (child !== cursor) parent.insertBefore(child, cursor);
      cursor = child.nextSibling;
    }
  }

  function groupNode(
    id: string,
    title: string,
    members: ResearchTaskRecord[],
    preserveOrder: boolean,
    article?: LockedItemContext,
  ): HTMLElement {
    const key = `${organization}/${id}`;
    let group = groups.get(key);
    if (!group) {
      const node = doc.createElementNS(NS, "section") as HTMLElement;
      node.className = "confucius-task-group";
      node.dataset.groupId = id;
      const body = doc.createElementNS(NS, "div") as HTMLElement;
      body.className = "confucius-task-group-body";
      const heading = doc.createElementNS(
        NS,
        organization === "articles" ? "button" : "h3",
      ) as HTMLElement;
      const label = doc.createElementNS(NS, "span") as HTMLElement;
      heading.append(label);
      if (organization === "articles") {
        node.dataset.articleId = id;
        const row = doc.createElementNS(NS, "div") as HTMLElement;
        row.className = "confucius-article-row";
        heading.setAttribute("type", "button");
        heading.className = "confucius-article-toggle";
        heading.addEventListener("click", () => {
          if (search.value.trim()) {
            if (collapsedSearchArticles.has(id))
              collapsedSearchArticles.delete(id);
            else collapsedSearchArticles.add(id);
          } else if (expandedArticles.has(id)) expandedArticles.delete(id);
          else expandedArticles.add(id);
          render(true);
        });
        const count = doc.createElementNS(NS, "small") as HTMLElement;
        heading.append(count);
        row.append(heading);
        if (article && options.newForArticle) {
          const create = createWorkspaceButton(doc, "", "+");
          create.classList.add("confucius-article-new");
          create.title = options.text("workspace-article-new-chat");
          create.setAttribute("aria-label", create.title);
          create.addEventListener("click", (event) => {
            const current = groups.get(key)?.article;
            if (!current || create.disabled || (event as MouseEvent).detail > 1)
              return;
            create.disabled = true;
            // Register the navigation intent in this click, before a later
            // click can select another conversation.
            void Promise.resolve(options.newForArticle?.(current)).finally(
              () => {
                create.disabled = false;
              },
            );
          });
          row.append(create);
        }
        node.append(row, body);
        group = { node, heading, title: label, body, count };
      } else {
        heading.className = "confucius-task-period";
        node.append(heading, body);
        group = { node, heading, title: label, body };
      }
      groups.set(key, group);
    }
    group.article = article;
    if (group.title.textContent !== title) group.title.textContent = title;
    group.heading.title = title;
    if (group.count) group.count.textContent = String(members.length);
    if (organization === "articles") {
      const expanded = search.value.trim()
        ? !collapsedSearchArticles.has(id)
        : expandedArticles.has(id);
      group.heading.setAttribute("aria-expanded", String(expanded));
      group.body.hidden = !expanded;
    }
    reconcile(
      group.body,
      members.map((task) => taskRow(task, key)),
      preserveOrder,
    );
    return group.node;
  }

  function render(explicit = false) {
    const focused = list.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement)
      : null;
    const preserveOrder =
      !explicit &&
      (pointerWithin ||
        pane.contains(doc.activeElement) ||
        Boolean(doc.getElementById("confucius-task-action-menu")));
    pane.dataset.organization = organization;
    list.setAttribute("aria-labelledby", `confucius-tasks-${organization}`);
    for (const tab of Array.from(tabs.children) as HTMLElement[]) {
      const selected = tab.dataset.organization === organization;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = tasks.filter((task) =>
      `${task.title} ${task.id} ${taskArticles(task)
        .map((item) => item.title)
        .join(" ")}`
        .toLocaleLowerCase()
        .includes(query),
    );
    const children: HTMLElement[] = [];
    if (organization === "articles") {
      for (const group of articleTaskGroups(filtered)) {
        children.push(
          groupNode(
            group.id,
            group.article.title || options.text("workspace-mention-untitled"),
            group.tasks,
            preserveOrder,
            group.article,
          ),
        );
      }
      const unfiled = filtered
        .filter((task) => !taskArticles(task).length)
        .sort(newestFirst);
      if (unfiled.length)
        children.push(
          groupNode(
            "unfiled",
            options.text("workspace-tasks-unfiled"),
            unfiled,
            preserveOrder,
          ),
        );
    } else {
      const dated = timeTaskGroups(filtered);
      // A reply can move Yesterday to Today. Defer that move too while a
      // pointer/key targets the old row, not just its order inside one bucket.
      const previous = new Map<string, string>();
      if (preserveOrder)
        for (const group of Array.from(list.children) as HTMLElement[]) {
          for (const row of Array.from(
            group.querySelectorAll(".confucius-task-row"),
          ) as HTMLElement[])
            previous.set(row.dataset.taskId!, group.dataset.groupId!);
        }
      const periods = new Map<string, ResearchTaskRecord[]>();
      for (const group of dated)
        for (const task of group.tasks) {
          const id = previous.get(task.id) ?? group.id;
          const members = periods.get(id) ?? [];
          members.push(task);
          periods.set(id, members);
        }
      for (const [id, members] of periods)
        children.push(
          groupNode(
            id,
            options.text(`workspace-tasks-time-${id}`),
            members,
            preserveOrder,
          ),
        );
    }
    if (!filtered.length) children.push(empty);
    reconcile(list, children, preserveOrder);
    const ids = new Set(tasks.map((task) => task.id));
    for (const [key, entry] of rows)
      if (!ids.has(entry.row.dataset.taskId!)) {
        entry.row.remove();
        rows.delete(key);
      }
    const articleIds = new Set(
      articleTaskGroups(tasks).map((group) => group.id),
    );
    for (const key of groups.keys())
      if (
        key.startsWith("articles/") &&
        key !== "articles/unfiled" &&
        !articleIds.has(key.slice(9))
      )
        groups.delete(key);
    if (focused && list.contains(focused) && doc.activeElement !== focused)
      focused.focus({ preventScroll: true });
    if (focused && !focused.isConnected) search.focus({ preventScroll: true });
  }
  search.addEventListener("input", () => {
    collapsedSearchArticles.clear();
    render(true);
  });
  pane.addEventListener("pointerenter", () => {
    pointerWithin = true;
  });
  pane.addEventListener("pointerleave", () => {
    pointerWithin = false;
    render();
  });
  pane.addEventListener("focusout", () =>
    queueMicrotask(() => {
      if (pane.isConnected && !pane.contains(doc.activeElement)) render();
    }),
  );
  pane.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (event.defaultPrevented || key.isComposing) return;
    const items = (
      Array.from(
        list.querySelectorAll(
          ".confucius-task-open, .confucius-article-toggle",
        ),
      ) as HTMLButtonElement[]
    ).filter((item) => item.getClientRects().length);
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
        taskArticles(task),
      ]),
      selected,
      new Date().toDateString(),
    ]);
    tasks = updated;
    active = selected;
    if (!initializedExpansion && tasks.length) {
      initializedExpansion = true;
      const selectedGroup = articleTaskGroups(tasks).find((group) =>
        group.tasks.some((task) => task.id === active),
      );
      if (selectedGroup) expandedArticles.add(selectedGroup.id);
    }
    if (next !== signature) {
      signature = next;
      render();
    }
  };
}
