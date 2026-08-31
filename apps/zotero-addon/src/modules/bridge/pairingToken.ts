import { getPref, setPref } from "../../utils/prefs";

export function ensurePairingToken(): string {
  const existing = getPref("pairingToken");
  if (existing) {
    return existing;
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  setPref("pairingToken", token);
  return token;
}
