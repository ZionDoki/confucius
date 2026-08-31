import type { ConfuciusEvent } from "@confucius/protocol";
import type { ConfuciusSkill } from "@confucius/skill-format";
import { getString } from "../../utils/locale";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface WorkspaceHost {
  rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface WorkspaceInspect {
  open: boolean;
  title: string;
  hasRoot: boolean;
  hasPrompt: boolean;
  hasSend: boolean;
  promptTag: string;
  promptType: string;
  childCount: number;
  visibleText: string;
}

type SessionRow = { id: string; title?: string };

type ApprovalRow = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
};

type MemoryRow = {
  id: string;
  type: string;
  title: string;
  content: string;
  tags?: string[];
};

type TimelineItem =
  | { kind: "event"; event: ConfuciusEvent }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string };

type Styles = Record<string, string>;

function el(
  doc: Document,
  tag: string,
  styles?: Styles,
  attrs?: Record<string, string>,
): HTMLElement {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  if (styles) {
    Object.assign(node.style, styles);
  }
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
  }
  return node;
}

function applyFill(node: HTMLElement): void {
  Object.assign(node.style, {
    position: "fixed",
    top: "0px",
    right: "0px",
    bottom: "0px",
    left: "0px",
    display: "flex",
    flexDirection: "column",
    margin: "0px",
    padding: "0px",
    width: "auto",
    height: "auto",
    minWidth: "640px",
    minHeight: "420px",
    boxSizing: "border-box",
    background: "#f6f3ec",
    color: "#1c1917",
    font: '13px/1.45 "Segoe UI", "SF Pro Text", sans-serif',
  });
}

function paneLabel(doc: Document, text: string): HTMLElement {
  const node = el(doc, "div", {
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#6b645b",
    marginBottom: "10px",
  });
  node.textContent = text;
  return node;
}

function muted(doc: Document, text: string): HTMLElement {
  const node = el(doc, "div", { color: "#6b645b" });
  node.textContent = text;
  return node;
}

function button(doc: Document, id: string, label: string): HTMLElement {
  const node = el(
    doc,
    "button",
    {
      background: "#2f5d45",
      color: "#f6f3ec",
      border: "1px solid #244a38",
      borderRadius: "6px",
      padding: "6px 12px",
      cursor: "pointer",
      minHeight: "32px",
      font: "inherit",
    },
    { id, type: "button" },
  );
  node.textContent = label;
  return node;
}

function requireDocument(root: HTMLElement): Document {
  const doc = root.ownerDocument;
  if (!doc) {
    throw new Error("workspace root has no document");
  }
  return doc;
}

function showMountError(root: HTMLElement, error: unknown): void {
  const doc = requireDocument(root);
  root.textContent = "";
  applyFill(root);
  const panel = el(doc, "div", {
    padding: "24px",
    color: "#7c2d12",
    background: "#fff7ed",
  });
  const title = el(doc, "div", { fontWeight: "700", marginBottom: "8px" });
  title.textContent = "Confucius workspace failed to mount.";
  const detail = el(doc, "pre", {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  });
  detail.textContent =
    error instanceof Error ? error.stack || error.message : String(error);
  panel.appendChild(title);
  panel.appendChild(detail);
  root.appendChild(panel);
}

