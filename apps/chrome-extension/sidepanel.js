const tokenInput = document.getElementById("token");
const stored = localStorage.getItem("confuciusToken") || "";
if (stored) tokenInput.value = stored;

document.getElementById("pair").onclick = async () => {
  const token = tokenInput.value.trim();
  try {
    const response = await window.ConfuciusBridge.request(
      "/confucius/v1/pair",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ token }),
      },
    );
    if (!response.ok) {
      alert("Pairing failed. Check that Zotero is open and the token matches.");
      return;
    }
    localStorage.setItem("confuciusToken", token);
    if (window.ConfuciusWorkspace) {
      window.ConfuciusWorkspace.setToken(token);
    }
  } catch {
    alert("Pairing failed. Check that Zotero is open and the token matches.");
  }
};

async function readTabSnapshot(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "confucius.extract",
    });
  } catch (firstError) {
    if (!chrome.scripting?.executeScript) throw firstError;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tabId, {
      type: "confucius.extract",
    });
  }
}

const pushTabButton = document.getElementById("push-tab");
pushTabButton.onclick = async () => {
  pushTabButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("No active tab");
    const snapshot = await readTabSnapshot(tab.id);
    if (!snapshot) throw new Error("The page returned no readable context");
    snapshot.tabId = tab.id;
    const api = window.ConfuciusWorkspace;
    if (!api) throw new Error("Confucius workspace is not ready");
    let sessionId = api.getSessionId();
    if (!sessionId) {
      const created = await api.rpc("session/new", {
        title: snapshot.title || "Browser tab",
      });
      sessionId = created.id;
    }
    await api.rpc("session/setContext", {
      sessionId,
      context: { browserTab: snapshot },
    });
  } catch (error) {
    console.warn("[Confucius] could not read active tab", error);
    alert(
      "This tab could not be read. Chrome internal pages and restricted sites are not available.",
    );
  } finally {
    pushTabButton.disabled = false;
  }
};
