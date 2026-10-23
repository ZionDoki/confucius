import { config } from "../../../package.json";
import { getPref, setPref } from "../../utils/prefs";

// The read-only MCP profile gets its own credential so handing the MCP token to
// an external MCP host never grants the full HTTP API (RPC) surface.
const MCP_TOKEN_KEY = "mcpToken";

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function prefValue(name: string): string {
  try {
    return String(
      Zotero.Prefs.get(`${config.prefsPrefix}.${name}`, true) || "",
    );
  } catch {
    return "";
  }
}

function persistPref(name: string, value: string): boolean {
  try {
    Zotero.Prefs.set(`${config.prefsPrefix}.${name}`, value, true);
    return true;
  } catch {
    return false;
  }
}

export function ensurePairingToken(): string {
  const existing = getPref("pairingToken");
  if (existing) {
    return existing;
  }
  const token = randomToken();
  setPref("pairingToken", token);
  return token;
}

/** Read-only MCP credential, or "" when this profile has not provisioned one. */
export function readMcpToken(): string {
  return prefValue(MCP_TOKEN_KEY);
}

/**
 * Provision the read-only MCP credential once, from startup or the Security
 * pane. "" means this profile cannot persist it, so the MCP endpoint stays
 * closed; the pairing token is never accepted there as a fallback.
 */
export function ensureMcpToken(): string {
  const existing = readMcpToken();
  if (existing) {
    return existing;
  }
  const token = randomToken();
  return persistPref(MCP_TOKEN_KEY, token) ? token : "";
}
