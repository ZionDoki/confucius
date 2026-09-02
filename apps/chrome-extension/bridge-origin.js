(function (global) {
  if (global.ConfuciusBridge && global.ConfuciusBridge.request) {
    return;
  }

  const STORAGE_KEY = "confuciusOrigin";
  const DEFAULT_ORIGINS = ["http://127.0.0.1:23119", "http://127.0.0.1:23124"];

  function storedOrigin() {
    try {
      const value = global.localStorage
        ? global.localStorage.getItem(STORAGE_KEY) || ""
        : "";
      return DEFAULT_ORIGINS.includes(value) ? value : "";
    } catch {
      return "";
    }
  }

  function candidateOrigins() {
    const stored = storedOrigin();
    return stored
      ? [stored, ...DEFAULT_ORIGINS.filter((origin) => origin !== stored)]
      : [...DEFAULT_ORIGINS];
  }

  function rememberOrigin(origin) {
    try {
      global.localStorage?.setItem(STORAGE_KEY, origin);
    } catch {
      // Storage can be unavailable in privileged or private contexts.
    }
  }

  async function request(path, init) {
    const suffix = String(path || "").startsWith("/")
      ? String(path || "")
      : `/${String(path || "")}`;
    let lastError = null;
    let lastNotFound = null;
    for (const origin of candidateOrigins()) {
      try {
        const response = await global.fetch(origin + suffix, init);
        if (response.status === 404) {
          lastNotFound = response;
          continue;
        }
        // A 401 still proves that this is the Confucius bridge; trying another
        // Zotero instance would hide a genuinely mismatched pairing token.
        rememberOrigin(origin);
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastNotFound) {
      return lastNotFound;
    }
    throw lastError || new Error("No local Confucius bridge is reachable");
  }

  global.ConfuciusBridge = {
    request,
    candidateOrigins,
    getOrigin: storedOrigin,
  };
})(typeof window !== "undefined" ? window : this);
