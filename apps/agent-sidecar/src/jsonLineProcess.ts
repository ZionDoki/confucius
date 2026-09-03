import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (message: JsonRpcMessage) => void
  >();
  private readonly requestListeners = new Set<
    (message: JsonRpcMessage) => void
  >();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private stderr = "";
  private intentionalClose = false;

  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code) => {
      this.failAll(
        new Error(
          `Runtime exited (${code ?? "signal"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
        ),
      );
    });
  }

  onNotification(listener: (message: JsonRpcMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (message: JsonRpcMessage) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.send({ id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  respond(id: string | number | null, result: unknown): void {
    this.send({ id, result });
  }

  respondError(
    id: string | number | null,
    code: number,
    message: string,
  ): void {
    this.send({ id, error: { code, message } });
  }

  close(): void {
    this.intentionalClose = true;
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child.stdin.writable) throw new Error("Runtime stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id ?? "");
      if (!pending) return;
      this.pending.delete(message.id ?? "");
      if (message.error) {
        pending.reject(new Error(message.error.message || "Runtime RPC error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      for (const listener of this.requestListeners) listener(message);
      return;
    }
    for (const listener of this.notificationListeners) listener(message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.intentionalClose) {
      for (const listener of this.failureListeners) listener(error);
    }
  }
}
