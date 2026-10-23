import {
  bindTabNavigation,
  createWorkspaceButton,
  openActionMenu,
} from "./workspaceControls";
import type {
  LockedItemContext,
  ResearchTaskRecord,
} from "@confucius/protocol";
import { taskArticles, taskCategory } from "../host/TaskSources";
const NS = "http://www.w3.org/1999/xhtml";

function taskActionIcon(doc: Document, kind: "more" | "new"): Element {
  const svgNS = "http://www.w3.org/2000/svg";
  const icon = doc.createElementNS(svgNS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "20");
  icon.setAttribute("height", "20");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  if (kind === "more") {
    icon.setAttribute("fill", "currentColor");
    for (const x of [5, 12, 19]) {
      const dot = doc.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", "12");
      dot.setAttribute("r", "1.7");
      icon.append(dot);
    }
  } else {
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    const path = doc.createElementNS(svgNS, "path");
    path.setAttribute("d", "M12 5v14M5 12h14");
    icon.append(path);
  }
  return icon;
}

export type TaskOrganization = "articles" | "time";

/** Confirm text for the irreversible delete action, including the task name. */
export function taskDeleteConfirmation(
  title: string,
  language: string,
): string {
  const name = title || (language === "zh-CN" ? "未命名任务" : "Untitled task");
  return language === "zh-CN"
    ? `删除任务“${name}”？这会永久删除对话历史、运行日志和诊断信息，且无法撤销。`
    : `Delete the task “${name}”? This permanently deletes its conversation history, run logs, and diagnostics. It cannot be undone.`;
}

export type PermissionMode = "ask" | "auto_allow" | "deny";

export interface TaskSelection {
  taskId: string | null;
  generation: number;
}

/** A deferred write or error may only land on the task that captured it. */
export function taskSelectionCurrent(
  captured: TaskSelection,
  current: TaskSelection,
): boolean {
  return (
    captured.taskId === current.taskId &&
    captured.generation === current.generation
  );
}

export interface TaskScopedFailure {
  taskId: string;
  message: string;
}

/** Report a failure only to the task that still owns the visible composer. */
export function taskScopedFailure(
  captured: TaskSelection,
  current: TaskSelection,
  error: unknown,
): TaskScopedFailure | null {
  if (!taskSelectionCurrent(captured, current)) return null;
  return {
    taskId: captured.taskId ?? "",
    message: error instanceof Error ? error.message : String(error),
  };
}

export interface PermissionUpdateOptions {
  send: () => Promise<unknown>;
  /** Whether the task that issued the choice still owns the visible mode. */
  isCurrent: () => boolean;
  rejected: (confirmed: PermissionMode, error: unknown) => void;
}

export interface PermissionUpdates {
  readonly confirmed: PermissionMode;
  /** Adopt the mode loaded from the host for the selected task. */
  reset(mode: PermissionMode): void;
  /**
   * Queue a choice; rejected choices roll back to the last host value. The
   * returned gate rejects when the host write failed so a dependent action
   * (a prompt) can abort; the queue itself never inherits that rejection.
   */
  apply(mode: PermissionMode, options: PermissionUpdateOptions): Promise<void>;
}

/**
 * Serialize permission choices and remember the last host-confirmed mode.
 * Consecutive failures must roll back to that host value, never to the
 * optimistic value captured while the previous choice was still in flight.
 */
export function createPermissionUpdates(
  initial: PermissionMode,
): PermissionUpdates {
  let confirmed = initial;
  let pending: Promise<void> = Promise.resolve();
  return {
    get confirmed() {
      return confirmed;
    },
    reset(mode) {
      confirmed = mode;
    },
    apply(mode, options) {
      const update = pending
        .catch(() => undefined)
        .then(options.send)
        .then(() => {
          if (options.isCurrent()) confirmed = mode;
        });
      // The serial queue swallows the rejection: later choices and prompts
      // wait for a settled request instead of failing on the old one.
      const queue = update.then(
        () => undefined,
        () => undefined,
      );
      pending = queue;
      void update.catch((error) => {
        // A newer choice owns the visible state and its own request.
        if (pending !== queue || !options.isCurrent()) return;
        options.rejected(confirmed, error);
      });
      // Handing out the rejectable request lets the caller abort a turn that
      // would otherwise start with the host's previous mode. The queue above
      // already handles the rejection, so unused callers stay quiet.
      return update;
    },
  };
}

export interface PermissionSendGate {
  /** Track the newest permission write a prompt may depend on. */
  track(write: Promise<void>): void;
  /** Wait for it; a failed write rejects and clears itself for the next send. */
  wait(): Promise<void>;
  /** Forget the tracked write when another task or mode owns the state. */
  reset(): void;
}