export function inspectWorkspace(win?: Window | null): WorkspaceInspect {
  const doc = win && !win.closed ? win.document : null;
  const root = doc?.getElementById("confucius-root");
  const prompt = doc?.getElementById(
    "confucius-prompt",
  ) as HTMLInputElement | null;
  const send = doc?.getElementById("confucius-send");
  return {
    open: Boolean(win && !win.closed),
    title: doc?.title || "",
    hasRoot: Boolean(root),
    hasPrompt: Boolean(prompt),
    hasSend: Boolean(send),
    promptTag: prompt?.tagName || "",
    promptType: prompt?.getAttribute("type") || "",
    childCount: root?.childNodes.length || 0,
    visibleText: (root?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
}

export function mountWorkspace(win: Window, host: WorkspaceHost | null): void {
  const doc = win.document;
  const html = doc.documentElement as HTMLElement | null;
  const body = (doc.body || html) as HTMLElement | null;
  if (!html || !body) {
    throw new Error("workspace document has no body");
  }

  html.style.margin = "0";
  html.style.padding = "0";
  html.style.width = "100%";
  html.style.height = "100%";
  html.style.background = "#f6f3ec";
  body.style.margin = "0";
  body.style.padding = "0";
  body.style.width = "100%";
  body.style.height = "100%";
  body.style.background = "#f6f3ec";
  try {
    win.document.title = getString("workspace-title");
  } catch {
    win.document.title = "Confucius";
  }

  let root = doc.getElementById("confucius-root") as HTMLElement | null;
  if (!root) {
    root = el(doc, "div", undefined, { id: "confucius-root" });
    body.appendChild(root);
  }

  try {
    bindWorkspace(root, host);
  } catch (error) {
    showMountError(root, error);
    throw error;
  }
}

function bindWorkspace(root: HTMLElement, host: WorkspaceHost | null): void {
  const doc = requireDocument(root);
  const win = doc.defaultView;
  root.textContent = "";
  applyFill(root);

  const state = {
    sessions: [] as SessionRow[],
    sessionId: null as string | null,
    events: [] as ConfuciusEvent[],
    lastEventId: null as string | null,
    skills: [] as ConfuciusSkill[],
    skillSlug: "",
    approvals: [] as ApprovalRow[],
    memories: [] as MemoryRow[],
    mode: "agent" as "agent" | "plan",
    pendingUserText: "",
    sendError: "",
    sending: false,
  };

  const topbar = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    borderBottom: "1px solid #d7d0c4",
    background: "#efeae0",
    minHeight: "48px",
    boxSizing: "border-box",
    flex: "0 0 auto",
  });
  const brand = el(doc, "div", { fontWeight: "700", fontSize: "15px" });
  brand.textContent = "Confucius";
  const status = el(
    doc,
    "span",
    { color: "#8a5a12" },
    { id: "confucius-status" },
  );
  status.textContent = host
    ? getString("workspace-connecting")
    : "host missing";
  const newSessionBtn = button(
    doc,
    "confucius-new-session",
    getString("workspace-new-session"),
  );
  const modeBtn = button(doc, "confucius-mode", "Agent");
  modeBtn.style.background = "#6b645b";
  modeBtn.style.border = "1px solid #57514a";
  const skillSelect = el(
    doc,
    "select",
    {
      minWidth: "180px",
      height: "32px",
      border: "1px solid #c4bdb3",
      borderRadius: "6px",
      background: "#ffffff",
      color: "#1c1917",
      padding: "0 8px",
    },
    { id: "confucius-skill" },
  ) as HTMLSelectElement;
  const emptySkill = el(doc, "option", undefined, { value: "" });
  emptySkill.textContent = getString("workspace-no-skill");
  skillSelect.appendChild(emptySkill);
  topbar.appendChild(brand);
  topbar.appendChild(status);
  topbar.appendChild(newSessionBtn);
  topbar.appendChild(modeBtn);
  topbar.appendChild(skillSelect);

  const columns = el(doc, "div", {
    display: "flex",
    flex: "1 1 auto",
    minHeight: "240px",
    overflow: "hidden",
  });
  const sessionPane = el(doc, "div", {
    width: "220px",
    minWidth: "180px",
    padding: "14px",
    overflow: "auto",
    borderRight: "1px solid #d7d0c4",
    background: "#fbf8f2",
    boxSizing: "border-box",
  });
  const timelinePane = el(doc, "div", {
    flex: "1 1 auto",
    minWidth: "280px",
    padding: "14px",
    overflow: "auto",
    background: "#ffffff",
    boxSizing: "border-box",
  });
  const reviewPane = el(doc, "div", {
    width: "260px",
    minWidth: "200px",
    padding: "14px",
    overflow: "auto",
    borderLeft: "1px solid #d7d0c4",
    background: "#fbf8f2",
    boxSizing: "border-box",
  });
  columns.appendChild(sessionPane);
  columns.appendChild(timelinePane);
  columns.appendChild(reviewPane);

  const composer = el(doc, "form", {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "12px 14px",
    borderTop: "1px solid #d7d0c4",
    background: "#efeae0",
    minHeight: "64px",
    boxSizing: "border-box",
    flex: "0 0 auto",
  });
  const prompt = el(
    doc,
    "input",
    {
      flex: "1 1 auto",
      display: "block",
      height: "40px",
      minHeight: "40px",
      minWidth: "240px",
      border: "1px solid #c4bdb3",
      borderRadius: "8px",
      background: "#ffffff",
      color: "#1c1917",
      padding: "0 12px",
      font: "inherit",
    },
    {
      id: "confucius-prompt",
      type: "text",
      placeholder: getString("workspace-composer-placeholder"),
    },
  ) as HTMLInputElement;
  const sendBtn = button(doc, "confucius-send", getString("workspace-send"));
  sendBtn.setAttribute("type", "submit");
  const stopBtn = button(doc, "confucius-stop", getString("workspace-stop"));
  composer.appendChild(prompt);
  composer.appendChild(sendBtn);
  composer.appendChild(stopBtn);

  root.appendChild(topbar);
  root.appendChild(columns);
  root.appendChild(composer);

  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!host) {
      throw new Error("Confucius host is not available");
    }
    return host.rpc(method, params);
  }

  function renderLists(): void {
    sessionPane.textContent = "";
    sessionPane.appendChild(paneLabel(doc, getString("workspace-sessions")));
    if (!state.sessions.length) {
      sessionPane.appendChild(muted(doc, getString("workspace-no-sessions")));
    } else {
      for (const item of state.sessions) {
        const row = el(doc, "div", {
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "8px",
          borderRadius: "6px",
          cursor: "pointer",
          background: item.id === state.sessionId ? "#e4ddd0" : "transparent",
        });
        const label = el(doc, "div", {
          flex: "1 1 auto",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        label.textContent = item.title || item.id;
        const del = el(
          doc,
          "button",
          {
            flex: "0 0 auto",
            border: "none",
            background: "transparent",
            color: "#b42318",
            cursor: "pointer",
            font: "inherit",
            padding: "0 4px",
          },
          { type: "button", title: "Delete session" },
        );
        del.textContent = "✕";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          void (async () => {
            await rpc("session/delete", { sessionId: item.id });
            if (state.sessionId === item.id) {
              state.sessionId = null;
              state.events = [];
              state.lastEventId = null;
            }
            await refreshSessions();
            renderLists();
          })();
        });
        row.addEventListener("click", () => {
          void (async () => {
            state.sessionId = item.id;
            state.lastEventId = null;
            const loaded = (await rpc("session/load", {
              sessionId: item.id,
            })) as { skillSlug?: string; mode?: string };
            state.skillSlug = loaded.skillSlug || state.skillSlug;
            state.mode = loaded.mode === "plan" ? "plan" : "agent";
            syncModeButton();
            skillSelect.value = state.skillSlug;
            const bundle = (await rpc("session/events", {
              sessionId: item.id,
            })) as { events?: ConfuciusEvent[] };
            state.events = bundle.events || [];
            if (state.events.length) {
              state.lastEventId =
                state.events[state.events.length - 1].id;
            }
            collectApprovals();
            renderLists();
          })();
        });
        row.appendChild(label);
        row.appendChild(del);
        sessionPane.appendChild(row);
      }
    }

    timelinePane.textContent = "";
    const session = state.sessions.find((item) => item.id === state.sessionId);
    timelinePane.appendChild(
      paneLabel(
        doc,
        session
          ? `${getString("workspace-timeline")} · ${session.title || session.id}`
          : getString("workspace-timeline"),
      ),
    );
    if (state.pendingUserText) {
      const pending = el(doc, "div", {
        border: "1px solid #cfd8d3",
        borderRadius: "8px",
        padding: "8px 10px",
        marginBottom: "8px",
        background: "#eef4ef",
      });
      pending.textContent = state.pendingUserText;
      timelinePane.appendChild(pending);
    }
    if (state.sendError) {
      const err = el(doc, "div", {
        border: "1px solid #e8b4b0",
        borderRadius: "8px",
        padding: "8px 10px",
        marginBottom: "8px",
        background: "#fff4f2",
        color: "#7c2d12",
      });
      err.textContent = state.sendError;
      timelinePane.appendChild(err);
    }
    if (!state.events.length && !state.pendingUserText && !state.sendError) {
      timelinePane.appendChild(
        muted(doc, getString("workspace-empty-timeline")),
      );
    } else {
      for (const item of coalesceTimeline(state.events)) {
        if (item.kind === "event") {
          const card = renderEvent(doc, item.event);
          if (card) {
            timelinePane.appendChild(card);
          }
        } else if (item.kind === "text") {
          const card = el(doc, "div", {
            border: "1px solid #cfd8d3",
            borderRadius: "8px",
            padding: "8px 10px",
            marginBottom: "8px",
            background: "#f2f7f4",
            whiteSpace: "pre-wrap",
          });
          card.textContent = item.text;
          timelinePane.appendChild(card);
        } else {
          const card = el(doc, "div", {
            border: "1px dashed #d7d0c4",
            borderRadius: "8px",
            padding: "8px 10px",
            marginBottom: "8px",
            background: "#faf8f4",
            color: "#6b645b",
            fontSize: "12px",
            whiteSpace: "pre-wrap",
          });
          card.textContent = item.text;
          timelinePane.appendChild(card);
        }
      }
    }

    reviewPane.textContent = "";
    reviewPane.appendChild(paneLabel(doc, getString("workspace-review")));
    if (!state.approvals.length) {
      reviewPane.appendChild(muted(doc, getString("workspace-empty-review")));
    } else {
      for (const item of state.approvals) {
        const card = el(doc, "div", {
          border: "1px solid #d4b46a",
          borderRadius: "8px",
          padding: "8px 10px",
          marginBottom: "8px",
          background: "#fff8e8",
        });
        const name = el(doc, "div");
        name.textContent = item.toolName;
        const pre = el(doc, "pre", {
          whiteSpace: "pre-wrap",
          fontSize: "11px",
        });
        pre.textContent = JSON.stringify(item.args, null, 2);
        const actions = el(doc, "div", {
          display: "flex",
          gap: "6px",
          marginTop: "6px",
        });
        const allow = button(doc, "", "Allow");
        const always = button(doc, "", "Always");
        always.style.background = "#6b645b";
        always.style.border = "1px solid #57514a";
        const deny = button(doc, "", "Deny");
        deny.style.background = "#8a5a12";
        deny.style.border = "1px solid #6f470e";
        allow.addEventListener("click", () => {
          void resolveApproval(item.id, "allow", "once");
        });
        always.addEventListener("click", () => {
          void resolveApproval(item.id, "allow", "always");
        });
        deny.addEventListener("click", () => {
          void resolveApproval(item.id, "deny", "once");
        });
        actions.appendChild(allow);
        actions.appendChild(always);
        actions.appendChild(deny);
        card.appendChild(name);
        card.appendChild(pre);
        card.appendChild(actions);
        reviewPane.appendChild(card);
      }
    }

    reviewPane.appendChild(paneLabel(doc, getString("workspace-memory")));
    if (!state.memories.length) {
      reviewPane.appendChild(muted(doc, getString("workspace-no-memory")));
    } else {
      for (const memory of state.memories) {
        const card = el(doc, "div", {
          border: "1px solid #d7d0c4",
          borderRadius: "8px",
          padding: "6px 8px",
          marginBottom: "6px",
          background: "#ffffff",
        });
        const title = el(doc, "div", {
          fontSize: "11px",
          color: "#2f5d45",
          fontWeight: "700",
        });
        title.textContent = `[${memory.type}] ${memory.title}`;
        const body = el(doc, "div", { fontSize: "12px" });
        body.textContent = memory.content;
        const del = el(
          doc,
          "button",
          {
            border: "none",
            background: "transparent",
            color: "#b42318",
            cursor: "pointer",
            font: "inherit",
            fontSize: "11px",
            padding: "0",
          },
          { type: "button" },
        );
        del.textContent = "forget";
        del.addEventListener("click", () => {
          void (async () => {
            await rpc("memory/delete", { id: memory.id });
            await refreshMemories();
            renderLists();
          })();
        });
        card.appendChild(title);
        card.appendChild(body);
        card.appendChild(del);
        reviewPane.appendChild(card);
      }
    }
  }

  function syncModeButton(): void {
    modeBtn.textContent = state.mode === "plan" ? "Plan" : "Agent";
  }

  /** Merge runs of stream deltas into single cards to keep the timeline readable. */
  function coalesceTimeline(events: ConfuciusEvent[]): TimelineItem[] {
    const items: TimelineItem[] = [];
    let text = "";
    let reasoning = "";
    const flush = () => {
      if (reasoning) {
        items.push({ kind: "reasoning", text: reasoning });
        reasoning = "";
      }
      if (text) {
        items.push({ kind: "text", text });
        text = "";
      }
    };
    for (const event of events) {
      if (event.type === "text_delta") {
        text += event.payload.text;
        continue;
      }
      if (event.type === "reasoning_delta") {
        if (text) {
          items.push({ kind: "text", text });
          text = "";
        }
        reasoning += event.payload.text;
        continue;
      }
      flush();
      items.push({ kind: "event", event });
    }
    flush();
    return items;
  }

  function collectApprovals(): void {
    const open = new Map<string, ApprovalRow>();
    for (const event of state.events) {
      if (event.type === "approval_required") {
        const request = event.payload.request;
        open.set(request.id, {
          id: request.id,
          toolName: request.toolName,
          args: request.args,
        });
      }
      if (event.type === "approval_resolved") {
        open.delete(event.payload.resolution.id);
      }
    }
    state.approvals = [...open.values()];
  }

  async function refreshSessions(): Promise<void> {
    const listed = (await rpc("session/list", {})) as {
      sessions?: SessionRow[];
    };
    state.sessions = listed.sessions || [];
    if (!state.sessionId && state.sessions[0]) {
      state.sessionId = state.sessions[0].id;
    }
  }

  async function sendPrompt(): Promise<void> {
    const text = prompt.value.trim();
    if (!text || state.sending) {
      return;
    }
    state.sending = true;
    state.sendError = "";
    state.pendingUserText = text;
    sendBtn.setAttribute("disabled", "true");
    status.style.color = "#8a5a12";
    status.textContent = getString("workspace-sending");
    try {
      if (!state.sessionId) {
        const created = (await rpc("session/new", {
          title: text.slice(0, 72),
        })) as SessionRow;
        state.sessionId = created.id;
        state.events = [];
        state.lastEventId = null;
      }
      if (skillSelect.value && skillSelect.value !== state.skillSlug) {
        state.skillSlug = skillSelect.value;
      }
      if (state.skillSlug) {
        await rpc("skill/activate", {
          sessionId: state.sessionId,
          slug: state.skillSlug,
        });
      }
      prompt.value = "";
      await refreshSessions();
      renderLists();
      await rpc("session/prompt", { sessionId: state.sessionId, text });
      state.pendingUserText = "";
      await refreshSessions();
      const bundle = (await rpc("session/events", {
        sessionId: state.sessionId,
      })) as { events?: ConfuciusEvent[] };
      state.events = bundle.events || [];
      if (state.events.length) {
        state.lastEventId = state.events[state.events.length - 1].id;
      }
      collectApprovals();
      renderLists();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      state.sendError = message;
      status.style.color = "#b42318";
      status.textContent = message;
      renderLists();
    } finally {
      state.sending = false;
      sendBtn.removeAttribute("disabled");
    }
  }

  async function resolveApproval(
    id: string,
    verdict: "allow" | "deny",
    scope: "once" | "always",
  ) {
    await rpc("approval/resolve", { id, verdict, scope });
    collectApprovals();
    renderLists();
  }

  async function refreshMemories(): Promise<void> {
    try {
      const listed = (await rpc("memory/list", { limit: 8 })) as {
        memories?: MemoryRow[];
      };
      state.memories = listed.memories ?? [];
    } catch {
      state.memories = [];
    }
  }

  async function poll(): Promise<void> {
    try {
      if (!state.skills.length) {
        const listed = (await rpc("skill/list", {})) as {
          skills?: ConfuciusSkill[];
        };
        state.skills = listed.skills || [];
        skillSelect.textContent = "";
        const none = el(doc, "option", undefined, { value: "" });
        none.textContent = getString("workspace-no-skill");
        skillSelect.appendChild(none);
        for (const skill of state.skills) {
          const option = el(doc, "option", undefined, { value: skill.slug });
          option.textContent = skill.name;
          if (skill.slug === state.skillSlug) {
            option.setAttribute("selected", "true");
          }
          skillSelect.appendChild(option);
        }
        skillSelect.value = state.skillSlug;
      }
      await refreshSessions();
      await refreshMemories();
      if (state.sessionId) {
        const bundle = (await rpc("session/events", {
          sessionId: state.sessionId,
          afterId: state.lastEventId,
        })) as { events?: ConfuciusEvent[] };
        const incoming = bundle.events || [];
        if (!state.lastEventId) {
          state.events = incoming;
        } else if (incoming.length) {
          state.events = state.events.concat(incoming);
        }
        if (state.events.length) {
          state.lastEventId = state.events[state.events.length - 1].id;
        }
        collectApprovals();
        if (
          incoming.some(
            (event) => event.type === "memory_updated",
          )
        ) {
          await refreshMemories();
        }
      }
      renderLists();
      status.style.color = "#2f5d45";
      status.textContent = getString("workspace-host-zotero");
    } catch (error) {
      status.style.color = "#b42318";
      status.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }

  newSessionBtn.addEventListener("click", () => {
    void (async () => {
      const created = (await rpc("session/new", {
        title: "Untitled",
      })) as SessionRow;
      state.sessionId = created.id;
      state.events = [];
      state.lastEventId = null;
      state.mode = "agent";
      syncModeButton();
      await refreshSessions();
      renderLists();
    })();
  });
  modeBtn.addEventListener("click", () => {
    void (async () => {
      if (!state.sessionId) {
        return;
      }
      state.mode = state.mode === "plan" ? "agent" : "plan";
      syncModeButton();
      await rpc("session/setMode", {
        sessionId: state.sessionId,
        mode: state.mode,
      });
    })();
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt();
  });
  sendBtn.addEventListener("click", (event) => {
    event.preventDefault();
    void sendPrompt();
  });
  stopBtn.addEventListener("click", () => {
    if (state.sessionId) {
      void rpc("session/abort", { sessionId: state.sessionId });
    }
  });
  prompt.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") {
      event.preventDefault();
      void sendPrompt();
    }
  });
  skillSelect.addEventListener("change", () => {
    state.skillSlug = skillSelect.value;
    if (state.sessionId) {
      void rpc("skill/activate", {
        sessionId: state.sessionId,
        slug: state.skillSlug || null,
      });
    }
  });

  renderLists();
  if (host) {
    void poll();
    const timer = win?.setInterval(() => {
      void poll();
    }, 800);
    win?.addEventListener("unload", () => {
      if (timer) {
        win.clearInterval(timer);
      }
    });
  }
}

