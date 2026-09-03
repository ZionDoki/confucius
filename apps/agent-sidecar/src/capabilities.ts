import { randomBytes } from "node:crypto";

interface Capability {
  token: string;
  taskId: string;
  expiresAt: number;
}

const CAPABILITY_TTL_MS = 12 * 60 * 60 * 1_000;

export class CapabilityStore {
  private readonly capabilities = new Map<string, Capability>();
  private readonly byTask = new Map<string, string>();

  issue(taskId: string): Capability {
    const existingToken = this.byTask.get(taskId);
    const existing = existingToken
      ? this.capabilities.get(existingToken)
      : undefined;
    if (existing) {
      existing.expiresAt = Date.now() + CAPABILITY_TTL_MS;
      return { ...existing };
    }
    const token = randomBytes(32).toString("base64url");
    const capability = {
      token,
      taskId,
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
    };
    this.capabilities.set(token, capability);
    this.byTask.set(taskId, token);
    return { ...capability };
  }

  resolve(token: string): Capability | null {
    const capability = this.capabilities.get(token);
    if (!capability) return null;
    if (capability.expiresAt <= Date.now()) {
      this.revoke(capability.taskId);
      return null;
    }
    capability.expiresAt = Date.now() + CAPABILITY_TTL_MS;
    return { ...capability };
  }

  revoke(taskId: string): void {
    const token = this.byTask.get(taskId);
    if (token) this.capabilities.delete(token);
    this.byTask.delete(taskId);
  }
}
