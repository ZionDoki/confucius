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

type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  streamResponses: boolean;
  memoryAutoExtract: boolean;
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high";
  contextWindowTokens: number;
  hasApiKey: boolean;
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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Circular context-usage indicator for the composer. update() takes a 0..100
 * fill and a tooltip label like "8.2k / 32k tokens".
 */
function buildContextRing(doc: Document): {
  node: HTMLElement;
  update: (percent: number, label: string) => void;
} {
  const size = 30;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const node = el(
    doc,
    "div",
    {
      position: "relative",
      width: `${size}px`,
      height: `${size}px`,
      flex: "0 0 auto",
      cursor: "pointer",
      margin: "0 2px",
    },
    { id: "confucius-context-ring", title: "Context usage — click to compact" },
  ) as HTMLElement;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const bg = doc.createElementNS(SVG_NS, "circle");
  bg.setAttribute("cx", String(size / 2));
  bg.setAttribute("cy", String(size / 2));
  bg.setAttribute("r", String(radius));
  bg.setAttribute("fill", "none");
  bg.setAttribute("stroke", "#c4bdb3");
  bg.setAttribute("stroke-width", String(stroke));
  const fg = doc.createElementNS(SVG_NS, "circle");
  fg.setAttribute("cx", String(size / 2));
  fg.setAttribute("cy", String(size / 2));
  fg.setAttribute("r", String(radius));
  fg.setAttribute("fill", "none");
  fg.setAttribute("stroke", "#2f5d45");
  fg.setAttribute("stroke-width", String(stroke));
  fg.setAttribute("stroke-linecap", "round");
  fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  const text = doc.createElementNS(SVG_NS, "text");
  text.setAttribute("x", "50%");
  text.setAttribute("y", "54%");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "middle");
  text.setAttribute("font-size", "9");
  text.setAttribute("fill", "#1c1917");
  text.textContent = "0%";
  svg.appendChild(bg);
  svg.appendChild(fg);
  svg.appendChild(text);
  node.appendChild(svg);

  const update = (percent: number, label: string) => {
    const clamped = Math.max(0, Math.min(100, percent));
    fg.setAttribute(
      "stroke-dasharray",
      `${(clamped / 100) * circumference} ${circumference}`,
    );
    fg.setAttribute(
      "stroke",
      clamped >= 90 ? "#b42318" : clamped >= 70 ? "#c07f0a" : "#2f5d45",
    );
    text.textContent = `${Math.round(clamped)}%`;
    node.setAttribute("title", `${label} — click to compact`);
  };
  return { node, update };
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
    config: null as ModelConfig | null,
    running: false,
    permission: "ask" as "ask" | "auto_allow" | "deny",
    contextStats: null as
      | {
          tokensEstimate: number;
          contextWindowTokens: number;
          percent: number;
        }
      | null,
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
  modeBtn.style.display = "none";
  const settingsBtn = el(
    doc,
    "button",
    {
      background: "#6b645b",
      color: "#f6f3ec",
      border: "1px solid #57514a",
      borderRadius: "6px",
      padding: "6px 12px",
      cursor: "pointer",
      minHeight: "32px",
      font: "inherit",
    },
    { id: "confucius-settings", type: "button", title: "Model settings" },
  );
  settingsBtn.textContent = "⚙";
  topbar.appendChild(brand);
  topbar.appendChild(status);
  topbar.appendChild(newSessionBtn);
  topbar.appendChild(settingsBtn);

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
  stopBtn.style.display = "none";
  stopBtn.style.background = "#8a5a12";
  stopBtn.style.border = "1px solid #6f470e";

  const plusBtn = el(
    doc,
    "button",
    {
      flex: "0 0 auto",
      background: "#6b645b",
      color: "#f6f3ec",
      border: "1px solid #57514a",
      borderRadius: "6px",
      width: "40px",
      height: "40px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "18px",
    },
    { id: "confucius-plus", type: "button", title: "Mode, skills, model" },
  );
  plusBtn.textContent = "+";

  const contextRing = buildContextRing(doc);

  composer.appendChild(plusBtn);
  composer.appendChild(prompt);
  composer.appendChild(contextRing.node);
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
            state.permission =
              (loaded as { permissionMode?: string }).permissionMode ===
              "auto_allow"
                ? "auto_allow"
                : (loaded as { permissionMode?: string }).permissionMode ===
                    "deny"
                  ? "deny"
                  : "ask";
            syncModeButton();
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
    if (state.config && !state.config.hasApiKey) {
      const banner = el(doc, "div", {
        border: "1px solid #e8c37a",
        borderRadius: "8px",
        padding: "10px 12px",
        marginBottom: "8px",
        background: "#fff8e8",
        color: "#7c5a12",
      });
      const bannerText = el(doc, "div", { marginBottom: "6px" });
      bannerText.textContent = getString("workspace-config-banner");
      const configure = button(doc, "confucius-configure", getString("workspace-configure"));
      configure.addEventListener("click", () => openSettings());
      banner.appendChild(bannerText);
      banner.appendChild(configure);
      timelinePane.appendChild(banner);
    }
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
    if (state.config && !state.config.hasApiKey) {
      state.sendError = getString("workspace-config-banner");
      renderLists();
      openSettings();
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
      state.running = true;
      updateRunningUI();
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
      updateRunningUI();
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

  async function refreshConfig(): Promise<void> {
    try {
      state.config = (await rpc("config/get", {})) as ModelConfig;
    } catch {
      state.config = null;
    }
  }

  function openSettings(): void {
    const existing = doc.getElementById("confucius-settings-overlay");
    if (existing) {
      existing.remove();
      return;
    }
    const config = state.config;
    const overlay = el(
      doc,
      "div",
      {
        position: "fixed",
        inset: "0px",
        background: "rgba(28, 25, 23, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "1000",
      },
      { id: "confucius-settings-overlay" },
    );
    const panel = el(doc, "div", {
      background: "#ffffff",
      borderRadius: "10px",
      padding: "18px 20px",
      width: "440px",
      maxWidth: "90vw",
      maxHeight: "85vh",
      overflow: "auto",
      boxSizing: "border-box",
      font: '13px/1.5 "Segoe UI", "SF Pro Text", sans-serif',
      color: "#1c1917",
    });
    const title = el(doc, "div", {
      fontWeight: "700",
      fontSize: "15px",
      marginBottom: "12px",
    });
    title.textContent = getString("workspace-settings");
    panel.appendChild(title);

    const field = (
      label: string,
      id: string,
      value: string,
      type = "text",
    ) => {
      const row = el(doc, "div", { marginBottom: "10px" });
      const name = el(doc, "label", {
        display: "block",
        fontSize: "11px",
        color: "#6b645b",
        marginBottom: "3px",
      });
      name.textContent = label;
      const input = el(
        doc,
        "input",
        {
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          height: "32px",
          border: "1px solid #c4bdb3",
          borderRadius: "6px",
          padding: "0 8px",
          font: "inherit",
        },
        { id, type, value },
      ) as HTMLInputElement;
      row.appendChild(name);
      row.appendChild(input);
      panel.appendChild(row);
      return input;
    };

    field("Base URL (OpenAI-compatible /chat/completions, or Ollama /api/chat)", "confucius-cfg-baseUrl", config?.baseUrl ?? "");
    field("API key (ignored by local Ollama)", "confucius-cfg-apiKey", config?.apiKey ?? "", "password");
    field("Model", "confucius-cfg-model", config?.model ?? "");
    field("Max tokens (0 = provider default)", "confucius-cfg-maxTokens", String(config?.maxTokens ?? 0), "number");

    const check = (label: string, id: string, checked: boolean) => {
      const row = el(doc, "div", { marginBottom: "8px" });
      const input = el(
        doc,
        "input",
        { marginRight: "6px" },
        { id, type: "checkbox" },
      ) as HTMLInputElement;
      input.checked = checked;
      const text = doc.createElementNS(HTML_NS, "label") as HTMLElement;
      text.textContent = label;
      row.appendChild(input);
      row.appendChild(text);
      panel.appendChild(row);
      return input;
    };
    field("Context window (tokens, for the usage ring and compaction)", "confucius-cfg-contextWindowTokens", String(config?.contextWindowTokens ?? 32768), "number");
    const effortRow = el(doc, "div", { marginBottom: "10px" });
    const effortLabel = el(doc, "label", {
      display: "block",
      fontSize: "11px",
      color: "#6b645b",
      marginBottom: "3px",
    });
    effortLabel.textContent = "Thinking effort";
    const effortSelect = el(
      doc,
      "select",
      {
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        height: "32px",
        border: "1px solid #c4bdb3",
        borderRadius: "6px",
        background: "#ffffff",
        font: "inherit",
      },
      { id: "confucius-cfg-effort" },
    ) as HTMLSelectElement;
    for (const effort of ["auto", "off", "low", "medium", "high"]) {
      const option_ = el(doc, "option", undefined, { value: effort });
      option_.textContent = effort;
      effortSelect.appendChild(option_);
    }
    effortSelect.value = config?.reasoningEffort ?? "auto";
    effortRow.appendChild(effortLabel);
    effortRow.appendChild(effortSelect);
    panel.appendChild(effortRow);
    const stream = check("Stream model output live", "confucius-cfg-stream", config?.streamResponses !== false);
    const extract = check("Extract memories after each turn", "confucius-cfg-memory", config?.memoryAutoExtract !== false);

    const errorLine = el(doc, "div", {
      color: "#b42318",
      minHeight: "18px",
      marginBottom: "8px",
    });
    panel.appendChild(errorLine);

    const actions = el(doc, "div", { display: "flex", gap: "8px" });
    const save = button(doc, "confucius-cfg-save", getString("workspace-settings-save"));
    const cancel = button(doc, "confucius-cfg-cancel", getString("workspace-settings-cancel"));
    cancel.style.background = "#6b645b";
    cancel.style.border = "1px solid #57514a";
    actions.appendChild(save);
    actions.appendChild(cancel);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    });
    cancel.addEventListener("click", () => overlay.remove());
    save.addEventListener("click", () => {
      void (async () => {
        errorLine.textContent = "";
        try {
          const value = (id: string) =>
            (doc.getElementById(id) as HTMLInputElement | null)?.value ?? "";
          const next = (await rpc("config/set", {
            baseUrl: value("confucius-cfg-baseUrl"),
            apiKey: value("confucius-cfg-apiKey"),
            model: value("confucius-cfg-model"),
            maxTokens: Number(value("confucius-cfg-maxTokens")) || 0,
            contextWindowTokens:
              Number(value("confucius-cfg-contextWindowTokens")) || 32768,
            reasoningEffort: effortSelect.value,
            streamResponses: stream.checked,
            memoryAutoExtract: extract.checked,
          })) as ModelConfig;
          state.config = next;
          state.sendError = "";
          overlay.remove();
          renderLists();
        } catch (error) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      })();
    });
    const host = doc.body ?? doc.documentElement;
    if (host) {
      host.appendChild(overlay);
    }
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


  interface SlashCommand {
    label: string;
    description: string;
    run: () => void | Promise<void>;
  }

  const slashState = {
    open: false,
    items: [] as SlashCommand[],
    index: 0,
  };

  function slashCommands(): SlashCommand[] {
    const commands: SlashCommand[] = [
      {
        label: "/agent",
        description: getString("workspace-cmd-agent"),
        run: () => applyMode("agent"),
      },
      {
        label: "/plan",
        description: getString("workspace-cmd-plan"),
        run: () => applyMode("plan"),
      },
      {
        label: "/ask",
        description: getString("workspace-cmd-ask"),
        run: () => applyPermission("ask"),
      },
      {
        label: "/auto",
        description: getString("workspace-cmd-auto"),
        run: () => applyPermission("auto_allow"),
      },
      {
        label: "/deny-writes",
        description: getString("workspace-cmd-deny"),
        run: () => applyPermission("deny"),
      },
      {
        label: "/model",
        description: getString("workspace-cmd-model"),
        run: () => void refreshConfig().then(() => openSettings()),
      },
      {
        label: "/compact",
        description: getString("workspace-cmd-compact"),
        run: () => void compactNow(),
      },
    ];
    for (const skill of state.skills) {
      commands.push({
        label: `/${skill.slug}`,
        description: skill.name,
        run: () => applySkill(skill.slug),
      });
    }
    return commands;
  }

  function applyMode(mode: "agent" | "plan"): void {
    state.mode = mode;
    syncModeButton();
    if (state.sessionId) {
      void rpc("session/setMode", { sessionId: state.sessionId, mode });
    }
  }

  function applyPermission(mode: "ask" | "auto_allow" | "deny"): void {
    state.permission = mode;
    if (state.sessionId) {
      void rpc("session/setPermissions", {
        sessionId: state.sessionId,
        permissionMode: mode,
      });
    }
  }

  function applySkill(slug: string): void {
    state.skillSlug = state.skillSlug === slug ? "" : slug;
    if (state.sessionId) {
      void rpc("skill/activate", {
        sessionId: state.sessionId,
        slug: state.skillSlug || null,
      });
    }
  }

  async function compactNow(): Promise<void> {
    if (!state.sessionId) {
      return;
    }
    try {
      status.style.color = "#8a5a12";
      status.textContent = getString("workspace-compacting");
      const stats = (await rpc("session/compact", {
        sessionId: state.sessionId,
      })) as { percent: number; tokensEstimate: number; contextWindowTokens: number };
      state.contextStats = stats;
      contextRing.update(stats.percent, ringLabel(stats));
    } catch (error) {
      status.style.color = "#b42318";
      status.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }

  function ringLabel(stats: {
    tokensEstimate: number;
    contextWindowTokens: number;
  }): string {
    return `${fmtTokens(stats.tokensEstimate)} / ${fmtTokens(stats.contextWindowTokens)} tokens`;
  }

  function fmtTokens(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  }

  function updateSlashMenu(value: string): void {
    if (!value.startsWith("/")) {
      closeSlashMenu();
      return;
    }
    const query = value.slice(1).toLowerCase();
    slashState.items = slashCommands().filter((command) =>
      command.label.slice(1).toLowerCase().includes(query),
    );
    if (slashState.items.length === 0) {
      closeSlashMenu();
      return;
    }
    slashState.open = true;
    slashState.index = 0;
    renderSlashMenu();
  }

  function closeSlashMenu(): void {
    slashState.open = false;
    slashState.items = [];
    doc.getElementById("confucius-slash-menu")?.remove();
  }

  function renderSlashMenu(): void {
    doc.getElementById("confucius-slash-menu")?.remove();
    if (!slashState.open) {
      return;
    }
    const menu = el(
      doc,
      "div",
      {
        position: "absolute",
        left: "60px",
        right: "220px",
        bottom: "76px",
        background: "#ffffff",
        border: "1px solid #c4bdb3",
        borderRadius: "8px",
        boxShadow: "0 6px 18px rgba(28,25,23,0.18)",
        maxHeight: "260px",
        overflow: "auto",
        zIndex: "900",
      },
      { id: "confucius-slash-menu" },
    );
    slashState.items.forEach((command, index) => {
      const row = el(doc, "div", {
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        padding: "7px 10px",
        cursor: "pointer",
        background: index === slashState.index ? "#e4ddd0" : "transparent",
      });
      const label = el(doc, "span", { fontWeight: "600" });
      label.textContent = command.label;
      const hint = el(doc, "span", { color: "#6b645b", fontSize: "12px" });
      hint.textContent = command.description;
      row.appendChild(label);
      row.appendChild(hint);
      row.addEventListener("click", () => {
        slashState.index = index;
        runSlashSelection();
      });
      menu.appendChild(row);
    });
    (doc.body ?? doc.documentElement)?.appendChild(menu);
  }

  function runSlashSelection(): void {
    const command = slashState.items[slashState.index];
    closeSlashMenu();
    prompt.value = "";
    if (command) {
      void command.run();
    }
  }

  function togglePlusMenu(): void {
    const existing = doc.getElementById("confucius-plus-menu");
    if (existing) {
      existing.remove();
      return;
    }
    const menu = el(
      doc,
      "div",
      {
        position: "absolute",
        left: "14px",
        bottom: "76px",
        width: "300px",
        background: "#ffffff",
        border: "1px solid #c4bdb3",
        borderRadius: "8px",
        boxShadow: "0 6px 18px rgba(28,25,23,0.18)",
        padding: "10px 12px",
        zIndex: "900",
      },
      { id: "confucius-plus-menu" },
    );

    const section = (title: string) => {
      const label = el(doc, "div", {
        fontSize: "11px",
        color: "#6b645b",
        margin: "8px 0 4px",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
      });
      label.textContent = title;
      menu.appendChild(label);
    };
    const option = (
      label: string,
      active: boolean,
      onClick: () => void,
    ) => {
      const row = el(doc, "div", {
        padding: "5px 8px",
        borderRadius: "6px",
        cursor: "pointer",
        display: "flex",
        justifyContent: "space-between",
        background: active ? "#e4ddd0" : "transparent",
      });
      const text = el(doc, "span");
      text.textContent = label;
      row.appendChild(text);
      if (active) {
        const mark = el(doc, "span", { color: "#2f5d45", fontWeight: "700" });
        mark.textContent = "✓";
        row.appendChild(mark);
      }
      row.addEventListener("click", onClick);
      menu.appendChild(row);
    };

    section(getString("workspace-mode"));
    option("Agent", state.mode === "agent", () => {
      applyMode("agent");
      togglePlusMenu();
    });
    option("Plan (read-only)", state.mode === "plan", () => {
      applyMode("plan");
      togglePlusMenu();
    });

    section(getString("workspace-permissions"));
    option(
      getString("workspace-perm-ask"),
      state.permission === "ask",
      () => {
        applyPermission("ask");
        togglePlusMenu();
      },
    );
    option(
      getString("workspace-perm-auto"),
      state.permission === "auto_allow",
      () => {
        applyPermission("auto_allow");
        togglePlusMenu();
      },
    );
    option(
      getString("workspace-perm-deny"),
      state.permission === "deny",
      () => {
        applyPermission("deny");
        togglePlusMenu();
      },
    );

    section(getString("workspace-no-skill"));
    option(getString("workspace-skill-none"), state.skillSlug === "", () => {
      applySkill("");
      togglePlusMenu();
    });
    for (const skill of state.skills) {
      option(
        skill.name,
        state.skillSlug === skill.slug,
        () => {
          applySkill(skill.slug);
          togglePlusMenu();
        },
      );
    }

    section(getString("workspace-model"));
    const modelRow = el(doc, "div", {
      display: "flex",
      gap: "6px",
      alignItems: "center",
    });
    const modelName = el(doc, "span", {
      flex: "1 1 auto",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    modelName.textContent = state.config?.model || "—";
    const effortSelect = el(
      doc,
      "select",
      {
        height: "28px",
        border: "1px solid #c4bdb3",
        borderRadius: "6px",
        background: "#ffffff",
        font: "inherit",
      },
      { id: "confucius-effort" },
    ) as HTMLSelectElement;
    for (const effort of ["auto", "off", "low", "medium", "high"]) {
      const option_ = el(doc, "option", undefined, { value: effort });
      option_.textContent = effort;
      effortSelect.appendChild(option_);
    }
    effortSelect.value = state.config?.reasoningEffort ?? "auto";
    effortSelect.addEventListener("change", () => {
      void (async () => {
        try {
          state.config = (await rpc("config/set", {
            reasoningEffort: effortSelect.value,
          })) as ModelConfig;
        } catch {
          /* keep old value */
        }
      })();
    });
    const modelBtn = button(doc, "", "⚙");
    modelBtn.style.minHeight = "28px";
    modelBtn.style.padding = "2px 8px";
    modelBtn.addEventListener("click", () => {
      menu.remove();
      void refreshConfig().then(() => openSettings());
    });
    modelRow.appendChild(modelName);
    modelRow.appendChild(effortSelect);
    modelRow.appendChild(modelBtn);
    menu.appendChild(modelRow);

    menu.addEventListener("click", (event) => {
      if (event.target === menu) {
        menu.remove();
      }
    });
    (doc.body ?? doc.documentElement)?.appendChild(menu);
  }

  function isRunningFromEvents(events: ConfuciusEvent[]): boolean {
    let running = false;
    for (const event of events) {
      if (event.type === "turn_started") {
        running = true;
      } else if (
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_aborted"
      ) {
        running = false;
      }
    }
    return running;
  }

  function updateRunningUI(): void {
    const working = state.running || state.sending;
    sendBtn.style.display = working ? "none" : "";
    stopBtn.style.display = working ? "" : "none";
  }

  async function poll(): Promise<void> {
    try {
      if (!state.config) {
        await refreshConfig();
        renderLists();
      }
      if (!state.skills.length) {
        const listed = (await rpc("skill/list", {})) as {
          skills?: ConfuciusSkill[];
        };
        state.skills = listed.skills || [];
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
        const wasRunning = state.running;
        state.running = isRunningFromEvents(state.events);
        if (wasRunning !== state.running) {
          updateRunningUI();
        }
        try {
          const stats = (await rpc("session/context", {
            sessionId: state.sessionId,
          })) as {
            tokensEstimate: number;
            contextWindowTokens: number;
            percent: number;
          };
          state.contextStats = stats;
          contextRing.update(stats.percent, ringLabel(stats));
        } catch {
          /* stats are cosmetic */
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
  settingsBtn.addEventListener("click", () => {
    void refreshConfig().then(() => openSettings());
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (slashState.open) {
      runSlashSelection();
      return;
    }
    void sendPrompt();
  });
  sendBtn.addEventListener("click", (event) => {
    event.preventDefault();
    void sendPrompt();
  });
  stopBtn.addEventListener("click", () => {
    if (state.sessionId) {
      void rpc("session/abort", { sessionId: state.sessionId }).then(() => {
        state.running = false;
        updateRunningUI();
      });
    }
  });
  plusBtn.addEventListener("click", () => togglePlusMenu());
  contextRing.node.addEventListener("click", () => void compactNow());
  prompt.addEventListener("input", () => updateSlashMenu(prompt.value));
  prompt.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (slashState.open && (key === "ArrowDown" || key === "ArrowUp")) {
      event.preventDefault();
      slashState.index +=
        key === "ArrowDown" ? 1 : -1 + slashState.items.length * 2;
      slashState.index %= slashState.items.length;
      renderSlashMenu();
      return;
    }
    if (key === "Escape" && slashState.open) {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (slashState.open) {
        runSlashSelection();
        return;
      }
      void sendPrompt();
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
