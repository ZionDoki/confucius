import {
  CONFUCIUS_HTTP_PREFIX,
  CONFUCIUS_LOOPBACK_ORIGIN,
  type ApprovalResolution,
  type ConfuciusEvent,
  type RuntimeListResult,
  type RuntimeStatus,
} from "@confucius/protocol";
import { getPref } from "../../utils/prefs";
import { createAbortController, hostFetch } from "../../utils/webPlatform";

export interface SidecarDescriptor {
  protocol: 1;
  pid: number;
  baseUrl: string;
  token: string;
  version: string;
  startedAt: number;
}

export interface SidecarDescriptorReader {
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

class ZoteroDescriptorReader implements SidecarDescriptorReader {
  read(path: string): Promise<string> {
    return IOUtils.readUTF8(path);
  }

  exists(path: string): Promise<boolean> {
    return IOUtils.exists(path);
  }
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { message?: string };
}

export interface SidecarEventPage {
  events: ConfuciusEvent[];
  cursorFound: boolean;
}

/** Discovers the user-started sidecar and keeps the pairing secret in memory. */
export class SidecarClient {
  private registeredDescriptorKey = "";
  private rpcId = 1;

  constructor(
    private readonly descriptorPath = defaultDescriptorPath(),
    private readonly reader: SidecarDescriptorReader = new ZoteroDescriptorReader(),
    private readonly fetchImpl: typeof fetch = hostFetch,
    private readonly pairingToken: () => string = () =>
      String(getPref("pairingToken") || ""),
  ) {}

  async listRuntimes(refresh = false): Promise<RuntimeListResult> {
    try {
      const result = await this.rpc<{
        hostConnected?: boolean;
        runtimes?: RuntimeStatus[];
      }>(refresh ? "runtime/refresh" : "runtime/list", {});
      return {
        sidecarConnected: true,
        runtimes: result.runtimes ?? [],
      };
    } catch {
      this.registeredDescriptorKey = "";
      return { sidecarConnected: false, runtimes: unavailableRuntimes() };
    }
  }

  async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const descriptor = await this.connect();
    return this.request<T>(descriptor, method, params);
  }

  async events(
    taskId: string,
    afterId?: string,
    waitMs = 1_000,
    signal?: AbortSignal,
  ): Promise<SidecarEventPage> {
    const descriptor = await this.connect();
    const url = new URL(`${descriptor.baseUrl}/events`);
    url.searchParams.set("taskId", taskId);
    if (afterId) url.searchParams.set("afterId", afterId);
    url.searchParams.set("waitMs", String(waitMs));
    const response = await this.fetchImpl(url.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Sidecar events HTTP ${response.status}`);
    }
    return (await response.json()) as unknown as SidecarEventPage;
  }

  resolveApproval(resolution: ApprovalResolution): Promise<unknown> {
    return this.rpc(
      "approval/resolve",
      resolution as unknown as Record<string, unknown>,
    );
  }

  reset(): void {
    this.registeredDescriptorKey = "";
  }

  private async connect(): Promise<SidecarDescriptor> {
    const descriptor = await this.loadDescriptor();
    const key = `${descriptor.pid}:${descriptor.startedAt}:${descriptor.baseUrl}`;
    if (this.registeredDescriptorKey !== key) {
      const response = await this.fetchImpl(`${descriptor.baseUrl}/health`, {
        method: "GET",
      });
      if (!response.ok) throw new Error("Agent sidecar health check failed");
      // The Zotero pairing token crosses only this authenticated loopback
      // request. It is never copied into the descriptor or runtime config.
      await this.request(descriptor, "host/register", {
        baseUrl: `${CONFUCIUS_LOOPBACK_ORIGIN}${CONFUCIUS_HTTP_PREFIX}`,
        pairingToken: this.pairingToken(),
      });
      this.registeredDescriptorKey = key;
    }
    return descriptor;
  }

  private async loadDescriptor(): Promise<SidecarDescriptor> {
    if (!(await this.reader.exists(this.descriptorPath))) {
      throw new Error("Agent sidecar is not running. Run npm run sidecar.");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(await this.reader.read(this.descriptorPath));
    } catch {
      throw new Error("Agent sidecar descriptor is invalid");
    }
    const descriptor = validateDescriptor(candidate);
    return descriptor;
  }

  private async request<T>(
    descriptor: SidecarDescriptor,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(`${descriptor.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.rpcId++,
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error(`Agent sidecar HTTP ${response.status}`);
    const envelope = (await response.json()) as RpcEnvelope<T>;
    if (envelope.error) {
      throw new Error(envelope.error.message || "Agent sidecar request failed");
    }
    return envelope.result as T;
  }
}

export function validateDescriptor(value: unknown): SidecarDescriptor {
  if (!value || typeof value !== "object") {
    throw new Error("Agent sidecar descriptor is invalid");
  }
  const row = value as Record<string, unknown>;
  const baseUrl = String(row.baseUrl ?? "").replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Agent sidecar descriptor has an invalid URL");
  }
  if (
    row.protocol !== 1 ||
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !Number.isInteger(row.pid) ||
    Number(row.pid) <= 0 ||
    typeof row.token !== "string" ||
    row.token.length < 32 ||
    typeof row.version !== "string" ||
    !Number.isFinite(row.startedAt)
  ) {
    throw new Error("Agent sidecar descriptor failed validation");
  }
  return {
    protocol: 1,
    pid: Number(row.pid),
    baseUrl,
    token: row.token,
    version: row.version,
    startedAt: Number(row.startedAt),
  };
}

export function defaultDescriptorPath(): string {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return PathUtils.join(home, ".confucius", "sidecar.json");
}

export function unavailableRuntimes(): RuntimeStatus[] {
  const checkedAt = Date.now();
  return (["codex", "kimi"] as const).map((backend) => ({
    backend,
    state: "unavailable",
    message: "Start the companion with npm run sidecar.",
    checkedAt,
  }));
}

export function sidecarAbortController(): AbortController {
  return createAbortController();
}
