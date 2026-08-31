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
                `<div class="session ${item.id === state.sessionId ? "active" : ""}" data-id="${escapeHtml(
                  item.id,
                )}">${escapeHtml(item.title || item.id)}</div>`,
            )
            .join("") ||
          `<p class="muted">${escapeHtml(t("noSessions", "No sessions yet."))}</p>`
        }
      </aside>
      <main class="pane">
        <div class="pane-label">${escapeHtml(t("timeline", "Timeline"))}${session ? " · " + escapeHtml(session.title) : ""}</div>
        ${
          state.events.map((event) => renderEvent(event)).join("") ||
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
              <button data-deny="${escapeHtml(item.id)}" type="button">Deny</button>
            </div>`,
            )
            .join("") ||
          `<p class="muted">${escapeHtml(
            t("emptyReview", "Write actions wait here for approval."),
          )}</p>`
        }
      </aside>
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
          await refreshSessions();
          render();
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
          const loaded = await rpc("session/load", { sessionId: state.sessionId });
          state.skillSlug = loaded.skillSlug || state.skillSlug;
          const bundle = await rpc("session/events", {
            sessionId: state.sessionId,
          });
          state.events = bundle.events || [];
          collectApprovals();
          render();
        };
      });
      root.querySelectorAll("[data-allow]").forEach((node) => {
        node.onclick = () =>
          resolveApproval(node.getAttribute("data-allow"), "allow");
      });
      root.querySelectorAll("[data-deny]").forEach((node) => {
        node.onclick = () =>
          resolveApproval(node.getAttribute("data-deny"), "deny");
      });
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
      if (event.type === "text_delta") {
        return `<div class="event"><div>${escapeHtml(event.payload.text)}</div></div>`;
      }
      if (event.type === "turn_failed") {
        return `<div class="event"><strong>Failed</strong> ${escapeHtml(
          event.payload.message,
        )}</div>`;
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
      if (!text) return;
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
    }

    async function resolveApproval(id, verdict) {
      await rpc("approval/resolve", { id, verdict, scope: "once" });
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

    let lastSignature = "";

    async function poll() {
      try {
        if (!state.skills.length) {
          const listed = await rpc("skill/list", {});
          state.skills = listed.skills || [];
        }
        await refreshSessions();
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
        }
        const signature = [
          state.sessionId,
          state.events.length,
          state.approvals.length,
          state.sessions.length,
          state.skills.length,
        ].join(":");
        if (signature !== lastSignature) {
          lastSignature = signature;
          render();
        }
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
