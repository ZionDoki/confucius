(function (global) {
  if (global.ConfuciusWorkspace && global.ConfuciusWorkspace.rpc) {
    return;
  }

  function t(key, fallback) {
    const pack = global.ConfuciusI18n || {};
    return pack[key] || fallback;
  }

  function escapeMindMapHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function layoutIcon(target) {
    const divider = target === "sidebar" ? "M15 4v16" : "M3 8.5h18";
    const windowDot =
      target === "window"
        ? '<circle cx="6" cy="6.3" r="0.55" fill="currentColor" stroke="none"></circle>'
        : "";
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="${divider}"></path>${windowDot}</svg>`;
  }

  function settingsIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  }

  function knowledgeIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v5"></path><path d="M6 14v-1.5A2.5 2.5 0 0 1 8.5 10h7A2.5 2.5 0 0 1 18 12.5V14"></path><circle cx="12" cy="4" r="2"></circle><circle cx="6" cy="17" r="2"></circle><circle cx="12" cy="17" r="2"></circle><circle cx="18" cy="17" r="2"></circle></svg>';
  }

  function parseMindMapOutline(markdown) {
    const roots = [];
    const stack = [];
    let headingDepth = -1;
    let sequence = 0;
    for (const raw of String(markdown || "")
      .replace(/\r\n/g, "\n")
      .split("\n")) {
      if (!raw.trim() || /^\s*```/.test(raw)) continue;
      const heading = raw.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      const bullet = raw.match(/^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/);
      let depth;
      let label;
      if (heading) {
        depth = heading[1].length - 1;
        headingDepth = depth;
        label = cleanMindMapLabel(heading[2]);
      } else if (bullet) {
        const indent = bullet[1].replace(/\t/g, "  ").length;
        depth = Math.max(0, headingDepth + 1 + Math.floor(indent / 2));
        label = cleanMindMapLabel(bullet[2]);
      } else {
        depth = Math.max(0, headingDepth + 1);
        label = cleanMindMapLabel(raw.trim());
      }
      if (!label) continue;
      const node = {
        id: "mind-node-" + ++sequence,
        label,
        level: depth,
        children: [],
      };
      while (stack.length && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }
      const parent = stack.length ? stack[stack.length - 1].node : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push({ depth, node });
    }
    return roots;
  }

  function cleanMindMapLabel(value) {
    return String(value || "")
      .replace(/^\s*\[[ xX]\]\s*/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
  }

  function mindMapTreeHtml(nodes) {
    if (!nodes.length) {
      return `<p class="muted">${escapeMindMapHtml(
        t(
          "knowledgeMindMapEmpty",
          "Use # headings and indented - bullets; the tree preview updates here.",
        ),
      )}</p>`;
    }
    return `<ul>${nodes
      .map((node) => {
        const label = escapeMindMapHtml(node.label);
        return `<li>${
          node.children.length
            ? `<details open><summary>${label}</summary>${mindMapTreeHtml(
                node.children,
              )}</details>`
            : label
        }</li>`;
      })
      .join("")}</ul>`;
  }

  function zoteroHost() {
    try {
      if (typeof Zotero !== "undefined" && Zotero && Zotero.Confucius) {
        return Zotero.Confucius;
      }
    } catch {
      // Privileged windows may not expose Zotero as a lexical binding.
    }
    try {
      if (global.Zotero && global.Zotero.Confucius) {
        return global.Zotero.Confucius;
      }
    } catch {
      // Ignore.
    }
    try {
      if (global.ConfuciusHost) {
        return global.ConfuciusHost;
      }
    } catch {
      // Ignore.
    }
    try {
      if (
        global.opener &&
        global.opener.Zotero &&
        global.opener.Zotero.Confucius
      ) {
        return global.opener.Zotero.Confucius;
      }
    } catch {
      // Ignore.
    }
    return null;
  }

  function boot() {
    const root = document.getElementById("confucius-root");
    if (!root || root.getAttribute("data-confucius-booted") === "1") {
      return;
    }
    root.setAttribute("data-confucius-booted", "1");

    const state = {
      sessions: [],
      sessionId: null,
      events: [],
      lastEventId: null,
      skills: [],
      skillSlug: "",
      approvals: [],
      memories: [],
      logCount: 0,
      mode: "agent",
      config: null,
      sendError: "",
      sending: false,
      pendingUserText: "",
      settingsOpen: false,
      settingsEditingId: "",
      running: false,
      permission: "ask",
      contextStats: null,
      promptDraft: "",
      slash: { open: false, items: [], index: 0 },
      plusOpen: false,
      modelMenu: { open: false, submenu: null },
      modelLists: {},
      timelineFold: { reasoning: {}, toolsOpen: {}, toolOpen: {} },
      layout: "sidebar",
      showSessions: false,
      showReview: false,
      knowledgeOpen: false,
      knowledgeLoading: false,
      knowledgeBases: [],
      knowledgeBase: null,
      knowledgeBaseId: "",
      knowledgeEntryId: "",
      knowledgeFilter: "all",
      knowledgeEditor: "empty",
      knowledgeCreatingBase: false,
      knowledgeError: "",
    };
    let pendingPermissionUpdate = Promise.resolve();
    try {
      const stored = global.localStorage
        ? global.localStorage.getItem("confuciusLayout")
        : "";
      if (stored === "sidebar" || stored === "full") {
        state.layout = stored;
      }
    } catch {
      // ignore
    }
    if (state.layout === "sidebar" || global.innerWidth <= 640) {
      state.showSessions = false;
      state.showReview = false;
    }

    async function rpc(method, params) {
      const host = zoteroHost();
      if (host && typeof host.rpc === "function") {
        return host.rpc(method, params || {});
      }
      let token = "";
      try {
        token = global.localStorage
          ? global.localStorage.getItem("confuciusToken") || ""
          : "";
      } catch {
        token = "";
      }
      const bridge = global.ConfuciusBridge;
      if (!bridge || typeof bridge.request !== "function") {
        throw new Error("Confucius bridge discovery is unavailable");
      }
      const response = await bridge.request("/confucius/v1/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "rpc error");
      return body.result;
    }

    function render() {
      const session = state.sessions.find(
        (item) => item.id === state.sessionId,
      );
      const layoutTarget = state.layout === "sidebar" ? "window" : "sidebar";
      const layoutActionLabel =
        layoutTarget === "window"
          ? t("layoutFull", "Full")
          : t("layoutSidebar", "Sidebar");
      const settingsLabel = t("settingsTitle", "Model settings");
      const knowledgeLabel = t("knowledgeTitle", "Research knowledge base");
      root.className =
        "workspace" +
        (state.layout === "sidebar" ? " layout-sidebar" : "") +
        (state.showSessions ? " show-sessions" : "") +
        (state.showReview ? " show-review" : "");
      const timelinePane = root.querySelector("main.pane");
      const followTimeline =
        Boolean(state.sending || state.running || state.pendingUserText) ||
        (timelinePane
          ? timelinePane.scrollHeight -
              timelinePane.scrollTop -
              timelinePane.clientHeight <
            96
          : true);
      const savedTimelineScroll = timelinePane ? timelinePane.scrollTop : 0;
      root.innerHTML = `
      <div class="topbar">
        <div class="topbar-brand">
          <strong>Confucius</strong>
          <span id="conn" class="status wait">${escapeHtml(
            t("connecting", "Connecting"),
          )}</span>
        </div>
        <div class="topbar-actions">
          <button id="new-session" type="button" aria-label="${escapeHtml(
            t("newSession", "New session"),
          )}" title="${escapeHtml(t("newSession", "New session"))}">${escapeHtml(
            t("newSession", "New session"),
          )}</button>
          <button id="toggle-sessions" type="button" class="secondary" aria-pressed="${
            state.showSessions ? "true" : "false"
          }" aria-label="${escapeHtml(t("sessions", "Sessions"))}">${escapeHtml(
            t("sessions", "Sessions"),
          )}</button>
          <button id="toggle-review" type="button" class="secondary" aria-pressed="${
            state.showReview ? "true" : "false"
          }" aria-label="${escapeHtml(t("review", "Review"))}">${escapeHtml(
            t("review", "Review"),
          )}</button>
          <button id="knowledge" type="button" class="icon-button" title="${escapeHtml(
            knowledgeLabel,
          )}" aria-label="${escapeHtml(knowledgeLabel)}">${knowledgeIcon()}</button>
          <button id="layout" type="button" class="icon-button" title="${escapeHtml(
            layoutActionLabel,
          )}" aria-label="${escapeHtml(layoutActionLabel)}">${layoutIcon(
            layoutTarget,
          )}</button>
          <button id="settings" type="button" class="icon-button" title="${escapeHtml(
            settingsLabel,
          )}" aria-label="${escapeHtml(settingsLabel)}">${settingsIcon()}</button>
          <select id="skill" aria-label="${escapeHtml(t("noSkill", "No skill"))}">
            <option value="">${escapeHtml(t("noSkill", "No skill"))}</option>
            ${state.skills
              .map(
                (skill) =>
                  `<option value="${escapeHtml(skill.slug)}" ${
                    skill.slug === state.skillSlug ? "selected" : ""
                  }>${escapeHtml(skill.name)}</option>`,
              )
              .join("")}
          </select>
        </div>
      </div>
      <aside class="pane">
        <div class="pane-label">${escapeHtml(t("sessions", "Sessions"))}</div>
        ${
          state.sessions
            .map(
              (item) =>
                `<div class="session-row"><div class="session ${
                  item.id === state.sessionId ? "active" : ""
                }" data-id="${escapeHtml(item.id)}">${escapeHtml(
                  item.title || item.id,
                )}</div><button class="unstyled danger" data-delete="${escapeHtml(
                  item.id,
                )}" title="Delete session" type="button">✕</button></div>`,
            )
            .join("") ||
          `<p class="muted">${escapeHtml(t("noSessions", "No sessions yet."))}</p>`
        }
      </aside>
      <main class="pane">
        <div class="pane-label">${escapeHtml(t("timeline", "Timeline"))}${session ? " · " + escapeHtml(session.title) : ""}</div>
        ${
          state.config && !configReady(state.config)
            ? `<div class="event config-banner">${escapeHtml(
                t(
                  "configBanner",
                  "Model not configured. Set Base URL and model to start; API key is optional for local Ollama.",
                ),
              )} <button id="configure" type="button">Configure now</button></div>`
            : ""
        }
        ${state.sendError ? `<div class="tui tui-error">${escapeHtml(state.sendError)}</div>` : ""}
        ${state.pendingUserText ? `<div class="tui tui-user">${escapeHtml("› " + state.pendingUserText)}</div>` : ""}
        ${
          coalesceTimeline(state.events)
            .map((item, index) => renderTimelineBlock(item, index))
            .join("") ||
          (state.pendingUserText || state.sendError
            ? ""
            : `<p class="muted">${escapeHtml(
                t("emptyTimeline", "Describe a research task to start."),
              )}</p>`)
        }
        ${
          state.sending || state.running
            ? `<div class="tui tui-waiting-wrap"><div class="tui-waiting">${escapeHtml(
                t("waitingModel", "Waiting for the model…"),
              )}</div><div class="tui-waiting-bar"></div></div>`
            : ""
        }
      </main>
      <aside class="pane pane-review">
        <div class="pane-label">${escapeHtml(t("review", "Review"))}</div>
        ${
          state.approvals
            .map(
              (item) => `
            <div class="event approval">
              <div>${escapeHtml(item.toolName)}</div>
              <pre>${escapeHtml(JSON.stringify(item.args, null, 2))}</pre>
              <button data-allow="${escapeHtml(item.id)}" type="button">Allow</button>
              <button data-always="${escapeHtml(item.id)}" type="button" class="secondary">Always</button>
              <button data-deny="${escapeHtml(item.id)}" type="button">Deny</button>
            </div>`,
            )
            .join("") ||
          `<p class="muted">${escapeHtml(
            t("emptyReview", "Write actions wait here for approval."),
          )}</p>`
        }
        <div class="pane-label">${escapeHtml(t("memory", "Memory"))}</div>
        ${
          state.logCount
            ? `<p class="muted">${state.logCount} ${escapeHtml(
                t("sessionLogs", "session logs on disk"),
              )}</p>`
            : ""
        }
        ${
          state.memories
            .map((memory) => {
              const tags = memory.tags || [];
              const pinned = tags.indexOf("confucius:pinned") >= 0;
              const fromLog = tags.indexOf("promoted-from-log") >= 0;
              return `
            <div class="event memory">
              <div class="memory-title">${pinned ? "★ " : ""}[${escapeHtml(memory.type)}] ${escapeHtml(
                durableMemoryText(memory.title),
              )}${
                fromLog ? ` · ${escapeHtml(t("fromLog", "from log"))}` : ""
              }</div>
              <div>${escapeHtml(durableMemoryText(memory.content))}</div>
              <button class="unstyled danger" data-forget="${escapeHtml(
                memory.id,
              )}" type="button">forget</button>
            </div>`;
            })
            .join("") ||
          `<p class="muted">${escapeHtml(
            t("noMemory", "No memories yet."),
          )}</p>`
        }
      </aside>
      ${settingsOverlayHtml()}
      ${knowledgeWindowHtml()}
      ${slashMenuHtml()}
      ${plusMenuHtml()}
      ${modelMenuHtml()}
      <footer class="composer">
        <button id="plus" type="button" class="plus" title="Mode, skills, permissions">+</button>
        <input id="prompt" placeholder="${escapeHtml(
          t("placeholder", "Describe a research task… (type / for commands)"),
        )}" />
        <button id="endpoint" type="button" class="model-picker" title="${escapeHtml(
          modelPickerTitle(),
        )}" aria-haspopup="menu" aria-expanded="${state.modelMenu.open ? "true" : "false"}">
          <span class="model-picker-name">${escapeHtml(modelPickerLabel())}</span>
          <span class="model-picker-chevron">▾</span>
        </button>
        <div id="context-ring" class="context-ring" title="Context usage — click to compact">
          <svg width="30" height="30" viewBox="0 0 30 30">
            <circle cx="15" cy="15" r="12" fill="none" stroke="#3d5248" stroke-width="3" />
            <circle id="context-arc" cx="15" cy="15" r="12" fill="none" stroke="#8fbf7a"
              stroke-width="3" stroke-linecap="round"
              stroke-dasharray="0 75.4" transform="rotate(-90 15 15)" />
            <text id="context-label" x="15" y="16" text-anchor="middle"
              dominant-baseline="middle" font-size="9" fill="#f4efe6">0%</text>
          </svg>
        </div>
        <button id="send" type="button">${escapeHtml(t("send", "Send"))}</button>
        <button id="stop" type="button" style="display:none">${escapeHtml(t("stop", "Stop"))}</button>
      </footer>
    `;

      const nextTimeline = root.querySelector("main.pane");
      if (nextTimeline) {
        nextTimeline.scrollTop = followTimeline
          ? nextTimeline.scrollHeight
          : savedTimelineScroll;
      }

      const renderedPrompt = root.querySelector("#prompt");
      if (renderedPrompt) {
        renderedPrompt.value = state.promptDraft || "";
      }
      const layoutBtn = root.querySelector("#layout");
      if (layoutBtn) {
        layoutBtn.onclick = () => {
          state.layout = state.layout === "sidebar" ? "full" : "sidebar";
          if (state.layout === "sidebar") {
            state.showSessions = false;
            state.showReview = false;
          } else {
            state.showSessions = true;
            state.showReview = true;
          }
          try {
            if (global.localStorage) {
              global.localStorage.setItem("confuciusLayout", state.layout);
            }
          } catch {
            // ignore
          }
          render();
        };
      }
      const toggleSessions = root.querySelector("#toggle-sessions");
      if (toggleSessions) {
        toggleSessions.onclick = () => {
          state.showSessions = !state.showSessions;
          if (
            state.showSessions &&
            (state.layout === "sidebar" || global.innerWidth <= 640)
          ) {
            state.showReview = false;
          }
          render();
        };
      }
      const toggleReview = root.querySelector("#toggle-review");
      if (toggleReview) {
        toggleReview.onclick = () => {
          state.showReview = !state.showReview;
          if (
            state.showReview &&
            (state.layout === "sidebar" || global.innerWidth <= 640)
          ) {
            state.showSessions = false;
          }
          render();
        };
      }
      const newSession = root.querySelector("#new-session");
      if (newSession) {
        newSession.onclick = async () => {
          const created = await rpc("session/new", { title: "Untitled" });
          state.sessionId = created.id;
          state.events = [];
          state.lastEventId = null;
          state.mode = "agent";
          state.running = false;
          state.sendError = "";
          state.pendingUserText = "";
          await refreshSessions();
          render();
        };
      }
      const modeBtn = root.querySelector("#mode");
      if (modeBtn) {
        modeBtn.onclick = async () => {
          if (!state.sessionId) return;
          state.mode = state.mode === "plan" ? "agent" : "plan";
          render();
          await rpc("session/setMode", {
            sessionId: state.sessionId,
            mode: state.mode,
          });
        };
      }
      const send = root.querySelector("#send");
      if (send) send.onclick = sendPrompt;
      const prompt = root.querySelector("#prompt");
      if (prompt) {
        prompt.addEventListener("input", (event) => {
          state.promptDraft = event.target.value;
          updateSlashMenu(state.promptDraft);
        });
        prompt.addEventListener("keydown", (event) => {
          if (
            state.slash.open &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const count = state.slash.items.length;
            state.slash.index = (state.slash.index + delta + count) % count;
            render();
            return;
          }
          if (event.key === "Escape" && state.modelMenu.open) {
            event.preventDefault();
            state.modelMenu.open = false;
            render();
            return;
          }
          if (event.key === "Escape" && state.slash.open) {
            event.preventDefault();
            state.slash = { open: false, items: [], index: 0 };
            render();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (state.slash.open) {
              runSlashSelection();
              return;
            }
            sendPrompt();
          }
        });
      }
      const stop = root.querySelector("#stop");
      if (stop) {
        stop.onclick = async () => {
          if (state.sessionId) {
            await rpc("session/abort", { sessionId: state.sessionId });
            state.running = false;
            updateSendStopButtons();
          }
        };
      }
      bindComposer();
      bindTimeline();
      typesetMath(root);
      bindSettings();
      bindKnowledgeWindow();
      updateContextRing();
      updateSendStopButtons();
      const skill = root.querySelector("#skill");
      if (skill) {
        skill.onchange = async (event) => {
          state.skillSlug = event.target.value;
          if (state.sessionId) {
            await rpc("skill/activate", {
              sessionId: state.sessionId,
              slug: state.skillSlug || null,
            });
          }
        };
      }
      root.querySelectorAll(".session").forEach((node) => {
        node.onclick = async () => {
          const selectedSessionId = node.getAttribute("data-id");
          state.sessionId = selectedSessionId;
          state.lastEventId = null;
          state.running = false;
          state.pendingUserText = "";
          const loaded = await rpc("session/load", {
            sessionId: selectedSessionId,
          });
          if (state.sessionId !== selectedSessionId) return;
          state.skillSlug = loaded.skillSlug || state.skillSlug;
          state.mode = loaded.mode === "plan" ? "plan" : "agent";
          state.permission =
            loaded.permissionMode === "auto_allow" ||
            loaded.permissionMode === "deny"
              ? loaded.permissionMode
              : "ask";
          const bundle = await rpc("session/events", {
            sessionId: selectedSessionId,
          });
          if (state.sessionId !== selectedSessionId) return;
          state.events = mergeEvents([], bundle.events || [], true);
          if (state.events.length) {
            state.lastEventId = state.events[state.events.length - 1].id;
          }
          collectApprovals();
          state.running = isRunningFromEvents(state.events);
          if (state.layout === "sidebar" || global.innerWidth <= 640) {
            state.showSessions = false;
          }
          render();
        };
      });
      root.querySelectorAll("[data-delete]").forEach((node) => {
        node.onclick = async (event) => {
          event.stopPropagation();
          const id = node.getAttribute("data-delete");
          await rpc("session/delete", { sessionId: id });
          if (state.sessionId === id) {
            state.sessionId = null;
            state.events = [];
            state.lastEventId = null;
            state.running = false;
            state.pendingUserText = "";
          }
          await refreshSessions();
          render();
        };
      });
      root.querySelectorAll("[data-allow]").forEach((node) => {
        node.onclick = () =>
          resolveApproval(node.getAttribute("data-allow"), "allow", "once");
      });
      root.querySelectorAll("[data-always]").forEach((node) => {
        node.onclick = () =>
          resolveApproval(node.getAttribute("data-always"), "allow", "always");
      });
      root.querySelectorAll("[data-deny]").forEach((node) => {
        node.onclick = () =>
          resolveApproval(node.getAttribute("data-deny"), "deny", "once");
      });
      root.querySelectorAll("[data-forget]").forEach((node) => {
        node.onclick = async () => {
          await rpc("memory/delete", { id: node.getAttribute("data-forget") });
          await refreshMemories();
          render();
        };
      });
    }

    function nextReasoningFold(current) {
      if (!current || current === "preview") return "open";
      if (current === "open") return "compact";
      return "open";
    }

    function toolsSummary(calls) {
      return calls
        .map((call) => call.toolName)
        .filter(Boolean)
        .join(" · ");
    }

    function toolLineStatus(call) {
      if (!call.result) return call.progress || "…";
      return call.result.ok ? "ok" : call.result.code;
    }

    function formatToolResult(call) {
      if (!call.result) return call.progress || "";
      if (call.result.ok) {
        return JSON.stringify(call.result.data, null, 2).slice(0, 4000);
      }
      return JSON.stringify(call.result, null, 2).slice(0, 4000);
    }

    function attachCall(tools, callId) {
      return (tools || []).find((call) => call.callId === callId) || null;
    }

    function coalesceTimeline(events) {
      const blocks = [];
      let text = "";
      let reasoning = "";
      let tools = [];
      const flushText = () => {
        if (text) {
          blocks.push({ kind: "text", text });
          text = "";
        }
      };
      const flushPending = () => {
        if (reasoning) {
          blocks.push({ kind: "reasoning", text: reasoning });
          reasoning = "";
        }
        if (tools.length) {
          blocks.push({ kind: "tools", calls: tools });
          tools = [];
        }
      };
      const flushAnswer = () => {
        flushPending();
        flushText();
      };
      for (const event of events) {
        if (event.type === "text_delta") {
          flushPending();
          text += event.payload.text;
          continue;
        }
        if (event.type === "reasoning_delta") {
          flushText();
          reasoning += event.payload.text;
          continue;
        }
        if (event.type === "tool_requested") {
          flushText();
          tools.push({
            callId: event.payload.callId,
            toolName: event.payload.toolName,
            args: event.payload.args,
          });
          continue;
        }
        if (event.type === "tool_result") {
          flushText();
          const existing = attachCall(tools, event.payload.callId);
          if (existing) {
            existing.result = event.payload.result;
            continue;
          }
          tools.push({
            callId: event.payload.callId,
            toolName: event.payload.result.toolName,
            args: {},
            result: event.payload.result,
          });
          continue;
        }
        if (event.type === "tool_progress") {
          const existing = attachCall(tools, event.payload.callId);
          if (existing) existing.progress = event.payload.message;
          continue;
        }
        if (event.type === "turn_started") {
          flushAnswer();
          blocks.push({ kind: "user", text: event.payload.userText });
          continue;
        }
        if (event.type === "memory_updated") {
          flushAnswer();
          blocks.push({
            kind: "status",
            text:
              "memory " +
              event.payload.op +
              (event.payload.title ? ": " + event.payload.title : ""),
          });
          continue;
        }
        if (event.type === "turn_failed") {
          flushAnswer();
          blocks.push({
            kind: "status",
            tone: "fail",
            text: event.payload.message,
          });
          continue;
        }
        if (event.type === "turn_aborted") {
          flushAnswer();
          blocks.push({ kind: "status", text: "Stopped" });
          continue;
        }
      }
      flushAnswer();
      return blocks;
    }

    function renderAnswerHtml(text) {
      const md = global.ConfuciusMarkdown;
      if (md && typeof md.renderMarkdownHtml === "function") {
        return md.renderMarkdownHtml(text);
      }
      return escapeHtml(text).replace(/\n/g, "<br/>");
    }

    function typesetMath(scope) {
      const katexApi = global.katex;
      if (!katexApi || !scope) return;
      scope.querySelectorAll(".tui-math").forEach((el) => {
        const tex = el.getAttribute("data-tex") || el.textContent || "";
        const display = el.getAttribute("data-display") === "1";
        try {
          el.innerHTML = katexApi.renderToString(tex, {
            throwOnError: false,
            displayMode: display,
            output: "mathml",
          });
        } catch {
          el.textContent = tex;
        }
      });
    }

    function renderTimelineBlock(block, index) {
      if (block.kind === "user") {
        return `<div class="tui tui-user">${escapeHtml("› " + block.text)}</div>`;
      }
      if (block.kind === "text") {
        return `<div class="tui tui-answer">${renderAnswerHtml(block.text)}</div>`;
      }
      if (block.kind === "reasoning") {
        const key = "reasoning:" + index;
        const fold = state.timelineFold.reasoning[key] || "preview";
        const clamp =
          fold === "preview"
            ? " tui-clamp-3"
            : fold === "compact"
              ? " tui-clamp-1"
              : "";
        return `
          <div class="tui tui-thinking" data-reasoning="${escapeHtml(key)}">
            <div class="tui-thinking-head">${fold === "open" ? "▾" : "▸"} ${escapeHtml(
              t("tuiThinking", "Thinking"),
            )}</div>
            <div class="tui-thinking-clip${clamp}"><div class="tui-thinking-body">${escapeHtml(
              block.text,
            )}</div></div>
          </div>`;
      }
      if (block.kind === "tools") {
        const key =
          "tools:" + ((block.calls[0] && block.calls[0].callId) || index);
        const open = Boolean(state.timelineFold.toolsOpen[key]);
        const names = toolsSummary(block.calls);
        const rows = open
          ? block.calls
              .map((call) => {
                const expanded = Boolean(
                  state.timelineFold.toolOpen[call.callId],
                );
                return `
                <div class="tui-tool" data-tool="${escapeHtml(call.callId)}">
                  ${expanded ? "▾" : "▸"} ${escapeHtml(call.toolName)}  ${escapeHtml(
                    toolLineStatus(call),
                  )}
                </div>
                ${
                  expanded
                    ? `<pre class="tui-tool-result">${escapeHtml(
                        formatToolResult(call),
                      )}</pre>`
                    : ""
                }`;
              })
              .join("")
          : "";
        return `
          <div class="tui tui-tools">
            <div class="tui-tools-head" data-tools="${escapeHtml(key)}">
              ${open ? "▾" : "▸"} ${block.calls.length} ${escapeHtml(
                t("tuiTools", "tools"),
              )}${names ? "  " + escapeHtml(names) : ""}
            </div>
            ${rows}
          </div>`;
      }
      return `<div class="tui tui-status${
        block.tone === "fail" ? " tui-error" : ""
      }">${escapeHtml(block.text)}</div>`;
    }

    function bindTimeline() {
      root.querySelectorAll("[data-reasoning]").forEach((node) => {
        node.onclick = () => {
          const key = node.getAttribute("data-reasoning");
          state.timelineFold.reasoning[key] = nextReasoningFold(
            state.timelineFold.reasoning[key],
          );
          render();
        };
      });
      root.querySelectorAll("[data-tools]").forEach((node) => {
        node.onclick = () => {
          const key = node.getAttribute("data-tools");
          state.timelineFold.toolsOpen[key] =
            !state.timelineFold.toolsOpen[key];
          render();
        };
      });
      root.querySelectorAll("[data-tool]").forEach((node) => {
        node.onclick = (event) => {
          event.stopPropagation();
          const id = node.getAttribute("data-tool");
          state.timelineFold.toolOpen[id] = !state.timelineFold.toolOpen[id];
          render();
        };
      });
    }

    function collectApprovals() {
      const hadPendingApprovals = state.approvals.length > 0;
      const open = new Map();
      for (const event of state.events) {
        if (event.type === "approval_required") {
          open.set(event.payload.request.id, event.payload.request);
        }
        if (event.type === "approval_resolved") {
          open.delete(event.payload.resolution.id);
        }
      }
      state.approvals = [...open.values()];
      if (!hadPendingApprovals && state.approvals.length > 0) {
        state.showReview = true;
        if (state.layout === "sidebar" || global.innerWidth <= 640) {
          state.showSessions = false;
        }
      }
    }

    // Poll responses can overlap with a send/load snapshot. Keep one copy of
    // each event so a slow poll never renders the same prompt indefinitely.
    function eventKey(event) {
      let payload = "";
      try {
        payload = JSON.stringify(event.payload) || "";
      } catch {
        payload = String(event.payload);
      }
      return (
        String(event.id || "") +
        "\u0000" +
        String(event.turnId || "") +
        "\u0000" +
        String(event.type || "") +
        "\u0000" +
        payload
      );
    }

    function mergeEvents(existing, incoming, replace) {
      const merged = [];
      const seen = new Set();
      const source = replace ? incoming : existing.concat(incoming);
      for (const event of source) {
        const key = eventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(event);
      }
      return merged;
    }

    async function sendPrompt() {
      const input = root.querySelector("#prompt");
      const draft =
        input && input.value != null ? input.value : state.promptDraft;
      const text = draft ? draft.trim() : "";
      if (!text || state.sending || state.running) return;
      if (state.slash.open) {
        runSlashSelection();
        return;
      }
      if (state.config && !configReady(state.config)) {
        state.sendError = t(
          "configBanner",
          "Model not configured. Set Base URL and model to start; API key is optional for local Ollama.",
        );
        render();
        openSettings();
        return;
      }
      state.sending = true;
      state.sendError = "";
      state.pendingUserText = text;
      render();
      try {
        if (!state.sessionId) {
          const created = await rpc("session/new", {
            title: text.slice(0, 72),
          });
          state.sessionId = created.id;
          state.events = [];
          state.lastEventId = null;
          state.running = false;
        }
        if (state.skillSlug) {
          await rpc("skill/activate", {
            sessionId: state.sessionId,
            slug: state.skillSlug,
          });
        }
        // Keep a rapid permission selection + Send in order. The host must
        // receive the visible mode before it accepts the prompt.
        await pendingPermissionUpdate;
        const promptSessionId = state.sessionId;
        const started = await rpc("session/prompt", {
          sessionId: promptSessionId,
          text,
        });
        if (state.sessionId !== promptSessionId) {
          if (state.pendingUserText === text) state.pendingUserText = "";
          return;
        }
        // Clear only the value that was submitted. A user may have edited the
        // composer while the RPC was waiting for the host to accept the turn.
        if (state.promptDraft.trim() === text) {
          if (input) input.value = "";
          state.promptDraft = "";
        }
        state.pendingUserText = "";
        state.running = !started.superseded;
        updateSendStopButtons();
        await refreshSessions();
        const requestedCursor = state.lastEventId;
        const bundle = await rpc("session/events", {
          sessionId: promptSessionId,
        });
        if (state.sessionId !== promptSessionId) {
          if (state.pendingUserText === text) state.pendingUserText = "";
          return;
        }
        const incoming = bundle.events || [];
        state.events = mergeEvents(state.events, incoming);
        if (incoming.length && state.lastEventId === requestedCursor) {
          state.lastEventId = incoming[incoming.length - 1].id;
          state.running = isRunningFromEvents(state.events);
        }
      } catch (error) {
        state.sendError = (error && error.message) || "send failed";
      } finally {
        state.sending = false;
        render();
      }
    }

    function slashCommands() {
      const commands = [
        {
          label: "/agent",
          description: t("cmdAgent", "Switch to Agent mode"),
          run: () => applyMode("agent"),
        },
        {
          label: "/plan",
          description: t("cmdPlan", "Switch to Plan mode (read-only)"),
          run: () => applyMode("plan"),
        },
        {
          label: "/ask",
          description: t("cmdAsk", "Ask before every write"),
          run: () => applyPermission("ask"),
        },
        {
          label: "/auto",
          description: t("cmdAuto", "Full auto — allow all tool writes"),
          run: () => applyPermission("auto_allow"),
        },
        {
          label: "/deny-writes",
          description: t("cmdDeny", "Deny all tool writes"),
          run: () => applyPermission("deny"),
        },
        {
          label: "/model",
          description: t("cmdModel", "Open model settings"),
          run: () => openSettings(),
        },
        {
          label: "/compact",
          description: t("cmdCompact", "Compact the conversation now"),
          run: () => compactNow(),
        },
      ];
      for (const skill of state.skills) {
        commands.push({
          label: "/" + skill.slug,
          description: skill.name,
          run: () => applySkill(skill.slug),
        });
      }
      return commands;
    }

    function slashMenuHtml() {
      if (!state.slash.open) return "";
      const rows = state.slash.items
        .map(
          (command, index) => `
          <div class="slash-row ${index === state.slash.index ? "active" : ""}" data-slash="${index}">
            <span class="slash-label">${escapeHtml(command.label)}</span>
            <span class="slash-hint">${escapeHtml(command.description)}</span>
          </div>`,
        )
        .join("");
      return `<div id="slash-menu" class="slash-menu">${rows}</div>`;
    }

    function plusMenuHtml() {
      if (!state.plusOpen) return "";
      const option = (label, active, attr, value) => `
        <div class="plus-option ${active ? "active" : ""}" data-plus="${escapeHtml(attr)}" data-value="${escapeHtml(value)}">
          <span>${escapeHtml(label)}</span>${active ? '<span class="plus-mark">✓</span>' : ""}
        </div>`;
      const skillRows = state.skills
        .map((skill) =>
          option(
            skill.name,
            state.skillSlug === skill.slug,
            "skill",
            skill.slug,
          ),
        )
        .join("");
      return `
      <div id="plus-menu" class="plus-menu">
        <div class="plus-section">${escapeHtml(t("mode", "Mode"))}</div>
        ${option("Agent", state.mode === "agent", "mode", "agent")}
        ${option("Plan (read-only)", state.mode === "plan", "mode", "plan")}
        <div class="plus-section">${escapeHtml(t("permissions", "Permissions"))}</div>
        ${option(t("permAsk", "Ask before writes"), state.permission === "ask", "perm", "ask")}
        ${option(t("permAuto", "Full auto"), state.permission === "auto_allow", "perm", "auto_allow")}
        ${option(t("permDeny", "Deny writes"), state.permission === "deny", "perm", "deny")}
        <div class="plus-section">${escapeHtml(t("noSkill", "No skill"))}</div>
        ${option(t("skillNone", "No skill"), state.skillSlug === "", "skill", "")}
        ${skillRows}
      </div>`;
    }

    function activeEndpoint() {
      const config = state.config;
      if (!config || !config.endpoints) return null;
      return (
        config.endpoints.find((ep) => ep.id === config.activeEndpointId) ||
        config.endpoints[0] ||
        null
      );
    }

    function modelPickerLabel() {
      const active = activeEndpoint();
      return (
        (active && (active.model || active.name)) ||
        t("noEndpoint", "Select model")
      );
    }

    function modelPickerTitle() {
      const active = activeEndpoint();
      if (!active) return t("model", "Model");
      return [active.name, active.model, active.baseUrl]
        .filter(Boolean)
        .join(" · ");
    }

    function modelMenuHtml() {
      if (!state.modelMenu.open) return "";
      const endpoints = (state.config && state.config.endpoints) || [];
      const submenu = state.modelMenu.submenu || {};
      const narrowMenu = global.innerWidth < 500;
      const endpointRows = endpoints
        .map((ep) => {
          const active =
            ep.id === (state.config && state.config.activeEndpointId);
          const open =
            submenu.kind === "models" && submenu.endpointId === ep.id;
          return `
          <div class="model-option ${active || open ? "active" : ""}" data-endpoint-id="${escapeHtml(ep.id)}" role="menuitem">
            <span>${escapeHtml(ep.name || ep.model || ep.id)}</span>
            <span class="model-hint">›</span>
          </div>`;
        })
        .join("");
      const thinkingOpen = submenu.kind === "effort";
      const effort = (state.config && state.config.reasoningEffort) || "auto";
      let subRows =
        narrowMenu && submenu.kind !== "root"
          ? `<div class="model-option" data-submenu="back" role="menuitem"><span>‹ ${escapeHtml(
              t("endpoints", "Endpoints"),
            )}</span></div>`
          : "";
      if (submenu.kind === "root") {
        // The narrow menu opens at its root so every destination remains reachable.
      } else if (thinkingOpen) {
        subRows = ["auto", "off", "low", "medium", "high"]
          .map(
            (value) => `
          <div class="model-option ${effort === value ? "active" : ""}" data-effort="${value}" role="menuitem">
            <span>${value}</span>${effort === value ? '<span class="plus-mark">✓</span>' : ""}
          </div>`,
          )
          .join("");
      } else {
        const endpointId =
          submenu.kind === "models"
            ? submenu.endpointId
            : (state.config && state.config.activeEndpointId) ||
              (endpoints[0] && endpoints[0].id) ||
              "";
        const endpoint = endpoints.find((ep) => ep.id === endpointId);
        const cached = (endpointId && state.modelLists[endpointId]) || {
          status: "idle",
          models: endpoint && endpoint.model ? [endpoint.model] : [],
          error: "",
        };
        const models =
          cached.models && cached.models.length
            ? cached.models
            : endpoint && endpoint.model
              ? [endpoint.model]
              : [];
        if (cached.status === "loading" && !models.length) {
          subRows += `<div class="model-option muted">${escapeHtml(
            t("modelLoading", "Loading models…"),
          )}</div>`;
        }
        if (!models.length && cached.status !== "loading") {
          subRows += `<div class="model-option muted">${escapeHtml(
            cached.error
              ? t("modelError", "Could not list models")
              : t("modelEmpty", "No models listed"),
          )}</div>`;
        }
        subRows += models
          .map((model) => {
            const selected = endpoint && endpoint.model === model;
            return `
          <div class="model-option ${selected ? "active" : ""}" data-model="${escapeHtml(model)}" data-model-endpoint="${escapeHtml(endpointId)}" role="menuitem">
            <span>${escapeHtml(model)}</span>${selected ? '<span class="plus-mark">✓</span>' : ""}
          </div>`;
          })
          .join("");
        if (cached.status === "loading" && models.length) {
          subRows += `<div class="model-option muted">${escapeHtml(
            t("modelLoading", "Loading models…"),
          )}</div>`;
        }
        if (cached.error && models.length) {
          subRows += `<div class="model-error">${escapeHtml(cached.error)}</div>`;
        }
      }
      return `
      <div id="model-menu" class="model-menu" role="menu">
        <div class="plus-section">${escapeHtml(t("endpoints", "Endpoints"))}</div>
        ${endpointRows || `<div class="model-option muted">${escapeHtml(t("noEndpoint", "Select model"))}</div>`}
        <div class="model-option ${thinkingOpen ? "active" : ""}" data-submenu="effort" role="menuitem">
          <span>${escapeHtml(t("thinking", "Thinking"))}</span>
          <span class="model-hint">${escapeHtml(effort)} ›</span>
        </div>
        <div class="model-option" data-submenu="manage" role="menuitem">
          <span>${escapeHtml(t("manageEndpoints", "Manage endpoints…"))}</span>
        </div>
      </div>
      ${submenu.kind === "root" ? "" : `<div id="model-submenu" class="model-submenu" role="menu">${subRows}</div>`}`;
    }

    function applyMode(mode) {
      state.mode = mode;
      state.plusOpen = false;
      state.modelMenu.open = false;
      render();
      if (state.sessionId) {
        rpc("session/setMode", { sessionId: state.sessionId, mode });
      }
    }

    function applyPermission(mode) {
      state.permission = mode;
      state.plusOpen = false;
      state.modelMenu.open = false;
      render();
      if (state.sessionId) {
        const sessionId = state.sessionId;
        const update = pendingPermissionUpdate
          .catch(() => undefined)
          .then(() =>
            rpc("session/setPermissions", {
              sessionId,
              permissionMode: mode,
            }),
          )
          .then(() => undefined);
        pendingPermissionUpdate = update;
        update.catch((error) => {
          if (state.sessionId !== sessionId) return;
          state.sendError = (error && error.message) || String(error);
          render();
        });
      }
    }

    function applySkill(slug) {
      state.skillSlug = state.skillSlug === slug ? "" : slug;
      state.plusOpen = false;
      state.modelMenu.open = false;
      render();
      if (state.sessionId) {
        rpc("skill/activate", {
          sessionId: state.sessionId,
          slug: state.skillSlug || null,
        });
      }
    }

    function configReady(config) {
      if (!config) return false;
      if (typeof config.configured === "boolean") return config.configured;
      return Boolean(config.baseUrl && config.model);
    }

    async function applyEndpoint(id) {
      state.modelMenu.submenu = { kind: "models", endpointId: id };
      try {
        if (!state.config || id !== state.config.activeEndpointId) {
          state.config = await rpc("config/set", { activeEndpointId: id });
          state.settingsEditingId = id;
        }
      } catch {
        /* keep old value */
      }
      render();
      ensureModels(id);
    }

    async function applyModelSelection(endpointId, model) {
      const patch = {};
      if (!state.config || endpointId !== state.config.activeEndpointId) {
        patch.activeEndpointId = endpointId;
      }
      const target = ((state.config && state.config.endpoints) || []).find(
        (ep) => ep.id === endpointId,
      );
      if (model && (!target || model !== target.model)) {
        patch.model = model;
      }
      if (Object.keys(patch).length) {
        try {
          state.config = await rpc("config/set", patch);
          state.settingsEditingId = endpointId;
        } catch (error) {
          state.sendError = (error && error.message) || "model switch failed";
        }
      }
      state.modelMenu.open = false;
      render();
    }

    async function ensureModels(endpointId) {
      if (!endpointId) return;
      const cached = state.modelLists[endpointId];
      if (cached && (cached.status === "loading" || cached.status === "ok")) {
        return;
      }
      const endpoint = ((state.config && state.config.endpoints) || []).find(
        (ep) => ep.id === endpointId,
      );
      state.modelLists[endpointId] = {
        status: "loading",
        models: endpoint && endpoint.model ? [endpoint.model] : [],
        error: "",
      };
      if (state.modelMenu.open) render();
      try {
        const result = await rpc("config/listModels", { endpointId });
        state.modelLists[endpointId] = {
          status: result.error ? "error" : "ok",
          models:
            result.models && result.models.length
              ? result.models
              : endpoint && endpoint.model
                ? [endpoint.model]
                : [],
          error: result.error || "",
        };
      } catch (error) {
        state.modelLists[endpointId] = {
          status: "error",
          models: endpoint && endpoint.model ? [endpoint.model] : [],
          error: (error && error.message) || "list failed",
        };
      }
      if (
        state.modelMenu.open &&
        state.modelMenu.submenu &&
        state.modelMenu.submenu.kind === "models" &&
        state.modelMenu.submenu.endpointId === endpointId
      ) {
        render();
      }
    }

    function toggleModelMenu() {
      state.plusOpen = false;
      state.slash = { open: false, items: [], index: 0 };
      state.modelMenu.open = !state.modelMenu.open;
      if (state.modelMenu.open) {
        const activeId = (state.config && state.config.activeEndpointId) || "";
        state.modelMenu.submenu =
          global.innerWidth < 500
            ? { kind: "root" }
            : activeId
              ? { kind: "models", endpointId: activeId }
              : { kind: "effort" };
        render();
        if (activeId && global.innerWidth >= 500) ensureModels(activeId);
      } else {
        render();
      }
    }

    function placeModelMenus() {
      const button = root.querySelector("#endpoint");
      const menu = root.querySelector("#model-menu");
      const submenu = root.querySelector("#model-submenu");
      if (!button || !menu) return;
      const rect = button.getBoundingClientRect();
      menu.style.left = Math.max(8, rect.left) + "px";
      menu.style.bottom = window.innerHeight - rect.top + 6 + "px";
      menu.style.top = "auto";
      const menuRect = menu.getBoundingClientRect();
      if (menuRect.right > window.innerWidth - 8) {
        menu.style.left =
          Math.max(8, window.innerWidth - menuRect.width - 8) + "px";
      }
      if (!submenu) return;
      const kind = state.modelMenu.submenu && state.modelMenu.submenu.kind;
      let anchor = null;
      if (kind === "effort") {
        anchor = menu.querySelector("[data-submenu='effort']");
      } else {
        const id =
          (state.modelMenu.submenu && state.modelMenu.submenu.endpointId) ||
          (state.config && state.config.activeEndpointId) ||
          "";
        if (id) {
          anchor = menu.querySelector(
            '[data-endpoint-id="' + String(id).replace(/"/g, "") + '"]',
          );
        }
      }
      if (!anchor) {
        submenu.style.display = "none";
        return;
      }
      const rowRect = anchor.getBoundingClientRect();
      const latestMenu = menu.getBoundingClientRect();
      const narrowSurface = window.innerWidth < 500;
      const subWidth = narrowSurface
        ? latestMenu.width
        : Math.min(240, window.innerWidth - 16);
      if (narrowSurface) {
        submenu.style.width = subWidth + "px";
        submenu.style.maxWidth = Math.max(120, window.innerWidth - 16) + "px";
        submenu.style.top = latestMenu.top + "px";
        submenu.style.bottom = "auto";
        submenu.style.left = latestMenu.left + "px";
        return;
      }
      const openLeft = window.innerWidth - latestMenu.right < subWidth + 12;
      submenu.style.width = subWidth + "px";
      submenu.style.top = rowRect.top + "px";
      submenu.style.bottom = "auto";
      submenu.style.left = openLeft
        ? Math.max(8, latestMenu.left - subWidth - 4) + "px"
        : latestMenu.right + 4 + "px";
      const subRect = submenu.getBoundingClientRect();
      if (subRect.bottom > window.innerHeight - 8) {
        submenu.style.top =
          Math.max(8, window.innerHeight - subRect.height - 8) + "px";
      }
    }

    async function compactNow() {
      if (!state.sessionId) return;
      try {
        state.contextStats = await rpc("session/compact", {
          sessionId: state.sessionId,
        });
        render();
      } catch (error) {
        state.sendError = (error && error.message) || "compact failed";
        render();
      }
    }

    function updateSlashMenu(value) {
      if (!value.startsWith("/")) {
        state.slash = { open: false, items: [], index: 0 };
        if (!state.plusOpen) render();
        return;
      }
      const query = value.slice(1).toLowerCase();
      const items = slashCommands().filter((command) =>
        command.label.slice(1).toLowerCase().includes(query),
      );
      state.slash = items.length
        ? { open: true, items, index: 0 }
        : { open: false, items: [], index: 0 };
      render();
      bindComposer();
    }

    function runSlashSelection() {
      const command = state.slash.items[state.slash.index];
      state.slash = { open: false, items: [], index: 0 };
      state.promptDraft = "";
      const input = root.querySelector("#prompt");
      if (input) input.value = "";
      render();
      if (command) command.run();
    }

    function updateContextRing() {
      const arc = root.querySelector("#context-arc");
      const label = root.querySelector("#context-label");
      const ring = root.querySelector("#context-ring");
      const stats = state.contextStats;
      if (!arc || !label || !stats) return;
      const percent = Math.max(0, Math.min(100, stats.percent));
      const circumference = 2 * Math.PI * 12;
      arc.setAttribute(
        "stroke-dasharray",
        (percent / 100) * circumference + " " + circumference,
      );
      arc.setAttribute(
        "stroke",
        percent >= 90 ? "#e08a7a" : percent >= 70 ? "#d4b46a" : "#8fbf7a",
      );
      label.textContent = Math.round(percent) + "%";
      const fmt = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v));
      ring.title =
        fmt(stats.tokensEstimate) +
        " / " +
        fmt(stats.contextWindowTokens) +
        " tokens — click to compact";
    }

    function updateSendStopButtons() {
      const send = root.querySelector("#send");
      const stop = root.querySelector("#stop");
      const working = state.running || state.sending;
      if (send) send.style.display = working ? "none" : "";
      if (stop) stop.style.display = working ? "" : "none";
    }

    function isRunningFromEvents(events) {
      let running = false;
      let latestTurnId;
      for (const event of events) {
        if (event.type === "turn_started") {
          latestTurnId = event.turnId;
          running = true;
        } else if (
          event.turnId === latestTurnId &&
          (event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_aborted")
        ) {
          running = false;
        }
      }
      return running;
    }

    function bindComposer() {
      const plus = root.querySelector("#plus");
      if (plus) {
        plus.onclick = () => {
          state.plusOpen = !state.plusOpen;
          state.modelMenu.open = false;
          state.slash = { open: false, items: [], index: 0 };
          render();
        };
      }
      const endpoint = root.querySelector("#endpoint");
      if (endpoint) {
        endpoint.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleModelMenu();
        };
      }
      const ring = root.querySelector("#context-ring");
      if (ring) {
        ring.onclick = () => compactNow();
      }
      root.querySelectorAll(".slash-row").forEach((row) => {
        row.onclick = () => {
          state.slash.index = Number(row.getAttribute("data-slash"));
          runSlashSelection();
        };
      });
      root.querySelectorAll(".plus-option").forEach((row) => {
        row.onclick = () => {
          const attr = row.getAttribute("data-plus");
          const value = row.getAttribute("data-value");
          if (attr === "mode") applyMode(value);
          else if (attr === "perm") applyPermission(value);
          else if (attr === "skill") applySkill(value);
        };
      });
      root.querySelectorAll("#model-menu [data-endpoint-id]").forEach((row) => {
        const id = row.getAttribute("data-endpoint-id");
        row.onmouseenter = () => {
          if (
            !state.modelMenu.submenu ||
            state.modelMenu.submenu.kind !== "models" ||
            state.modelMenu.submenu.endpointId !== id
          ) {
            state.modelMenu.submenu = { kind: "models", endpointId: id };
            render();
            ensureModels(id);
          }
        };
        row.onclick = () => applyEndpoint(id);
      });
      const effortRow = root.querySelector(
        "#model-menu [data-submenu='effort']",
      );
      if (effortRow) {
        const openEffort = () => {
          if (
            !state.modelMenu.submenu ||
            state.modelMenu.submenu.kind !== "effort"
          ) {
            state.modelMenu.submenu = { kind: "effort" };
            render();
          }
        };
        effortRow.onmouseenter = openEffort;
        effortRow.onclick = openEffort;
      }
      const manageRow = root.querySelector(
        "#model-menu [data-submenu='manage']",
      );
      if (manageRow) {
        manageRow.onclick = async () => {
          state.modelMenu.open = false;
          await refreshConfig();
          openSettings();
        };
      }
      const backRow = root.querySelector(
        "#model-submenu [data-submenu='back']",
      );
      if (backRow) {
        backRow.onclick = () => {
          state.modelMenu.submenu = { kind: "root" };
          render();
        };
      }
      root.querySelectorAll("#model-submenu [data-model]").forEach((row) => {
        row.onclick = () => {
          applyModelSelection(
            row.getAttribute("data-model-endpoint"),
            row.getAttribute("data-model"),
          );
        };
      });
      root.querySelectorAll("#model-submenu [data-effort]").forEach((row) => {
        row.onclick = async () => {
          try {
            state.config = await rpc("config/set", {
              reasoningEffort: row.getAttribute("data-effort"),
            });
          } catch {
            /* keep old value */
          }
          render();
        };
      });
      placeModelMenus();
    }

    const knowledgeKinds = [
      "paper",
      "note",
      "insight",
      "method",
      "discussion",
      "mindmap",
    ];

    function knowledgeKindLabel(kind) {
      const labels = {
        paper: t("knowledgeKindPaper", "Paper"),
        note: t("knowledgeKindNote", "Note"),
        insight: t("knowledgeKindInsight", "Insight"),
        method: t("knowledgeKindMethod", "Method"),
        discussion: t("knowledgeKindDiscussion", "Discussion"),
        mindmap: t("knowledgeKindMindMap", "Mind map"),
      };
      return labels[kind] || kind;
    }

    function knowledgeWindowHtml() {
      if (!state.knowledgeOpen) return "";
      const base = state.knowledgeBase;
      const topics = state.knowledgeBases
        .map(
          (topic) => `
          <button type="button" class="knowledge-topic-row ${
            topic.id === state.knowledgeBaseId ? "active" : ""
          }" data-kb-topic="${escapeHtml(topic.id)}" data-search="${escapeHtml(
            `${topic.title} ${topic.description || ""} ${(topic.tags || []).join(" ")}`.toLowerCase(),
          )}">
            <strong>${escapeHtml(topic.title)}</strong>
            <span>${Number(topic.entryCount) || 0} ${escapeHtml(
              t("knowledgeEntries", "entries"),
            )}</span>
          </button>`,
        )
        .join("");
      const entries = base
        ? (base.entries || []).filter(
            (entry) =>
              state.knowledgeFilter === "all" ||
              entry.kind === state.knowledgeFilter,
          )
        : [];
      const entryRows = entries
        .map(
          (entry) => `
          <button type="button" class="knowledge-entry-row ${
            entry.id === state.knowledgeEntryId ? "active" : ""
          }" data-kb-entry="${escapeHtml(entry.id)}" data-search="${escapeHtml(
            `${entry.title} ${entry.content} ${(entry.tags || []).join(" ")}`.toLowerCase(),
          )}">
            <span class="knowledge-entry-kind">${escapeHtml(
              knowledgeKindLabel(entry.kind),
            )}</span>
            <strong>${escapeHtml(entry.title)}</strong>
            <span>${escapeHtml(
              String(entry.content || "")
                .replace(/\s+/g, " ")
                .slice(0, 90),
            )}</span>
          </button>`,
        )
        .join("");
      const filters = ["all", ...knowledgeKinds]
        .map((kind) => {
          const count = base
            ? kind === "all"
              ? base.entryCount || 0
              : (base.counts && base.counts[kind]) || 0
            : 0;
          return `<button type="button" class="knowledge-filter ${
            state.knowledgeFilter === kind ? "active" : ""
          }" data-kb-filter="${kind}">${escapeHtml(
            kind === "all"
              ? t("knowledgeKindAll", "All")
              : knowledgeKindLabel(kind),
          )} ${count}</button>`;
        })
        .join("");
      return `
      <div id="knowledge-overlay" class="knowledge-overlay" role="dialog" aria-modal="true" aria-label="${escapeHtml(
        t("knowledgeTitle", "Research knowledge base"),
      )}">
        <section class="knowledge-shell">
          <header class="knowledge-header">
            <span class="knowledge-header-icon">${knowledgeIcon()}</span>
            <div class="knowledge-header-copy">
              <span>${escapeHtml(t("knowledgeResearchMemory", "Research memory"))}</span>
              <strong>${escapeHtml(
                (base && base.title) ||
                  t("knowledgeTitle", "Research knowledge base"),
              )}</strong>
            </div>
            <button id="knowledge-close" class="icon-button" type="button" aria-label="${escapeHtml(
              t("knowledgeClose", "Close knowledge base"),
            )}" title="${escapeHtml(t("knowledgeClose", "Close knowledge base"))}">×</button>
          </header>
          <div class="knowledge-body">
            <aside class="knowledge-pane knowledge-topics">
              <div class="knowledge-toolbar">
                <input id="knowledge-topic-search" type="search" placeholder="${escapeHtml(
                  t("knowledgeSearchTopics", "Search topics"),
                )}" />
                <button id="knowledge-new-topic" type="button" title="${escapeHtml(
                  t("knowledgeNew", "New topic"),
                )}" aria-label="${escapeHtml(t("knowledgeNew", "New topic"))}">+</button>
              </div>
              <div class="knowledge-section-label">${escapeHtml(
                t("knowledgeTopics", "Research topics"),
              )}</div>
              <div id="knowledge-topic-list" class="knowledge-topic-list">
                ${
                  state.knowledgeLoading
                    ? `<p class="muted">${escapeHtml(
                        t("knowledgeLoading", "Loading knowledge bases…"),
                      )}</p>`
                    : topics ||
                      `<p class="muted">${escapeHtml(
                        t("knowledgeNoTopics", "No research topics yet."),
                      )}</p>`
                }
              </div>
            </aside>
            <main class="knowledge-pane knowledge-entries">
              ${
                base
                  ? `<div class="knowledge-topic-heading">
                       <div><strong>${escapeHtml(base.title)}</strong><span>${escapeHtml(
                         base.description ||
                           t(
                             "knowledgeNoDescription",
                             "No topic description yet.",
                           ),
                       )}</span></div>
                       <button id="knowledge-edit-topic" type="button">${escapeHtml(
                         t("knowledgeEditTopic", "Edit topic"),
                       )}</button>
                     </div>
                     <div class="knowledge-filters">${filters}</div>
                     <div class="knowledge-toolbar">
                       <input id="knowledge-entry-search" type="search" placeholder="${escapeHtml(
                         t("knowledgeSearchEntries", "Search this topic"),
                       )}" />
                       <button id="knowledge-new-entry" type="button">${escapeHtml(
                         t("knowledgeAddEntry", "Add entry"),
                       )}</button>
                     </div>
                     <div id="knowledge-entry-list">${
                       entryRows ||
                       `<p class="muted">${escapeHtml(
                         t(
                           "knowledgeNoEntries",
                           "Nothing in this category yet.",
                         ),
                       )}</p>`
                     }</div>`
                  : `<div class="knowledge-empty">${escapeHtml(
                      t(
                        "knowledgeCreateFirst",
                        "Create a topic to keep tracking literature, notes, insights, and research attempts.",
                      ),
                    )}</div>`
              }
            </main>
            <section class="knowledge-pane knowledge-editor">
              ${
                state.knowledgeError
                  ? `<div id="knowledge-error" class="knowledge-error">${escapeHtml(
                      state.knowledgeError,
                    )}</div>`
                  : ""
              }
              ${knowledgeEditorHtml()}
            </section>
          </div>
        </section>
      </div>`;
    }

    function knowledgeEditorHtml() {
      if (state.knowledgeEditor === "base") {
        return knowledgeBaseFormHtml();
      }
      if (state.knowledgeEditor === "entry" && state.knowledgeBase) {
        return knowledgeEntryFormHtml();
      }
      return `<div class="knowledge-empty">${escapeHtml(
        t(
          "knowledgeSelectEntry",
          "Select an entry to view and edit it, or add new research material.",
        ),
      )}</div>`;
    }

    function knowledgeBaseFormHtml() {
      const current = state.knowledgeCreatingBase ? null : state.knowledgeBase;
      return `
        <div class="knowledge-section-label">${escapeHtml(
          state.knowledgeCreatingBase
            ? t("knowledgeNew", "New topic")
            : t("knowledgeEditTopic", "Edit topic"),
        )}</div>
        <label class="knowledge-field"><span>${escapeHtml(
          t("knowledgeFieldTitle", "Title"),
        )}</span><input id="knowledge-base-title" type="text" value="${escapeHtml(
          (current && current.title) || "",
        )}" placeholder="${escapeHtml(
          t(
            "knowledgeTopicTitlePlaceholder",
            "e.g. Long-term memory for multi-agent systems",
          ),
        )}" /></label>
        <label class="knowledge-field"><span>${escapeHtml(
          t("knowledgeFieldDescription", "Scope and objective"),
        )}</span><textarea id="knowledge-base-description" placeholder="${escapeHtml(
          t(
            "knowledgeTopicDescriptionPlaceholder",
            "Define the research question, boundary, objective, and current stage…",
          ),
        )}">${escapeHtml((current && current.description) || "")}</textarea></label>
        <label class="knowledge-field"><span>${escapeHtml(
          t("knowledgeFieldTags", "Tags (comma-separated)"),
        )}</span><input id="knowledge-base-tags" type="text" value="${escapeHtml(
          current ? (current.tags || []).join(", ") : "",
        )}" placeholder="${escapeHtml(
          t("knowledgeTagsPlaceholder", "e.g. RAG, evaluation"),
        )}" /></label>
        <div class="knowledge-actions">
          <button id="knowledge-save-topic" type="button">${escapeHtml(
            t("knowledgeSave", "Save"),
          )}</button>
          ${
            current
              ? `<button id="knowledge-delete-topic" class="danger" type="button">${escapeHtml(
                  t("knowledgeDeleteTopic", "Delete topic"),
                )}</button>`
              : ""
          }
        </div>`;
    }

    function knowledgeEntryFormHtml() {
      const current = (state.knowledgeBase.entries || []).find(
        (entry) => entry.id === state.knowledgeEntryId,
      );
      const kind = (current && current.kind) || "note";
      const source = (current && current.source) || {};
      const kindButtons = knowledgeKinds
        .map(
          (choice) =>
            `<button type="button" role="radio" aria-checked="${
              kind === choice ? "true" : "false"
            }" class="knowledge-filter ${kind === choice ? "active" : ""}" data-kb-kind="${choice}">${escapeHtml(
              knowledgeKindLabel(choice),
            )}</button>`,
        )
        .join("");
      const content = (current && current.content) || "";
      return `
        <div class="knowledge-section-label">${escapeHtml(
          current
            ? t("knowledgeEditEntry", "Edit entry")
            : t("knowledgeAddEntry", "Add entry"),
        )}</div>
        <div class="knowledge-field"><span>${escapeHtml(
          t("knowledgeFieldKind", "Type"),
        )}</span><div id="knowledge-entry-kind" class="knowledge-filters" role="radiogroup" aria-label="${escapeHtml(
          t("knowledgeFieldKind", "Type"),
        )}" data-value="${kind}">${kindButtons}</div></div>
        <label class="knowledge-field"><span>${escapeHtml(
          t("knowledgeFieldTitle", "Title"),
        )}</span><input id="knowledge-entry-title" type="text" value="${escapeHtml(
          (current && current.title) || "",
        )}" placeholder="${escapeHtml(
          t(
            "knowledgeEntryTitlePlaceholder",
            "Identify this research material in one line",
          ),
        )}" /></label>
        <label class="knowledge-field"><span>${escapeHtml(
          t("knowledgeFieldTags", "Tags (comma-separated)"),
        )}</span><input id="knowledge-entry-tags" type="text" value="${escapeHtml(
          current ? (current.tags || []).join(", ") : "",
        )}" placeholder="${escapeHtml(
          t("knowledgeTagsPlaceholder", "e.g. RAG, evaluation"),
        )}" /></label>
        <label id="knowledge-source-field" class="knowledge-field ${
          kind === "paper" ? "" : "hidden"
        }"><span>${escapeHtml(
          t("knowledgePaperSource", "Zotero paper source (optional)"),
        )}</span><div class="knowledge-source"><input id="knowledge-source-library" type="number" min="1" value="${escapeHtml(
          source.libraryID || "",
        )}" placeholder="libraryID" /><input id="knowledge-source-key" type="text" value="${escapeHtml(
          source.key || "",
        )}" placeholder="Zotero key" /></div></label>
        <div id="knowledge-content-layout" class="knowledge-content-layout ${
          kind === "mindmap" ? "is-mindmap" : ""
        }">
          <label class="knowledge-field"><span>${escapeHtml(
            t("knowledgeFieldContent", "Content"),
          )}</span><textarea id="knowledge-entry-content" placeholder="${escapeHtml(
            t(
              "knowledgeContentPlaceholder",
              "Record evidence, reasoning, attempts, and conclusions…",
            ),
          )}">${escapeHtml(content)}</textarea></label>
          <div id="knowledge-mindmap-preview" class="knowledge-mindmap-preview">${mindMapTreeHtml(
            parseMindMapOutline(content),
          )}</div>
        </div>
        <div class="knowledge-actions">
          <button id="knowledge-save-entry" type="button">${escapeHtml(
            t("knowledgeSave", "Save"),
          )}</button>
          ${
            current
              ? `<button id="knowledge-delete-entry" class="danger" type="button">${escapeHtml(
                  t("knowledgeDeleteEntry", "Delete entry"),
                )}</button>`
              : ""
          }
        </div>`;
    }

    async function openKnowledgeWindow() {
      state.knowledgeOpen = true;
      state.knowledgeLoading = true;
      state.knowledgeError = "";
      render();
      try {
        await refreshKnowledgeBases(state.knowledgeBaseId);
      } catch (error) {
        state.knowledgeError = (error && error.message) || String(error);
      } finally {
        state.knowledgeLoading = false;
        render();
      }
    }

    async function refreshKnowledgeBases(preferredId) {
      const result = await rpc("knowledge/list", { limit: 200 });
      state.knowledgeBases = result.knowledgeBases || [];
      const nextId =
        (preferredId &&
          state.knowledgeBases.some((base) => base.id === preferredId) &&
          preferredId) ||
        (state.knowledgeBases[0] && state.knowledgeBases[0].id) ||
        "";
      if (nextId) {
        await loadKnowledgeBase(nextId, false);
      } else {
        state.knowledgeBaseId = "";
        state.knowledgeBase = null;
        state.knowledgeEntryId = "";
        state.knowledgeEditor = "empty";
      }
    }

    async function loadKnowledgeBase(id, repaint = true) {
      state.knowledgeBaseId = id;
      state.knowledgeEntryId = "";
      state.knowledgeError = "";
      const result = await rpc("knowledge/get", { id, limit: 2000 });
      state.knowledgeBase = result.knowledgeBase || null;
      state.knowledgeEditor = state.knowledgeBase ? "base" : "empty";
      if (repaint) render();
    }

    function bindKnowledgeWindow() {
      const opener = root.querySelector("#knowledge");
      if (opener) opener.onclick = () => openKnowledgeWindow();
      if (!state.knowledgeOpen) return;
      const overlay = root.querySelector("#knowledge-overlay");
      if (overlay) {
        overlay.onclick = (event) => {
          if (event.target === overlay) {
            state.knowledgeOpen = false;
            render();
          }
        };
      }
      const close = root.querySelector("#knowledge-close");
      if (close) {
        close.onclick = () => {
          state.knowledgeOpen = false;
          render();
        };
      }
      const newTopic = root.querySelector("#knowledge-new-topic");
      if (newTopic) {
        newTopic.onclick = () => {
          state.knowledgeCreatingBase = true;
          state.knowledgeEditor = "base";
          state.knowledgeEntryId = "";
          state.knowledgeError = "";
          render();
        };
      }
      root.querySelectorAll("[data-kb-topic]").forEach((node) => {
        node.onclick = () => loadKnowledgeBase(node.dataset.kbTopic);
      });
      root.querySelectorAll("[data-kb-entry]").forEach((node) => {
        node.onclick = () => {
          state.knowledgeEntryId = node.dataset.kbEntry;
          state.knowledgeEditor = "entry";
          state.knowledgeError = "";
          render();
        };
      });
      root.querySelectorAll("[data-kb-filter]").forEach((node) => {
        node.onclick = () => {
          state.knowledgeFilter = node.dataset.kbFilter;
          render();
        };
      });
      bindKnowledgeSearch("#knowledge-topic-search", "#knowledge-topic-list");
      bindKnowledgeSearch("#knowledge-entry-search", "#knowledge-entry-list");
      const editTopic = root.querySelector("#knowledge-edit-topic");
      if (editTopic) {
        editTopic.onclick = () => {
          state.knowledgeCreatingBase = false;
          state.knowledgeEditor = "base";
          state.knowledgeEntryId = "";
          state.knowledgeError = "";
          render();
        };
      }
      const newEntry = root.querySelector("#knowledge-new-entry");
      if (newEntry) {
        newEntry.onclick = () => {
          state.knowledgeEntryId = "";
          state.knowledgeEditor = "entry";
          state.knowledgeError = "";
          try {
            render();
          } catch (error) {
            state.knowledgeEditor = "base";
            showKnowledgeError((error && error.message) || String(error));
          }
        };
      }
      bindKnowledgeKindButtons();
      const saveTopic = root.querySelector("#knowledge-save-topic");
      if (saveTopic) saveTopic.onclick = saveKnowledgeTopic;
      const saveEntry = root.querySelector("#knowledge-save-entry");
      if (saveEntry) saveEntry.onclick = saveKnowledgeEntry;
      const deleteTopic = root.querySelector("#knowledge-delete-topic");
      if (deleteTopic) deleteTopic.onclick = deleteKnowledgeTopic;
      const deleteEntry = root.querySelector("#knowledge-delete-entry");
      if (deleteEntry) deleteEntry.onclick = deleteKnowledgeEntry;
      const content = root.querySelector("#knowledge-entry-content");
      if (content) {
        content.oninput = () => {
          const preview = root.querySelector("#knowledge-mindmap-preview");
          if (preview) {
            preview.innerHTML = mindMapTreeHtml(
              parseMindMapOutline(content.value),
            );
          }
        };
      }
      const focus = state.knowledgeCreatingBase
        ? root.querySelector("#knowledge-base-title")
        : state.knowledgeEditor === "entry"
          ? root.querySelector("#knowledge-entry-title")
          : root.querySelector("#knowledge-topic-search");
      if (focus) focus.focus();
    }

    function bindKnowledgeSearch(inputSelector, listSelector) {
      const input = root.querySelector(inputSelector);
      const list = root.querySelector(listSelector);
      if (!input || !list) return;
      input.oninput = () => {
        const query = input.value.trim().toLowerCase();
        list.querySelectorAll("[data-search]").forEach((row) => {
          row.style.display =
            !query || String(row.dataset.search || "").includes(query)
              ? ""
              : "none";
        });
      };
    }

    function bindKnowledgeKindButtons() {
      const group = root.querySelector("#knowledge-entry-kind");
      if (!group) return;
      group.querySelectorAll("[data-kb-kind]").forEach((node) => {
        node.onclick = () => {
          const value = node.dataset.kbKind;
          group.dataset.value = value;
          group.querySelectorAll("[data-kb-kind]").forEach((candidate) => {
            const active = candidate.dataset.kbKind === value;
            candidate.classList.toggle("active", active);
            candidate.setAttribute("aria-checked", active ? "true" : "false");
          });
          const source = root.querySelector("#knowledge-source-field");
          if (source) source.classList.toggle("hidden", value !== "paper");
          const layout = root.querySelector("#knowledge-content-layout");
          if (layout)
            layout.classList.toggle("is-mindmap", value === "mindmap");
        };
      });
    }

    async function saveKnowledgeTopic() {
      const title = root.querySelector("#knowledge-base-title");
      const description = root.querySelector("#knowledge-base-description");
      const tags = root.querySelector("#knowledge-base-tags");
      if (!title || !title.value.trim()) {
        showKnowledgeError(t("knowledgeTitleRequired", "Enter a topic title."));
        return;
      }
      const payload = {
        title: title.value.trim(),
        description: description ? description.value.trim() : "",
        tags: splitKnowledgeTags(tags ? tags.value : ""),
      };
      try {
        const result = await rpc(
          state.knowledgeCreatingBase ? "knowledge/create" : "knowledge/update",
          state.knowledgeCreatingBase
            ? payload
            : { ...payload, id: state.knowledgeBaseId },
        );
        state.knowledgeCreatingBase = false;
        await refreshKnowledgeBases(
          (result.knowledgeBase && result.knowledgeBase.id) ||
            state.knowledgeBaseId,
        );
        state.knowledgeEditor = "base";
        render();
      } catch (error) {
        showKnowledgeError((error && error.message) || String(error));
      }
    }

    async function saveKnowledgeEntry() {
      const kind = root.querySelector("#knowledge-entry-kind");
      const title = root.querySelector("#knowledge-entry-title");
      const tags = root.querySelector("#knowledge-entry-tags");
      const content = root.querySelector("#knowledge-entry-content");
      const library = root.querySelector("#knowledge-source-library");
      const key = root.querySelector("#knowledge-source-key");
      if (!title || !content || !title.value.trim() || !content.value.trim()) {
        showKnowledgeError(
          t("knowledgeEntryRequired", "Title and content are required."),
        );
        return;
      }
      try {
        const result = await rpc("knowledge/saveEntry", {
          id: state.knowledgeEntryId || undefined,
          knowledgeBaseId: state.knowledgeBaseId,
          kind: (kind && kind.dataset.value) || "note",
          title: title.value.trim(),
          content: content.value.trim(),
          tags: splitKnowledgeTags(tags ? tags.value : ""),
          libraryID: library ? Number(library.value) || undefined : undefined,
          key: key ? key.value.trim() || undefined : undefined,
          clearSource:
            !kind ||
            kind.dataset.value !== "paper" ||
            !library ||
            !Number(library.value) ||
            !key ||
            !key.value.trim(),
        });
        await refreshKnowledgeBases(state.knowledgeBaseId);
        state.knowledgeEntryId = (result.entry && result.entry.id) || "";
        state.knowledgeEditor = "entry";
        render();
      } catch (error) {
        showKnowledgeError((error && error.message) || String(error));
      }
    }

    async function deleteKnowledgeTopic() {
      if (
        !global.confirm(
          t(
            "knowledgeDeleteTopicConfirm",
            "Delete this topic and every entry in it? This cannot be undone.",
          ),
        )
      ) {
        return;
      }
      await rpc("knowledge/delete", { id: state.knowledgeBaseId });
      await refreshKnowledgeBases("");
      render();
    }

    async function deleteKnowledgeEntry() {
      if (
        !global.confirm(
          t(
            "knowledgeDeleteEntryConfirm",
            "Delete this knowledge entry? This cannot be undone.",
          ),
        )
      ) {
        return;
      }
      await rpc("knowledge/deleteEntry", {
        knowledgeBaseId: state.knowledgeBaseId,
        id: state.knowledgeEntryId,
      });
      await refreshKnowledgeBases(state.knowledgeBaseId);
      state.knowledgeEntryId = "";
      state.knowledgeEditor = "base";
      render();
    }

    function splitKnowledgeTags(value) {
      return String(value || "")
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
    }

    function showKnowledgeError(message) {
      state.knowledgeError = message;
      let error = root.querySelector("#knowledge-error");
      if (!error) {
        error = document.createElement("div");
        error.id = "knowledge-error";
        error.className = "knowledge-error";
        const editor = root.querySelector(".knowledge-editor");
        if (editor) editor.prepend(error);
      }
      if (error) error.textContent = message;
    }

    function settingsOverlayHtml() {
      if (!state.settingsOpen) return "";
      const config = state.config || {};
      const endpoints = config.endpoints || [];
      const editingId = state.settingsEditingId;
      const editing =
        (editingId && endpoints.find((ep) => ep.id === editingId)) ||
        (!editingId
          ? {
              name: "",
              baseUrl: "",
              apiKey: "",
              model: "",
              maxTokens: 0,
              reasoningEffort: "auto",
              contextWindowTokens: 32768,
            }
          : {
              name: config.model || "",
              baseUrl: config.baseUrl || "",
              apiKey: config.apiKey || "",
              model: config.model || "",
              maxTokens: config.maxTokens || 0,
              reasoningEffort: config.reasoningEffort || "auto",
              contextWindowTokens: config.contextWindowTokens || 32768,
            });
      const listRows = endpoints
        .map((ep) => {
          const active = ep.id === config.activeEndpointId;
          const selected = ep.id === editingId;
          return `
            <div class="endpoint-row ${selected ? "selected" : ""}" data-endpoint="${escapeHtml(ep.id)}">
              <span class="endpoint-mark">${active ? "●" : "○"}</span>
              <span class="endpoint-info">
                <span class="endpoint-name">${escapeHtml(ep.name || ep.model || "Untitled")}</span>
                <span class="endpoint-sub">${escapeHtml([ep.model, ep.baseUrl].filter(Boolean).join(" · "))}</span>
              </span>
              <button type="button" class="unstyled danger endpoint-delete" data-delete-endpoint="${escapeHtml(ep.id)}" title="Delete">✕</button>
            </div>`;
        })
        .join("");
      const draftRow =
        editingId === ""
          ? `<div class="endpoint-row selected"><span class="endpoint-info"><span class="endpoint-name">New endpoint</span></span></div>`
          : "";
      return `
      <div id="settings-overlay" class="settings-overlay">
        <div class="settings-panel">
          <div class="settings-header">
            <strong>${escapeHtml(t("settingsTitle", "Model settings"))}</strong>
            <button id="cfg-close" type="button" class="icon-button" aria-label="${escapeHtml(t("cancel", "Cancel"))}">×</button>
          </div>
          <div class="endpoint-list">${listRows}${draftRow}</div>
          <button id="cfg-add" type="button" class="secondary">Add endpoint</button>
          <label>Name
            <input id="cfg-name" type="text" value="${escapeHtml(editing.name || "")}" />
          </label>
          <label>Base URL (OpenAI-compatible /chat/completions, or Ollama /api/chat)
            <input id="cfg-baseUrl" type="text" value="${escapeHtml(editing.baseUrl || "")}" />
          </label>
          <label>API key (ignored by local Ollama)
            <input id="cfg-apiKey" type="password" value="${escapeHtml(editing.apiKey || "")}" />
          </label>
          <label>Model
            <input id="cfg-model" type="text" value="${escapeHtml(editing.model || "")}" />
          </label>
          <label>Max tokens (0 = provider default)
            <input id="cfg-maxTokens" type="number" value="${escapeHtml(String(editing.maxTokens == null ? 0 : editing.maxTokens))}" />
          </label>
          <label>Context window (tokens, for the usage ring and compaction)
            <input id="cfg-contextWindow" type="number" value="${escapeHtml(String(editing.contextWindowTokens == null ? 32768 : editing.contextWindowTokens))}" />
          </label>
          <label>Thinking effort
            <select id="cfg-effort">
              ${["auto", "off", "low", "medium", "high"]
                .map(
                  (effort) =>
                    `<option value="${effort}" ${editing.reasoningEffort === effort ? "selected" : ""}>${effort}</option>`,
                )
                .join("")}
            </select>
          </label>
          <label class="check">
            <input id="cfg-stream" type="checkbox" ${config.streamResponses !== false ? "checked" : ""} />
            Stream model output live
          </label>
          <label class="check">
            <input id="cfg-memory" type="checkbox" ${config.memoryAutoExtract !== false ? "checked" : ""} />
            Extract memories after each turn
          </label>
          <label>${escapeHtml(t("maxIterations", "Max model rounds (all endpoints)"))}
            <input id="cfg-maxIterations" type="number" min="1" max="200" value="${escapeHtml(String(config.maxIterations == null ? 48 : config.maxIterations))}" />
          </label>
          <label>${escapeHtml(t("maxToolCalls", "Max tool calls (all endpoints)"))}
            <input id="cfg-maxToolCalls" type="number" min="1" max="500" value="${escapeHtml(String(config.maxToolCalls == null ? 96 : config.maxToolCalls))}" />
          </label>
          <div id="cfg-error" class="send-error"></div>
          <div class="settings-actions">
            <button id="cfg-save" type="button">Save</button>
            <button id="cfg-cancel" type="button" class="secondary">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    function openSettings() {
      state.settingsOpen = true;
      state.settingsEditingId =
        (state.config && state.config.activeEndpointId) || "";
      render();
    }

    function bindSettings() {
      const open = root.querySelector("#settings");
      if (open) {
        open.onclick = async () => {
          await refreshConfig();
          state.settingsOpen = !state.settingsOpen;
          render();
        };
      }
      const configure = root.querySelector("#configure");
      if (configure) {
        configure.onclick = openSettings;
      }
      const overlay = root.querySelector("#settings-overlay");
      if (!overlay) return;
      overlay.onclick = (event) => {
        if (event.target === overlay) {
          state.settingsOpen = false;
          render();
        }
      };
      const close = root.querySelector("#cfg-close");
      if (close) {
        close.onclick = () => {
          state.settingsOpen = false;
          render();
        };
      }
      const cancel = root.querySelector("#cfg-cancel");
      if (cancel) {
        cancel.onclick = () => {
          state.settingsOpen = false;
          render();
        };
      }
      const add = root.querySelector("#cfg-add");
      if (add) {
        add.onclick = () => {
          state.settingsEditingId = "";
          render();
        };
      }
      root.querySelectorAll("[data-endpoint]").forEach((row) => {
        row.onclick = async () => {
          const id = row.getAttribute("data-endpoint");
          state.settingsEditingId = id;
          try {
            state.config = await rpc("config/set", { activeEndpointId: id });
          } catch {
            /* keep list */
          }
          render();
        };
      });
      root.querySelectorAll("[data-delete-endpoint]").forEach((btn) => {
        btn.onclick = async (event) => {
          event.stopPropagation();
          const errorLine = root.querySelector("#cfg-error");
          try {
            state.config = await rpc("config/set", {
              deleteEndpointId: btn.getAttribute("data-delete-endpoint"),
            });
            state.settingsEditingId =
              (state.config && state.config.activeEndpointId) || "";
            render();
          } catch (error) {
            if (errorLine) {
              errorLine.textContent =
                (error && error.message) || "delete failed";
            }
          }
        };
      });
      const save = root.querySelector("#cfg-save");
      if (save) {
        save.onclick = async () => {
          const errorLine = root.querySelector("#cfg-error");
          if (errorLine) errorLine.textContent = "";
          try {
            const value = (id) =>
              (root.querySelector("#" + id) || {}).value || "";
            const endpoint = {
              name: value("cfg-name"),
              baseUrl: value("cfg-baseUrl"),
              apiKey: value("cfg-apiKey"),
              model: value("cfg-model"),
              maxTokens: Number(value("cfg-maxTokens")) || 0,
              contextWindowTokens: Number(value("cfg-contextWindow")) || 32768,
              reasoningEffort:
                (root.querySelector("#cfg-effort") || {}).value || "auto",
            };
            if (state.settingsEditingId) {
              endpoint.id = state.settingsEditingId;
            }
            state.config = await rpc("config/set", {
              endpoint,
              streamResponses:
                (root.querySelector("#cfg-stream") || {}).checked === true,
              memoryAutoExtract:
                (root.querySelector("#cfg-memory") || {}).checked === true,
              maxIterations: Number(value("cfg-maxIterations")) || 48,
              maxToolCalls: Number(value("cfg-maxToolCalls")) || 96,
            });
            state.sendError = "";
            state.modelLists = {};
            state.settingsEditingId =
              (state.config && state.config.activeEndpointId) || "";
            render();
          } catch (error) {
            if (errorLine) {
              errorLine.textContent = (error && error.message) || "save failed";
            }
          }
        };
      }
    }

    async function refreshConfig() {
      try {
        state.config = await rpc("config/get", {});
      } catch {
        state.config = null;
      }
    }

    async function resolveApproval(id, verdict, scope) {
      await rpc("approval/resolve", { id, verdict, scope: scope || "once" });
      collectApprovals();
      render();
    }

    async function refreshSessions() {
      const listed = await rpc("session/list", {});
      state.sessions = listed.sessions || [];
      if (!state.sessionId && state.sessions[0]) {
        state.sessionId = state.sessions[0].id;
      }
    }

    async function refreshMemories() {
      try {
        const listed = await rpc("memory/list", { limit: 8 });
        state.memories = listed.memories || [];
      } catch {
        state.memories = [];
      }
      try {
        const listed = await rpc("logs/list", { limit: 1 });
        state.logCount = (listed.stats && listed.stats.sessions) || 0;
      } catch {
        state.logCount = 0;
      }
    }

    let lastSignature = "";
    let pollInFlight = false;

    async function poll() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        if (!state.config) {
          await refreshConfig();
        }
        if (!state.skills.length) {
          const listed = await rpc("skill/list", {});
          state.skills = listed.skills || [];
        }
        await refreshSessions();
        await refreshMemories();
        if (state.sessionId) {
          const polledSessionId = state.sessionId;
          const requestedCursor = state.lastEventId;
          const bundle = await rpc("session/events", {
            sessionId: polledSessionId,
            afterId: requestedCursor,
          });
          if (state.sessionId !== polledSessionId) return;
          const incoming = bundle.events || [];
          const cursorMoved = state.lastEventId !== requestedCursor;
          state.events = mergeEvents(
            state.events,
            incoming,
            !cursorMoved && (!requestedCursor || bundle.cursorFound === false),
          );
          if (incoming.length && !cursorMoved) {
            state.lastEventId = incoming[incoming.length - 1].id;
          }
          collectApprovals();
          if (incoming.some((event) => event.type === "memory_updated")) {
            await refreshMemories();
          }
          state.running = isRunningFromEvents(state.events);
          try {
            state.contextStats = await rpc("session/context", {
              sessionId: state.sessionId,
            });
          } catch {
            /* cosmetic */
          }
        }
        const signature = [
          state.sessionId,
          state.events.length,
          state.approvals.length,
          state.sessions.length,
          state.skills.length,
          state.memories.map((memory) => memory.id).join(","),
          String(state.logCount),
          state.mode,
          state.config
            ? [
                state.config.activeEndpointId || "",
                (state.config.endpoints || []).length,
                state.config.configured ? "1" : "0",
              ].join("/")
            : "cfg-",
          state.sendError,
          state.running ? "run1" : "run0",
          state.permission,
          state.contextStats ? state.contextStats.percent : "-",
          state.plusOpen ? "plus1" : "plus0",
          state.modelMenu.open
            ? "model1:" +
              ((state.modelMenu.submenu && state.modelMenu.submenu.kind) ||
                "") +
              ":" +
              ((state.modelMenu.submenu &&
                state.modelMenu.submenu.endpointId) ||
                "")
            : "model0",
          Object.keys(state.modelLists)
            .map((id) => id + (state.modelLists[id].status || ""))
            .join(","),
        ].join(":");
        if (
          signature !== lastSignature &&
          !state.settingsOpen &&
          !state.knowledgeOpen
        ) {
          lastSignature = signature;
          render();
        }
        bindSettings();
        const conn = document.getElementById("conn");
        if (conn) {
          conn.className = "status ok";
          conn.textContent = zoteroHost()
            ? t("hostZotero", "Zotero")
            : t("hostBridged", "Chrome bridge");
        }
      } catch (error) {
        const conn = document.getElementById("conn");
        if (conn) {
          conn.className = "status err";
          conn.textContent = error.message || "offline";
        }
      } finally {
        pollInFlight = false;
      }
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function durableMemoryText(value) {
      return String(value || "")
        .replace(/\*\*(user|assistant):\*\*\s*/gi, "")
        .replace(/\*\*(tool[^*]*):\*\*\s*/gi, "$1: ")
        .replace(/^##\s+.+$/gm, "")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }

    document.addEventListener("mousedown", (event) => {
      if (!state.modelMenu.open) return;
      const target = event.target;
      if (
        target &&
        target.closest &&
        (target.closest("#endpoint") ||
          target.closest("#model-menu") ||
          target.closest("#model-submenu"))
      ) {
        return;
      }
      state.modelMenu.open = false;
      render();
    });

    render();
    poll();
    setInterval(poll, 800);
    global.ConfuciusWorkspace = {
      rpc,
      getSessionId: () => state.sessionId,
      setToken: (token) => {
        try {
          if (global.localStorage) {
            global.localStorage.setItem("confuciusToken", token || "");
          }
        } catch {
          // Chrome / chrome-privileged windows may block localStorage.
        }
      },
    };
  }

  function tryBoot() {
    if (document.getElementById("confucius-root")) {
      boot();
      return;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", tryBoot, { once: true });
    }
  }

  tryBoot();
})(typeof window !== "undefined" ? window : this);
