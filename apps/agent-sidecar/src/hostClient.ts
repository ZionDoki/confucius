import type { HostRegistration } from "./types.js";

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

export class HostClient {
  private registration: HostRegistration | null = null;
  private nextId = 1;

  register(baseUrl: string, pairingToken: string): void {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("Confucius host must use a loopback HTTP address");
    }
    if (!pairingToken.trim()) throw new Error("Missing Zotero pairing token");
    this.registration = {
      baseUrl: baseUrl.replace(/\/$/, ""),
      pairingToken,
      registeredAt: Date.now(),
    };
  }

  clear(): void {
    this.registration = null;
  }

  get connected(): boolean {
    return this.registration !== null;
  }

  async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const registration = this.registration;
    if (!registration) throw new Error("Zotero host is not registered");
    const response = await fetch(`${registration.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registration.pairingToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(310_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Zotero host HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    const envelope = JSON.parse(text) as JsonRpcResponse<T>;
    if (envelope.error) {
      throw new Error(envelope.error.message || "Zotero host RPC failed");
    }
    return envelope.result as T;
  }
}
