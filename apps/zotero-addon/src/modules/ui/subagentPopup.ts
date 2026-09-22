import type {
  ConfuciusEvent,
  SubagentPage,
  SubagentRecord,
  SubagentSummary,
} from "@confucius/protocol";
import { createWorkspaceButton } from "./workspaceControls";
import { researchIcon } from "./literaturePanel";
import { subagentTraceGroups, type SubagentTraceGroup } from "./subagentTrace";
import { getString } from "../../utils/locale";
type Rpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
const text = (key: string) => getString(`workspace-subagent-${key}`);
const NS = "http://www.w3.org/1999/xhtml";
const active = new WeakMap<
  Document,
  {
    readonly id: string;
    taskId: string;
    select(id: string, anchor?: HTMLElement): void;
    close(focus?: boolean): void;
  }
>();
const node = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  value?: string,
) => {
  const element = doc.createElementNS(NS, tag) as HTMLElementTagNameMap[K];
  if (value !== undefined) element.textContent = value;
  return element;
};
const working = (record: SubagentSummary) =>
  ["queued", "running"].includes(record.status);
const activity = (record: SubagentSummary) => {
  const state = record.activity;
  const label =
    record.status !== "running" || !state
      ? text(record.status)
      : state.kind === "tool"
        ? `${text("tool")} · ${state.toolName}`
        : text(state.kind === "model" ? "model" : "output");
  return `${label}${state ? ` · ${state.toolCalls} ${text("tool-calls")}` : ""}`;
};

export function createSubagentEntries(
  doc: Document,
  taskId: string,
  record: SubagentSummary,
  rpc: Rpc,
) {
  const root = node(doc, "div");
  root.className = "confucius-subagent-entries";
  const button = createWorkspaceButton(doc, "", "");
  button.classList.add("confucius-subagent-entry");
  button.dataset.subagentId = record.id;
  button.dataset.status = record.status;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "confucius-subagent-popup");
  button.setAttribute(
    "aria-expanded",
    String(active.get(doc)?.id === record.id),
  );
  const copy = node(doc, "span"),
    title = node(doc, "strong", record.title);
  const detail = node(
    doc,
    "span",
    record.status === "running"
      ? activity(record)
      : record.activity
        ? `${record.activity.toolCalls} ${text("tool-calls")}`
        : record.status === "queued"
          ? text("queued-detail")
          : "",
  );
  detail.hidden = !detail.textContent;
  copy.className = "confucius-subagent-entry-copy";
  detail.className = "confucius-subagent-meta";
  const badge = node(doc, "span", text(record.status));
  badge.className = "confucius-subagent-badge";
  copy.append(title, detail);
  button.append(researchIcon(doc, "agent"), copy, badge);
  button.addEventListener("click", () =>
    openSubagentPopup(doc, taskId, record.id, button, rpc),
  );
  root.append(button);
  return root;
}
export function closeSubagentPopup(doc: Document) {
  active.get(doc)?.close(false);
}
export function isSubagentPopupOpen(doc: Document) {
  return active.has(doc);
}

