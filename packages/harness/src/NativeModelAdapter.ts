import {
  modelApiHeaders,
  modelApiUrl,
  resolveModelProtocol,
  type ModelApiProtocol,
} from "@confucius/protocol";
import {
  OpenAICompatibleAdapter,
  httpModelError,
  type OpenAICompatibleConfig,
} from "./OpenAICompatibleAdapter";
import {
  ModelError,
  type ModelAdapter,
  type ModelRequest,
  type ModelTurn,
} from "./ModelAdapter";
import { ModelDeadline } from "./ModelDeadline";
import { retryModelRequest } from "./ModelRetry";
import { abortError, isAbortError } from "./abort";
import { createWireCodec, type NativeWireProtocol } from "./NativeWireCodec";

export interface NativeModelConfig extends OpenAICompatibleConfig {
  protocol?: ModelApiProtocol;
}

export function createNativeModelAdapter(
  config: NativeModelConfig,
): ModelAdapter {
  const protocol = resolveModelProtocol(config.baseUrl, config.protocol);
  if (protocol === "openai" || protocol === "ollama") {
    const route = modelApiUrl(
      config.baseUrl,
      protocol,
      protocol === "ollama" ? "/api/chat" : "/chat/completions",
    );
    return new OpenAICompatibleAdapter({
      ...config,
      baseUrl: route,
      apiStyle: protocol,
    });
  }
  return new NativeWireAdapter(config, protocol);
}

/** Every protocol uses the same bounded retries, cancellation and host accounting. */
class NativeWireAdapter implements ModelAdapter {
  readonly handlesRetries = true;
  readonly accountsAttempts = true;
  constructor(
    private config: NativeModelConfig,
    private protocol: NativeWireProtocol,
  ) {}

  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn> {
    const started = Date.now();
    return retryModelRequest(
      async (progress) => {
        const remaining =
          request.deadlineMs === undefined
            ? undefined
            : request.deadlineMs - (Date.now() - started);
        return this.once({ ...request, deadlineMs: remaining }, signal, {
          ...this.config,
          onTextDelta: (text) => this.config.onTextDelta?.(text, progress),
          onReasoningDelta: (text) =>
            this.config.onReasoningDelta?.(text, progress),
        });
      },
      {
        ...this.config,
        signal,
        requestId: request.requestId,
        maxAttempts: request.maxAttempts,
        onProgress: async (progress) => {
          await request.onRequestProgress?.(progress);
          await this.config.onRequestProgress?.(progress);
        },
      },
    );
  }

  private async once(
    request: ModelRequest,
    signal: AbortSignal | undefined,
    config: NativeModelConfig,
  ): Promise<ModelTurn> {
    // Host budget/checkpoint failures are not transport failures.
    if (signal?.aborted) throw abortError();
    await request.onAttempt?.();
    if (signal?.aborted) throw abortError();
    const codec = createWireCodec(this.protocol, config);
    const stream = config.stream !== false;
    const body = codec.request(request, stream);
    const deadline = new ModelDeadline(
      signal,
      {
        ...config.timeouts,
        absoluteMs: Math.max(
          1,
          Math.min(
            config.timeouts?.absoluteMs ?? 600_000,
            request.deadlineMs ?? Infinity,
          ),
        ),
      },
      config.createAbortController,
      config,
    );
    let reader:
      | {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          cancel(): Promise<void>;
        }
      | undefined;
    try {
      const response = await deadline.race(
        (config.fetchImpl ?? fetch)(codec.url(stream), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...modelApiHeaders(this.protocol, config.apiKey),
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        }),
      );
      if (!response.ok) {
        const text = await deadline.race(response.text());
        throw httpModelError(
          response.status,
          text,
          response.headers?.get?.("retry-after") ?? "",
        );
      }
      const contentType = response.headers?.get?.("content-type") ?? "";
      let streamed = false;
      if (
        stream &&
        contentType.includes("text/event-stream") &&
        response.body?.getReader
      ) {
        streamed = true;
        const activeReader =
          response.body.getReader() as unknown as NonNullable<typeof reader>;
        reader = activeReader;
        const parser = new ModelSseParser((data) =>
          codec.accept(parseJson(data), true),
        );
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await deadline.race(activeReader.read());
          if (value?.length) {
            deadline.received();
            parser.push(decoder.decode(value, { stream: true }));
          }
          if (done) {
            parser.push(decoder.decode());
            parser.finish();
            break;
          }
          if (codec.terminal && this.protocol !== "gemini") {
            void activeReader.cancel().catch(() => undefined);
            break;
          }
        }
      } else {
        const text = await deadline.race(response.text());
        deadline.received();
        if (
          stream &&
          (contentType.includes("text/event-stream") || /^data:/m.test(text))
        ) {
          streamed = true;
          const parser = new ModelSseParser((data) =>
            codec.accept(parseJson(data), true),
          );
          parser.push(text);
          parser.finish();
        } else codec.accept(parseJson(text), false);
      }
      if (signal?.aborted) throw abortError();
      const result = codec.result(streamed);
      if (result.usage) config.onUsage?.(result.usage);
      return result;
    } catch (error) {
      if (reader) void reader.cancel().catch(() => undefined);
      if (isAbortError(error) || signal?.aborted) throw abortError();
      const failure =
        error instanceof ModelError
          ? error
          : new ModelError(
              error instanceof Error ? error.message : String(error),
              "transport",
              { retryable: true },
            );
      throw new ModelError(failure.message, failure.code, {
        ...failure.options,
        partial: codec.partial(),
      });
    } finally {
      deadline.dispose();
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("Malformed JSON in model response", "protocol");
  }
}

/** SSE fields may cross byte boundaries and one event may contain several data lines. */
export class ModelSseParser {
  private buffer = "";
  private data: string[] = [];
  constructor(private receive: (data: string) => void) {}
  push(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, end).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(end + 1);
    }
  }
  private line(line: string): void {
    if (!line) this.flush();
    else if (line.startsWith("data:"))
      this.data.push(line.slice(5).replace(/^ /, ""));
  }
  private flush(): void {
    if (!this.data.length) return;
    const data = this.data.join("\n");
    this.data = [];
    if (data !== "[DONE]") this.receive(data);
  }
  finish(): void {
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.flush();
  }
}
