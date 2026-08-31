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
      running: false,
      permission: "ask",
      contextStats: null,
      slash: { open: false, items: [], index: 0 },
      plusOpen: false,
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
      ${slashMenuHtml()}
      ${plusMenuHtml()}
      <footer class="composer">
        <button id="plus" type="button" class="plus" title="Mode, skills, model">+</button>
        <input id="prompt" placeholder="${escapeHtml(
          t("placeholder", "Describe a research task… (type / for commands)"),
        )}" />
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
        prompt.addEventListener("input", (event) =>
          updateSlashMenu(event.target.value),
        );
        prompt.addEventListener("keydown", (event) => {
          if (state.slash.open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const count = state.slash.items.length;
            state.slash.index = (state.slash.index + delta + count) % count;
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
          state.sessionId = node.getAttribute("data-id");
          state.lastEventId = null;
          const loaded = await rpc("session/load", { sessionId: state.sessionId });
          state.skillSlug = loaded.skillSlug || state.skillSlug;
          state.mode = loaded.mode === "plan" ? "plan" : "agent";
          state.permission =
            loaded.permissionMode === "auto_allow" ||
            loaded.permissionMode === "deny"
              ? loaded.permissionMode
              : "ask";
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
      if (state.slash.open) {
        runSlashSelection();
        return;
      }
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
        state.running = true;
        updateSendStopButtons();
        await refreshSessions();
      } catch (error) {
        state.sendError = (error && error.message) || "send failed";
      } finally {
        state.sending = false;
        render();
      }
    }

    function slashCommands() {
      const commands = [
        { label: "/agent", description: t("cmdAgent", "Switch to Agent mode"), run: () => applyMode("agent") },
        { label: "/plan", description: t("cmdPlan", "Switch to Plan mode (read-only)"), run: () => applyMode("plan") },
        { label: "/ask", description: t("cmdAsk", "Ask before every write"), run: () => applyPermission("ask") },
        { label: "/auto", description: t("cmdAuto", "Full auto — allow all tool writes"), run: () => applyPermission("auto_allow") },
        { label: "/deny-writes", description: t("cmdDeny", "Deny all tool writes"), run: () => applyPermission("deny") },
        { label: "/model", description: t("cmdModel", "Open model settings"), run: () => openSettings() },
        { label: "/compact", description: t("cmdCompact", "Compact the conversation now"), run: () => compactNow() },
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
          option(skill.name, state.skillSlug === skill.slug, "skill", skill.slug),
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
        <div class="plus-section">${escapeHtml(t("model", "Model"))}</div>
        <div class="plus-model">
          <span class="plus-model-name">${escapeHtml((state.config && state.config.model) || "—")}</span>
          <select id="plus-effort">
            ${["auto", "off", "low", "medium", "high"]
              .map(
                (effort) =>
                  `<option value="${effort}" ${state.config && state.config.reasoningEffort === effort ? "selected" : ""}>${effort}</option>`,
              )
              .join("")}
          </select>
          <button id="plus-settings" type="button" class="secondary">⚙</button>
        </div>
      </div>`;
    }

    function applyMode(mode) {
      state.mode = mode;
      state.plusOpen = false;
      render();
      if (state.sessionId) {
        rpc("session/setMode", { sessionId: state.sessionId, mode });
      }
    }

    function applyPermission(mode) {
      state.permission = mode;
      state.plusOpen = false;
      render();
      if (state.sessionId) {
        rpc("session/setPermissions", {
          sessionId: state.sessionId,
          permissionMode: mode,
        });
      }
    }

    function applySkill(slug) {
      state.skillSlug = state.skillSlug === slug ? "" : slug;
      state.plusOpen = false;
      render();
      if (state.sessionId) {
        rpc("skill/activate", {
          sessionId: state.sessionId,
          slug: state.skillSlug || null,
        });
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
        fmt(stats.tokensEstimate) + " / " + fmt(stats.contextWindowTokens) +
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
      for (const event of events) {
        if (event.type === "turn_started") running = true;
        else if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_aborted"
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
          state.slash = { open: false, items: [], index: 0 };
          render();
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
      const effort = root.querySelector("#plus-effort");
      if (effort) {
        effort.onchange = async () => {
          try {
            state.config = await rpc("config/set", {
              reasoningEffort: effort.value,
            });
          } catch {
            /* keep old value */
          }
        };
      }
      const plusSettings = root.querySelector("#plus-settings");
      if (plusSettings) {
        plusSettings.onclick = async () => {
          state.plusOpen = false;
          await refreshConfig();
          openSettings();
        };
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
          <label>Context window (tokens, for the usage ring and compaction)
            <input id="cfg-contextWindow" type="number" value="${escapeHtml(String(config.contextWindowTokens == null ? 32768 : config.contextWindowTokens))}" />
          </label>
          <label>Thinking effort
            <select id="cfg-effort">
              ${["auto", "off", "low", "medium", "high"]
                .map(
                  (effort) =>
                    `<option value="${effort}" ${config.reasoningEffort === effort ? "selected" : ""}>${effort}</option>`,
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
              contextWindowTokens: Number(value("cfg-contextWindow")) || 32768,
              reasoningEffort: (root.querySelector("#cfg-effort") || {}).value || "auto",
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
          state.mode,
          state.config ? (state.config.hasApiKey ? "cfg1" : "cfg0") : "cfg-",
          state.sendError,
          state.running ? "run1" : "run0",
          state.permission,
          state.contextStats ? state.contextStats.percent : "-",
          state.plusOpen ? "plus1" : "plus0",
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