function openSubagentPopup(
  doc: Document,
  taskId: string,
  id: string,
  anchor: HTMLElement,
  rpc: Rpc,
) {
  const previous = active.get(doc);
  if (previous?.taskId === taskId) {
    if (previous.id === id) previous.close(true);
    else previous.select(id, anchor);
    return;
  }
  previous?.close(false);
  const popup = node(doc, "section");
  popup.id = "confucius-subagent-popup";
  popup.className = "confucius-subagent-popup";
  popup.dataset.subagentId = id;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-labelledby", "confucius-subagent-heading");
  const header = node(doc, "header"),
    heading = node(doc, "h3", text("title"));
  heading.id = "confucius-subagent-heading";
  header.className = "confucius-subagent-header";
  const copy = node(doc, "div"),
    status = node(doc, "div", text("loading"));
  status.className = "confucius-subagent-meta";
  status.setAttribute("role", "status");
  const close = createWorkspaceButton(doc, "", text("close"));
  copy.append(heading, status);
  header.append(researchIcon(doc, "agent"), copy, close);
  const navigation = node(doc, "nav"),
    back = createWorkspaceButton(doc, "", text("previous")),
    next = createWorkspaceButton(doc, "", text("next")),
    index = node(doc, "span");
  navigation.className = "confucius-subagent-navigation";
  navigation.setAttribute("aria-label", text("title"));
  back.dataset.direction = "previous";
  next.dataset.direction = "next";
  index.className = "confucius-subagent-meta";
  navigation.append(back, index, next);
  popup.append(header, navigation);
  (doc.body ?? doc.documentElement)?.append(popup);
  let closed = false,
    listing = false,
    selectedId = "",
    records: SubagentSummary[] = [];
  const panes = new Map<string, ReturnType<typeof createSubagentPane>>();
  const currentAnchor = () => {
    if (!anchor.isConnected || anchor.dataset.subagentId !== selectedId) {
      const replacement = [
        ...doc.querySelectorAll<HTMLElement>(".confucius-subagent-entry"),
      ].find((e) => e.dataset.subagentId === selectedId);
      if (replacement) anchor = replacement;
    }
    return anchor.dataset.subagentId === selectedId ? anchor : undefined;
  };
  const renderNavigation = () => {
    const position = records.findIndex((r) => r.id === selectedId);
    index.textContent =
      position < 0 ? "" : `${position + 1} / ${records.length}`;
    back.disabled = position <= 0;
    next.disabled = position < 0 || position >= records.length - 1;
    back.title = records[position - 1]?.title ?? text("previous");
    next.title = records[position + 1]?.title ?? text("next");
  };
  const refreshNavigation = async () => {
    if (closed || listing) return;
    listing = true;
    try {
      const value = (await rpc("subagent/list", {
        taskId,
      })) as SubagentSummary[];
      if (!closed) {
        records = value;
        renderNavigation();
      }
    } catch {
      // The current trace remains usable if the task list cannot be refreshed.
    } finally {
      listing = false;
    }
  };
  const select = (nextId: string, nextAnchor?: HTMLElement) => {
    if (closed || nextId === selectedId) return;
    currentAnchor()?.setAttribute("aria-expanded", "false");
    const previousPane = panes.get(selectedId);
    previousPane?.pause();
    previousPane?.root.remove();
    selectedId = nextId;
    if (nextAnchor) anchor = nextAnchor;
    currentAnchor()?.setAttribute("aria-expanded", "true");
    popup.dataset.subagentId = selectedId;
    delete popup.dataset.status;
    heading.textContent =
      records.find((r) => r.id === selectedId)?.title ??
      currentAnchor()?.querySelector("strong")?.textContent ??
      text("title");
    status.textContent = text("loading");
    let pane = panes.get(selectedId);
    if (!pane) {
      pane = createSubagentPane(doc, taskId, selectedId, rpc, (record) => {
        heading.textContent = record.title;
        const elapsed = Math.max(
          0,
          Math.floor(
            ((working(record) ? Date.now() : record.updatedAt) -
              record.createdAt) /
              1000,
          ),
        );
        status.textContent = `${activity(record)} · ${text("attempt")} ${record.attempt} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
        popup.dataset.status = record.status;
        void refreshNavigation();
      });
      panes.set(selectedId, pane);
    }
    popup.append(pane.root);
    pane.activate();
    renderNavigation();
    void refreshNavigation();
    if (nextAnchor) close.focus({ preventScroll: true });
  };
  const dismiss = (focus = true) => {
    if (closed) return;
    closed = true;
    for (const pane of panes.values()) pane.dispose();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", key, true);
    popup.remove();
    active.delete(doc);
    const entry = currentAnchor();
    entry?.setAttribute("aria-expanded", "false");
    if (focus && entry?.isConnected) entry.focus({ preventScroll: true });
  };
  const outside = (e: Event) => {
    if (
      !popup.contains(e.target as Node) &&
      !(e.target as Element)?.closest?.(".confucius-subagent-entry")
    )
      dismiss(false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  active.set(doc, {
    get id() {
      return selectedId;
    },
    taskId,
    select,
    close: dismiss,
  });
  close.addEventListener("click", () => dismiss());
  for (const [button, step] of [
    [back, -1],
    [next, 1],
  ] as const)
    button.addEventListener("click", () => {
      const target =
        records[records.findIndex((r) => r.id === selectedId) + step];
      if (target) select(target.id);
    });
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", key, true);
  select(id, anchor);
}

function createSubagentPane(
  doc: Document,
  taskId: string,
  id: string,
  rpc: Rpc,
  onRecord: (record: SubagentRecord) => void,
) {
  const win = doc.defaultView;
  const root = node(doc, "div");
  root.className = "confucius-subagent-pane";
  const scroll = node(doc, "div");
  scroll.className = "confucius-subagent-scroll";
  const error = node(doc, "div");
  error.className = "confucius-subagent-error";
  error.setAttribute("role", "status");
  const errorText = node(doc, "span"),
    reload = createWorkspaceButton(doc, "", text("refresh"));
  error.append(errorText, reload);
  error.hidden = true;
  const details = node(doc, "details"),
    recordBody = node(doc, "pre");
  details.className = "confucius-subagent-details";
  details.append(node(doc, "summary", text("assignment")), recordBody);
  const result = node(doc, "section"),
    output = node(doc, "div");
  output.className = "confucius-subagent-result";
  result.append(node(doc, "h4", text("result")), output);
  result.hidden = true;
  const toolbar = node(doc, "div"),
    filter = node(doc, "input"),
    count = node(doc, "span");
  toolbar.className = "confucius-subagent-filter";
  filter.type = "search";
  filter.placeholder = text("filter");
  filter.setAttribute("aria-label", text("filter"));
  count.className = "confucius-subagent-meta";
  toolbar.append(filter, count);
  const timeline = node(doc, "div");
  timeline.className = "confucius-subagent-trace";
  const archives = node(doc, "details"),
    archiveList = node(doc, "div");
  archives.className = "confucius-subagent-details";
  const more = createWorkspaceButton(doc, "", text("more"));
  more.hidden = true;
  archives.append(node(doc, "summary", text("receipts")), archiveList, more);
  const coverage = node(doc, "p", text("coverage"));
  coverage.className = "confucius-subagent-meta";
  scroll.append(error, details, result, timeline, archives, coverage);
  const footer = node(doc, "footer"),
    tail = createWorkspaceButton(doc, "", text("latest"));
  footer.className = "confucius-subagent-footer";
  const actions = node(doc, "div"),
    stop = createWorkspaceButton(doc, "", text("stop")),
    retry = createWorkspaceButton(doc, "", text("retry"));
  actions.className = "confucius-literature-controls";
  stop.hidden = retry.hidden = true;
  actions.append(stop, retry);
  footer.append(tail, actions);
  root.append(toolbar, scroll, footer);
  let closed = false,
    isActive = false,
    savedScroll = 0,
    timer: number | undefined,
    request = 0;
  let cursor = 0,
    archiveCursor = 0,
    nextArchive: number | null = null,
    record: SubagentRecord | undefined,
    mutating = false;
  const events: ConfuciusEvent[] = [],
    refs = new Set<string>();
  const rows = new Map<
    string,
    { root: HTMLDetailsElement; signature: string }
  >();
  const label = (group: SubagentTraceGroup) =>
    group.kind === "tool"
      ? group.label
      : group.kind === "model"
        ? text("model-request")
        : group.kind === "message"
          ? text(group.label === "commentary" ? "progress" : "output")
          : ((
              {
                turn_started: text("started"),
                turn_completed: text("completed"),
                turn_failed: text("failed"),
                turn_aborted: text("cancelled"),
              } as Record<string, string>
            )[group.label] ?? group.label);
  const render = () => {
    if (!record || closed || !isActive) return;
    const y = scroll.scrollTop,
      follow = scroll.scrollHeight - scroll.clientHeight - y < 48;
    onRecord(record);
    stop.hidden = !working(record);
    retry.hidden = !["failed", "cancelled", "interrupted"].includes(
      record.status,
    );
    stop.disabled = retry.disabled = mutating;
    const selected = doc.getSelection()?.toString();
    if (!selected) {
      output.textContent = record.error
        ? `${record.error}\n\n${record.result}`
        : record.result;
      recordBody.textContent = JSON.stringify(
        {
          goal: record.goal,
          background: record.background,
          sources: record.sources,
          backend: record.backend,
          model: record.runtimeModel ?? record.nativeConfig,
          evidence: record.evidence,
        },
        null,
        2,
      );
    }
    result.hidden = working(record) || !output.textContent;
    const groups = subagentTraceGroups(events),
      query = filter.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const group of groups) {
      let row = rows.get(group.key);
      if (!row) {
        const root = node(doc, "details");
        root.className = "confucius-subagent-trace-item";
        root.dataset.traceKey = group.key;
        root.append(node(doc, "summary"), node(doc, "div"));
        row = { root, signature: "" };
        rows.set(group.key, row);
        timeline.append(root);
      }
      const visibleGroup =
        !query || JSON.stringify(group).toLocaleLowerCase().includes(query);
      row.root.hidden = !visibleGroup;
      if (visibleGroup) visible++;
      const signature = `${group.events.length}:${group.events.at(-1)?.id}:${record.status}`;
      if (
        row.signature === signature ||
        (selected && row.root.contains(doc.getSelection()?.anchorNode ?? null))
      )
        continue;
      row.signature = signature;
      row.root.dataset.kind = group.kind;
      row.root.dataset.state =
        group.state === "running" && !working(record)
          ? "interrupted"
          : group.state;
      const summary = row.root.firstElementChild!;
      const time = node(
        doc,
        "time",
        new Date(group.events[0].ts).toLocaleTimeString([], { hour12: false }),
      );
      summary.replaceChildren(
        time,
        node(doc, "span", label(group)),
        node(doc, "span", text(row.root.dataset.state)),
      );
      const body = row.root.lastElementChild!,
        rawOpen = !!body.querySelector<HTMLDetailsElement>(
          ".confucius-subagent-raw",
        )?.open;
      body.replaceChildren();
      if (group.text) {
        const prose = node(doc, "div", group.text);
        prose.className = "confucius-subagent-result";
        body.append(prose);
      }
      const raw = node(doc, "details");
      raw.className = "confucius-subagent-raw";
      raw.append(
        node(doc, "summary", `${text("raw")} · ${group.events.length}`),
      );
      raw.addEventListener("toggle", () => {
        if (raw.open && !raw.querySelector("pre"))
          raw.append(node(doc, "pre", JSON.stringify(group.events, null, 2)));
      });
      raw.open = rawOpen;
      if (group.kind === "tool") {
        for (const event of group.events) {
          if (event.type === "tool_requested" || event.type === "tool_result") {
            body.append(
              node(
                doc,
                "h5",
                text(event.type === "tool_requested" ? "arguments" : "receipt"),
              ),
              node(
                doc,
                "pre",
                JSON.stringify(
                  event.type === "tool_requested"
                    ? event.payload.args
                    : event.payload.result,
                  null,
                  2,
                ),
              ),
            );
          }
        }
      }
      body.append(raw);
    }
    count.textContent = `${visible} / ${groups.length} · ${events.length} ${text("events")}`;
    scroll.scrollTop =
      follow && !selected && !filter.value ? scroll.scrollHeight : y;
  };
  const addArchives = (page: SubagentPage) => {
    for (const ref of page.archiveRefs) {
      if (refs.has(ref)) continue;
      refs.add(ref);
      const item = node(doc, "details"),
        body = node(doc, "pre"),
        loadMore = createWorkspaceButton(doc, "", text("more"));
      item.append(node(doc, "summary", ref), body, loadMore);
      archiveList.append(item);
      let offset: number | null = 0,
        loading = false,
        started = false;
      const read = async () => {
        if (loading || closed || offset === null) return;
        loading = true;
        loadMore.disabled = true;
        try {
          const value = (await rpc("subagent/read", {
            taskId,
            id,
            offset: cursor,
            limit: 1,
            archiveRef: ref,
            archiveOffset: offset,
          })) as SubagentPage;
          if (closed) return;
          if (value.passage) {
            body.textContent += value.passage.content;
            offset = value.passage.nextOffset;
          }
          started = true;
          loadMore.hidden = offset === null;
        } catch (e) {
          if (!closed) errorMessage(e);
        } finally {
          loading = false;
          loadMore.disabled = false;
        }
      };
      item.addEventListener("toggle", () => {
        if (item.open && !started) void read();
      });
      loadMore.addEventListener("click", () => void read());
    }
    archiveCursor = refs.size;
    nextArchive = page.nextArchiveOffset;
    more.hidden = nextArchive === null;
  };
  const errorMessage = (e: unknown) => {
    errorText.textContent = String(e instanceof Error ? e.message : e);
    error.hidden = false;
  };
  const load = async () => {
    if (closed || !isActive) return;
    win?.clearTimeout(timer);
    const sequence = ++request;
    try {
      let target: number | undefined,
        total = cursor;
      do {
        const page = (await rpc("subagent/read", {
          taskId,
          id,
          offset: cursor,
          limit: 25,
          archiveIndexOffset: archiveCursor,
        })) as SubagentPage;
        if (closed || sequence !== request) return;
        record = page.record;
        target ??= page.totalEvents;
        total = page.totalEvents;
        events.push(...page.events);
        cursor += page.events.length;
        addArchives(page);
        if (!page.events.length || page.nextOffset === null) break;
      } while (cursor < target);
      error.hidden = true;
      render();
      if (record && (working(record) || cursor < total))
        timer = win?.setTimeout(() => void load(), 1000);
    } catch (e) {
      if (!closed && sequence === request) errorMessage(e);
    }
  };
  const action = async (method: string) => {
    if (mutating || closed || !isActive) return;
    mutating = true;
    stop.disabled = retry.disabled = true;
    try {
      await rpc(method, { taskId, id });
      if (!closed) await load();
    } catch (e) {
      if (!closed) errorMessage(e);
    } finally {
      mutating = false;
      if (!closed) render();
    }
  };
  stop.addEventListener("click", () => void action("subagent/cancel"));
  retry.addEventListener("click", () => void action("subagent/retry"));
  reload.addEventListener("click", () => void load());
  filter.addEventListener("input", render);
  tail.addEventListener("click", () => {
    scroll.scrollTop = scroll.scrollHeight;
  });
  more.addEventListener("click", () => {
    if (nextArchive === null) return;
    more.disabled = true;
    void rpc("subagent/read", {
      taskId,
      id,
      offset: cursor,
      limit: 1,
      archiveIndexOffset: archiveCursor,
    })
      .then((value) => {
        if (!closed) addArchives(value as SubagentPage);
      })
      .catch((e) => {
        if (!closed) errorMessage(e);
      })
      .finally(() => {
        more.disabled = false;
      });
  });
  const pause = () => {
    savedScroll = scroll.scrollTop;
    isActive = false;
    request++;
    win?.clearTimeout(timer);
  };
  return {
    root,
    activate() {
      isActive = true;
      scroll.scrollTop = savedScroll;
      render();
      void load();
    },
    pause,
    dispose() {
      pause();
      closed = true;
    },
  };
}