function renderEvent(doc: Document, event: ConfuciusEvent): HTMLElement | null {
  const card = el(doc, "div", {
    border: "1px solid #d7d0c4",
    borderRadius: "8px",
    padding: "8px 10px",
    marginBottom: "8px",
    background: "#fbf8f2",
  });
  if (event.type === "turn_started") {
    const title = el(doc, "div", { fontWeight: "700" });
    title.textContent = "Task";
    const body = el(doc, "div");
    body.textContent = event.payload.userText;
    card.appendChild(title);
    card.appendChild(body);
    return card;
  }
  if (event.type === "tool_requested") {
    const title = el(doc, "div", { fontWeight: "700" });
    title.textContent = event.payload.toolName;
    const pre = el(doc, "pre", { whiteSpace: "pre-wrap", fontSize: "11px" });
    pre.textContent = JSON.stringify(event.payload.args, null, 2);
    card.appendChild(title);
    card.appendChild(pre);
    return card;
  }
  if (event.type === "tool_result") {
    const result = event.payload.result;
    const title = el(doc, "div", { fontWeight: "700" });
    title.textContent = `${result.toolName} · ${result.ok ? "ok" : result.code}`;
    const pre = el(doc, "pre", { whiteSpace: "pre-wrap", fontSize: "11px" });
    pre.textContent = JSON.stringify(
      result.ok ? result.data : result,
      null,
      2,
    ).slice(0, 4000);
    card.appendChild(title);
    card.appendChild(pre);
    return card;
  }
  if (event.type === "memory_updated") {
    const title = el(doc, "div", { fontWeight: "700", color: "#2f5d45" });
    title.textContent = `memory ${event.payload.op}${event.payload.title ? `: ${event.payload.title}` : ""}`;
    card.style.borderColor = "#cfd8d3";
    card.appendChild(title);
    return card;
  }
  if (event.type === "turn_failed") {
    card.textContent = `Failed ${event.payload.message}`;
    return card;
  }
  if (event.type === "turn_aborted") {
    card.textContent = "Stopped";
    card.style.color = "#8a5a12";
    return card;
  }
  if (event.type === "approval_required") {
    card.textContent = `Needs approval: ${event.payload.request.toolName}`;
    return card;
  }
  return null;
}
