(function (global) {
  if (global.ConfuciusWorkspace && global.ConfuciusWorkspace.rpc) {
    return;
  }

  function t(key, fallback) {
    const pack = global.ConfuciusI18n || {};
    return pack[key] || fallback;
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
      mode: "agent",
      config: null,
      sendError: "",
      sending: false,
      settingsOpen: false,
    };

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
      const response = await fetch("http://127.0.0.1:23119/confucius/v1/rpc", {
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
      const session = state.sessions.find((item) => item.id === state.sessionId);
      root.innerHTML = `
      <div class="topbar">
        <strong>Confucius</strong>
        <span id="conn" class="status wait">${escapeHtml(
          t("connecting", "Connecting"),
        )}</span>
        <button id="new-session" type="button">${escapeHtml(
          t("newSession", "New session"),
        )}</button>
        <button id="mode" type="button" class="secondary">${escapeHtml(
          state.mode === "plan" ? "Plan" : "Agent",
        )}</button>
        <button id="settings" type="button" class="secondary" title="Model settings">⚙</button>
        <select id="skill">
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
          state.config && !state.config.hasApiKey
            ? `<div class="event config-banner">${escapeHtml(
                t(
                  "configBanner",
                  "Model not configured. Set Base URL, API key, and model to start.",
                ),
              )} <button id="configure" type="button">Configure now</button></div>`
            : ""
        }
        ${state.sendError ? `<div class="event send-error">${escapeHtml(state.sendError)}</div>` : ""}
        ${
          coalesceTimeline(state.events)
            .map((item) => renderTimelineItem(item))
            .join("") ||
          `<p class="muted">${escapeHtml(
            t("emptyTimeline", "Describe a research task to start."),
          )}</p>`
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
          state.memories
            .map(
              (memory) => `
            <div class="event memory">
              <div class="memory-title">[${escapeHtml(memory.type)}] ${escapeHtml(
                memory.title,
              )}</div>
              <div>${escapeHtml(memory.content)}</div>
              <button class="unstyled danger" data-forget="${escapeHtml(
                memory.id,
              )}" type="button">forget</button>
            </div>`,
            )
            .join("") ||
          `<p class="muted">${escapeHtml(
            t("noMemory", "No memories yet."),
          )}</p>`
        }
      </aside>
      ${settingsOverlayHtml()}
      <footer class="composer">
        <input id="prompt" placeholder="${escapeHtml(
          t("placeholder", "Describe a research task…"),
        )}" />
        <button id="send" type="button">${escapeHtml(t("send", "Send"))}</button>
        <button id="stop" type="button">${escapeHtml(t("stop", "Stop"))}</button>
      </footer>
    `;

      const newSession = root.querySelector("#new-session");
      if (newSession) {
        newSession.onclick = async () => {
          const created = await rpc("session/new", { title: "Untitled" });
          state.sessionId = created.id;
          state.events = [];
          state.lastEventId = null;
          state.mode = "agent";
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
        prompt.addEventListener("keydown", (event) => {
          if (event.key === "Enter") sendPrompt();
        });
      }
      const stop = root.querySelector("#stop");
      if (stop) {
        stop.onclick = () => {
          if (state.sessionId) rpc("session/abort", { sessionId: state.sessionId });
        };
      }
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
          state.sessionId = node.getAttribute("data-id");
          state.lastEventId = null;
          const loaded = await rpc("session/load", { sessionId: state.sessionId });
          state.skillSlug = loaded.skillSlug || state.skillSlug;
          state.mode = loaded.mode === "plan" ? "plan" : "agent";
          const bundle = await rpc("session/events", {
            sessionId: state.sessionId,
          });
          state.events = bundle.events || [];
          if (state.events.length) {
            state.lastEventId = state.events[state.events.length - 1].id;
          }
          collectApprovals();
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

    function coalesceTimeline(events) {
      const items = [];
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

    function renderTimelineItem(item) {
      if (item.kind === "text") {
        return `<div class="event assistant"><div>${escapeHtml(
          item.text,
        )}</div></div>`;
      }
      if (item.kind === "reasoning") {
        return `<div class="event reasoning"><div>${escapeHtml(
          item.text,
        )}</div></div>`;
      }
      return renderEvent(item.event);
    }

    function renderEvent(event) {
      if (event.type === "turn_started") {
        return `<div class="event"><strong>Task</strong><div>${escapeHtml(
          event.payload.userText,
        )}</div></div>`;
      }
      if (event.type === "tool_requested") {
        return `<div class="event tool"><strong>${escapeHtml(
          event.payload.toolName,
        )}</strong><pre>${escapeHtml(
          JSON.stringify(event.payload.args, null, 2),
        )}</pre></div>`;
      }
      if (event.type === "tool_result") {
        const result = event.payload.result;
        return `<div class="event tool"><strong>${escapeHtml(
          result.toolName,
        )} · ${result.ok ? "ok" : result.code}</strong><pre>${escapeHtml(
          JSON.stringify(result.ok ? result.data : result, null, 2).slice(
            0,
            4000,
          ),
        )}</pre></div>`;
      }
      if (event.type === "memory_updated") {
        return `<div class="event memory">memory ${escapeHtml(
          event.payload.op,
        )}${event.payload.title ? ": " + escapeHtml(event.payload.title) : ""}</div>`;
      }
      if (event.type === "turn_failed") {
        return `<div class="event"><strong>Failed</strong> ${escapeHtml(
          event.payload.message,
        )}</div>`;
      }
      if (event.type === "turn_aborted") {
        return `<div class="event"><strong>Stopped</strong></div>`;
      }
      if (event.type === "approval_required") {
        return `<div class="event approval">Needs approval: ${escapeHtml(
          event.payload.request.toolName,
        )}</div>`;
      }
      return "";
    }

    function collectApprovals() {
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
    }

    async function sendPrompt() {
      const input = root.querySelector("#prompt");
      const text = input && input.value ? input.value.trim() : "";
      if (!text || state.sending) return;
      if (state.config && !state.config.hasApiKey) {
        state.sendError = t(
          "configBanner",
          "Model not configured. Set Base URL, API key, and model to start.",
        );
        render();
        openSettings();
        return;
      }
      state.sending = true;
      state.sendError = "";
      try {
        if (!state.sessionId) {
          const created = await rpc("session/new", { title: text.slice(0, 72) });
          state.sessionId = created.id;
        }
        if (state.skillSlug) {
          await rpc("skill/activate", {
            sessionId: state.sessionId,
            slug: state.skillSlug,
          });
        }
        if (input) input.value = "";
        await rpc("session/prompt", { sessionId: state.sessionId, text });
        await refreshSessions();
      } catch (error) {
        state.sendError = (error && error.message) || "send failed";
      } finally {
        state.sending = false;
        render();
      }
    }

    function settingsOverlayHtml() {
      if (!state.settingsOpen) return "";
      const config = state.config || {};
      return `
      <div id="settings-overlay" class="settings-overlay">
        <div class="settings-panel">
          <strong>${escapeHtml(t("settingsTitle", "Model settings"))}</strong>
          <label>Base URL (OpenAI-compatible /chat/completions, or Ollama /api/chat)
            <input id="cfg-baseUrl" type="text" value="${escapeHtml(config.baseUrl || "")}" />
          </label>
          <label>API key (ignored by local Ollama)
            <input id="cfg-apiKey" type="password" value="${escapeHtml(config.apiKey || "")}" />
          </label>
          <label>Model
            <input id="cfg-model" type="text" value="${escapeHtml(config.model || "")}" />
          </label>
          <label>Max tokens (0 = provider default)
            <input id="cfg-maxTokens" type="number" value="${escapeHtml(String(config.maxTokens == null ? 0 : config.maxTokens))}" />
          </label>
          <label class="check">
            <input id="cfg-stream" type="checkbox" ${config.streamResponses !== false ? "checked" : ""} />
            Stream model output live
          </label>
          <label class="check">
            <input id="cfg-memory" type="checkbox" ${config.memoryAutoExtract !== false ? "checked" : ""} />
            Extract memories after each turn
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
      const cancel = root.querySelector("#cfg-cancel");
      if (cancel) {
        cancel.onclick = () => {
          state.settingsOpen = false;
          render();
        };
      }
      const save = root.querySelector("#cfg-save");
      if (save) {
        save.onclick = async () => {
          const errorLine = root.querySelector("#cfg-error");
          if (errorLine) errorLine.textContent = "";
          try {
            const value = (id) =>
              (root.querySelector("#" + id) || {}).value || "";
            state.config = await rpc("config/set", {
              baseUrl: value("cfg-baseUrl"),
              apiKey: value("cfg-apiKey"),
              model: value("cfg-model"),
              maxTokens: Number(value("cfg-maxTokens")) || 0,
              streamResponses: (root.querySelector("#cfg-stream") || {})
                .checked === true,
              memoryAutoExtract: (root.querySelector("#cfg-memory") || {})
                .checked === true,
            });
            state.sendError = "";
            state.settingsOpen = false;
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
    }

    let lastSignature = "";

    async function poll() {
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
          const bundle = await rpc("session/events", {
            sessionId: state.sessionId,
            afterId: state.lastEventId,
          });
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
          if (incoming.some((event) => event.type === "memory_updated")) {
            await refreshMemories();
          }
        }
        const signature = [
          state.sessionId,
          state.events.length,
          state.approvals.length,
          state.sessions.length,
          state.skills.length,
          state.memories.map((memory) => memory.id).join(","),
          state.mode,
          state.config ? (state.config.hasApiKey ? "cfg1" : "cfg0") : "cfg-",
          state.sendError,
        ].join(":");
        if (signature !== lastSignature && !state.settingsOpen) {
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
      }
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

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