/**
 * The permission write a prompt depends on. A failure must abort that send
 * instead of starting a turn with the host's old mode, but the failure must
 * not poison the next send, so the gate settles once the write failed.
 */
export function createPermissionSendGate(): PermissionSendGate {
  let pending: Promise<void> | null = null;
  const settle = (write: Promise<void>): void => {
    if (pending === write) pending = null;
  };
  return {
    track(write) {
      pending = write;
      // The failure is reported through `rejected`; clearing the tracked write
      // here lets a send that starts after the failure proceed, while a send
      // already waiting still observes the rejection and aborts.
      void write.catch(() => settle(write));
    },
    reset() {
      pending = null;
    },
    async wait() {
      const write = pending;
      if (!write) return;
      try {
        await write;
      } catch (error) {
        settle(write);
        throw error;
      }
    },
  };
}

export interface ArtifactListState<T> {
  artifacts: T[];
  /** Task that owns `artifacts`; a list from another task must not render. */
  artifactsTaskId: string | null;
  /** Refresh failure attributed to `artifactsTaskId`. */
  artifactError: string | null;
}

export interface ArtifactListOptions<T> {
  state: ArtifactListState<T>;
  /** Loads the artifact summaries for one task. */
  load: (taskId: string) => Promise<T[]>;
  /** Currently selected task and the selection generation. */
  selection: () => TaskSelection;
  /**
   * Reflect the refresh error in the visible error line. `previous` is the
   * error being replaced, so the view clears only a message it still owns.
   */
  errorChanged?: (error: string | null, previous: string | null) => void;
}

export interface ArtifactList<T> {
  /** Forget the visible list; called before selecting another task. */
  select(taskId: string | null): void;
  refresh(taskId: string | null): Promise<void>;
  /** The list only belongs to the task whose id it was loaded for. */
  visible(taskId?: string | null): T[];
  needsRefresh(taskId: string | null): boolean;
}

/** Keep artifact summaries scoped to the task that listed them. */
export function createArtifactList<T>(
  options: ArtifactListOptions<T>,
): ArtifactList<T> {
  const { state } = options;
  const sequences = new Map<string, number>();

  const setError = (error: string | null) => {
    const previous = state.artifactError;
    if (previous === error) return;
    state.artifactError = error;
    options.errorChanged?.(error, previous);
  };

  const select = (taskId: string | null) => {
    state.artifacts = [];
    state.artifactsTaskId = taskId;
    setError(null);
  };

  return {
    select,
    visible(taskId = options.selection().taskId) {
      return taskId !== null && state.artifactsTaskId === taskId
        ? state.artifacts
        : [];
    },
    needsRefresh(taskId) {
      return (
        taskId === null ||
        state.artifactsTaskId !== taskId ||
        state.artifacts.length === 0 ||
        state.artifactError !== null
      );
    },
    async refresh(taskId) {
      if (!taskId) {
        select(null);
        return;
      }
      const generation = options.selection().generation;
      // Calls overlap across load, send, clicks and the poll. Only the newest
      // request for this task may replace the visible list.
      const request = (sequences.get(taskId) ?? 0) + 1;
      sequences.set(taskId, request);
      const current = () => {
        const selection = options.selection();
        return (
          selection.taskId === taskId && selection.generation === generation
        );
      };
      try {
        const artifacts = await options.load(taskId);
        if (!current() || sequences.get(taskId) !== request) return;
        state.artifacts = artifacts;
        state.artifactsTaskId = taskId;
        setError(null);
      } catch (error) {
        if (!current() || sequences.get(taskId) !== request) return;
        // A failed read can keep the last list only when it already belongs to
        // this task; another task's results must never survive the failure.
        if (state.artifactsTaskId !== taskId) {
          state.artifacts = [];
          state.artifactsTaskId = taskId;
        }
        setError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

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

/** Only creation associates articles; later source changes cannot regroup tasks. */
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
    options.organization === "articles" ? "articles" : "time";
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
  const expandedArticles = new Set<string>(["unfiled", "research"]);
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
      const trigger = createWorkspaceButton(doc, "", "");
      trigger.classList.add("confucius-task-menu-trigger");
      trigger.title = options.text("workspace-task-actions");
      trigger.append(taskActionIcon(doc, "more"));
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
          const create = createWorkspaceButton(doc, "", "");
          create.classList.add("confucius-article-new");
          create.append(taskActionIcon(doc, "new"));
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
      const research = filtered
        .filter((task) => taskCategory(task) === "research")
        .sort(newestFirst);
      if (research.length)
        children.push(
          groupNode(
            "research",
            options.text("workspace-tasks-research"),
            research,
            preserveOrder,
          ),
        );
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
        .filter((task) => taskCategory(task) === "unfiled")
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
        key !== "articles/research" &&
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
        taskCategory(task),
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
