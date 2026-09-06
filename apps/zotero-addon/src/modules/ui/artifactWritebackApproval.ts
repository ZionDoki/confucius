import type { WorkspaceHost } from "./WorkspaceView";

export interface WritebackPreview {
  before: string;
  after: string;
}

/** Owns only this dialog's approval; closing it must not leave a hidden request. */
export class ArtifactWritebackApproval {
  private id?: string;
  private closed = false;

  constructor(private readonly host: WorkspaceHost) {}

  get pending(): boolean {
    return this.id !== undefined;
  }

  async prepare(
    params: Record<string, unknown>,
  ): Promise<WritebackPreview | undefined> {
    const result = (await this.host.rpc(
      "artifact/writebackCommit",
      params,
    )) as {
      approvalId: string;
      preview: WritebackPreview;
    };
    if (this.closed) {
      await this.resolve(result.approvalId, "deny");
      return undefined;
    }
    this.id = result.approvalId;
    return result.preview;
  }

  async approve(): Promise<void> {
    if (!this.id || this.closed) return;
    const id = this.id;
    // The explicit confirmation has started. Window closure must not race it
    // with a denial, nor suggest an already approved write was cancelled.
    this.id = undefined;
    try {
      await this.resolve(id, "allow");
    } catch (error) {
      if (!this.closed) this.id = id;
      else await this.resolve(id, "deny").catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const id = this.id;
    this.id = undefined;
    if (id) await this.resolve(id, "deny");
  }

  private async resolve(id: string, verdict: "allow" | "deny"): Promise<void> {
    await this.host.rpc("approval/resolve", { id, verdict, scope: "once" });
  }
}
