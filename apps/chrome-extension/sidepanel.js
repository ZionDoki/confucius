const tokenInput = document.getElementById("token");
const stored = localStorage.getItem("confuciusToken") || "";
if (stored) tokenInput.value = stored;

document.getElementById("pair").onclick = async () => {
  const token = tokenInput.value.trim();
  localStorage.setItem("confuciusToken", token);
  if (window.ConfuciusWorkspace) {
    window.ConfuciusWorkspace.setToken(token);
  }
  const response = await fetch("http://127.0.0.1:23119/confucius/v1/pair", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    alert("Pairing failed. Check that Zotero is open and the token matches.");
  }
};

document.getElementById("push-tab").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const snapshot = await chrome.tabs.sendMessage(tab.id, {
    type: "confucius.extract",
  });
  if (!snapshot) return;
  snapshot.tabId = tab.id;
  const api = window.ConfuciusWorkspace;
  if (!api) return;
  let sessionId = api.getSessionId();
  if (!sessionId) {
    const created = await api.rpc("session/new", { title: snapshot.title });
    sessionId = created.id;
  }
  await api.rpc("session/setContext", {
    sessionId,
    context: { browserTab: snapshot },
  });
};
