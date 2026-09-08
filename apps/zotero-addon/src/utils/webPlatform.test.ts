import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  createAbortController,
  hostFetch,
  hostFetchCanStream,
  installWebPlatform,
} from "./webPlatform";

class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  statusText = "";
  readyState = 0;
  responseText = "";
  responseType = "";
  timeout = 0;
  method = "";
  url = "";
  body: unknown;
  abortCount = 0;
  requestHeaders: Record<string, string> = {};
  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(key: string, value: string) {
    this.requestHeaders[key] = value;
  }
  getResponseHeader(name: string) {
    return name.toLowerCase() === "content-type" ? "text/event-stream" : null;
  }
  send(body: unknown) {
    this.body = body;
  }
  headers(status = 200) {
    this.status = status;
    this.statusText = status === 200 ? "OK" : "Error";
    this.readyState = 2;
    this.onreadystatechange?.();
  }
  progress(text: string) {
    this.responseText = text;
    this.readyState = 3;
    this.onprogress?.();
  }
  doneState() {
    this.readyState = 4;
    this.onreadystatechange?.();
  }
  load(text = this.responseText) {
    this.responseText = text;
    this.doneState();
    this.onload?.();
  }
  networkError() {
    this.status = 0;
    this.doneState();
    this.onerror?.();
  }
  abort() {
    this.abortCount++;
    this.status = 0;
    this.doneState();
    this.onabort?.();
  }
}

function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}
function fixture(t: TestContext) {
  FakeXHR.instances = [];
  replaceGlobal(t, "XMLHttpRequest", FakeXHR);
  return () => FakeXHR.instances.at(-1)!;
}
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
const bodyReader = (response: Response): ByteReader =>
  response.body!.getReader() as unknown as ByteReader;
const decode = (result: { done: boolean; value?: Uint8Array }) =>
  new TextDecoder().decode(result.value);

test("XHR exposes headers and incremental protocol bytes before EOF without duplicating progress", async (t) => {
  const last = fixture(t);
  assert.equal(hostFetchCanStream(), true);
  const pending = hostFetch("http://localhost/model", {
    method: "POST",
    headers: [["x-test", "yes"]],
    body: "request",
  });
  const xhr = last();
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "http://localhost/model");
  assert.equal(xhr.body, "request");
  assert.equal(xhr.requestHeaders["x-test"], "yes");
  xhr.headers();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = bodyReader(response);
  const first = reader.read();
  xhr.progress('data: {"text":"hello"}\n\n');
  assert.equal(decode(await first), 'data: {"text":"hello"}\n\n');
  let resolved = false;
  const second = reader.read().then((value) => {
    resolved = true;
    return value;
  });
  xhr.onprogress?.();
  await Promise.resolve();
  assert.equal(resolved, false);
  xhr.progress('data: {"text":"hello"}\n\ndata: [DONE]\n\n');
  assert.equal(decode(await second), "data: [DONE]\n\n");
  xhr.load();
  assert.equal((await reader.read()).done, true);
});

test("XHR preserves Unicode when a progress boundary splits a surrogate pair", async (t) => {
  const last = fixture(t);
  const pending = hostFetch("http://localhost/model");
  const xhr = last();
  xhr.headers();
  const reader = bodyReader(await pending);
  xhr.progress("你\uD83D");
  assert.equal(decode(await reader.read()), "你");
  const tail = reader.read();
  xhr.progress("你\uD83D\uDE00");
  assert.equal(decode(await tail), "😀");
  xhr.load();
  assert.equal((await reader.read()).done, true);
});

test("DONE readyState is not successful EOF until the load event", async (t) => {
  const last = fixture(t);
  const pending = hostFetch("http://localhost/model");
  const xhr = last();
  xhr.headers();
  const reader = bodyReader(await pending);
  let resolved = false;
  const read = reader.read().then((value) => {
    resolved = true;
    return value;
  });
  xhr.doneState();
  await Promise.resolve();
  assert.equal(resolved, false);
  xhr.onload?.();
  assert.equal((await read).done, true);
});

test("a network error before headers rejects fetch", async (t) => {
  const last = fixture(t);
  const pending = hostFetch("http://localhost/model");
  const rejected = assert.rejects(pending, /HTTP request failed/);
  last().networkError();
  await rejected;
});

test("a network error after partial bytes rejects readers even when DONE arrives first", async (t) => {
  const last = fixture(t);
  const pending = hostFetch("http://localhost/model");
  const xhr = last();
  xhr.headers();
  const response = await pending;
  const reader = bodyReader(response);
  xhr.progress('data: {"tool_call":');
  assert.equal(decode(await reader.read()), 'data: {"tool_call":');
  const readError = assert.rejects(reader.read(), /HTTP request failed/);
  const textError = assert.rejects(response.text(), /HTTP request failed/);
  xhr.networkError();
  await Promise.all([readError, textError]);
  await assert.rejects(reader.read(), /HTTP request failed/);
});

test("an already aborted request creates no XHR", async (t) => {
  fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    hostFetch("http://localhost/model", { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(FakeXHR.instances.length, 0);
});

test("signal cancellation aborts XHR and rejects all pending body consumers", async (t) => {
  const last = fixture(t);
  const controller = new AbortController();
  const pending = hostFetch("http://localhost/model", {
    signal: controller.signal,
  });
  const xhr = last();
  xhr.headers();
  const response = await pending;
  const rejectedRead = assert.rejects(bodyReader(response).read(), {
    name: "AbortError",
  });
  const rejectedText = assert.rejects(response.text(), { name: "AbortError" });
  controller.abort();
  await Promise.all([rejectedRead, rejectedText]);
  assert.equal(xhr.abortCount, 1);
});

test("reader cancellation terminates its request and completed requests release abort listeners", async (t) => {
  const last = fixture(t);
  const pending = hostFetch("http://localhost/model");
  const xhr = last();
  xhr.headers();
  const reader = bodyReader(await pending);
  const readError = assert.rejects(reader.read(), { name: "AbortError" });
  await reader.cancel();
  await readError;
  assert.equal(xhr.abortCount, 1);

  const controller = new AbortController();
  const completed = hostFetch("http://localhost/next", {
    signal: controller.signal,
  });
  const next = last();
  next.headers();
  next.load('{"ok":true}');
  const response = await completed;
  controller.abort();
  assert.equal(next.abortCount, 0);
  assert.deepEqual(await response.json(), { ok: true });
});

test("HTTP error status preserves its response body for provider error classification", async (t) => {
  const last = fixture(t);
  const pending = hostFetch("http://localhost/model");
  const xhr = last();
  xhr.headers(429);
  xhr.load('{"error":"rate limit"}');
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate limit" });
});

test("sandbox AbortController works without window APIs and only notifies once", (t) => {
  replaceGlobal(t, "AbortController", undefined);
  replaceGlobal(t, "Zotero", undefined);
  const controller = createAbortController();
  let notifications = 0;
  controller.signal.addEventListener("abort", () => {
    notifications++;
  });
  controller.abort();
  controller.abort();
  assert.equal(controller.signal.aborted, true);
  assert.equal(notifications, 1);
  assert.throws(() => controller.signal.throwIfAborted(), {
    name: "AbortError",
  });
  const installed: Record<string, unknown> = {};
  installWebPlatform(installed);
  assert.equal(typeof installed.AbortController, "function");
  assert.equal(installed.fetch, hostFetch);
});

test("sandbox codecs survive an unavailable main window and invalid borrowed constructors", (t) => {
  const NativeEncoder = TextEncoder,
    NativeDecoder = TextDecoder;
  let created = 0;
  replaceGlobal(t, "Components", {
    utils: {
      Sandbox: function (
        _principal: unknown,
        options: { wantGlobalProperties: string[] },
      ) {
        assert.deepEqual(options.wantGlobalProperties, [
          "TextEncoder",
          "TextDecoder",
        ]);
        created++;
        return { TextEncoder: NativeEncoder, TextDecoder: NativeDecoder };
      },
    },
  });
  replaceGlobal(t, "Services", {
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
  });
  replaceGlobal(t, "Zotero", {
    getMainWindow: () => {
      throw new Error("No main window");
    },
  });
  const target = { TextEncoder: null, TextDecoder: {} } as unknown as {
    TextEncoder: typeof TextEncoder;
    TextDecoder: typeof TextDecoder;
  };
  installWebPlatform(target);
  assert.equal(created, 1);
  const bytes = new target.TextEncoder().encode("论文与证据 😀");
  assert.equal(
    new target.TextDecoder("utf-8", { fatal: true }).decode(bytes),
    "论文与证据 😀",
  );
  const stream = new target.TextDecoder();
  assert.equal(
    stream.decode(bytes.slice(0, 2), { stream: true }) +
      stream.decode(bytes.slice(2)),
    "论文与证据 😀",
  );
});

test("UTF-8 fallback encodes Unicode and never writes a partial code point", (t) => {
  const NativeEncoder = TextEncoder;
  replaceGlobal(t, "TextEncoder", undefined);
  replaceGlobal(t, "Components", undefined);
  replaceGlobal(t, "Zotero", undefined);
  const target = { TextEncoder: () => undefined } as unknown as {
    TextEncoder: typeof TextEncoder;
  };
  installWebPlatform(target);
  const encoder = new target.TextEncoder();
  assert.equal(encoder.encoding, "utf-8");
  for (const text of ["", "ASCII", "中文😀é𝄞", "\ud800broken\udfff", "a\0b"]) {
    assert.deepEqual(encoder.encode(text), new NativeEncoder().encode(text));
    for (let size = 0; size < 18; size++) {
      const actual = new Uint8Array(size),
        expected = new Uint8Array(size);
      assert.deepEqual(
        encoder.encodeInto(text, actual),
        new NativeEncoder().encodeInto(text, expected),
      );
      assert.deepEqual(actual, expected);
    }
  }
});

test("buffered Zotero fallback cancels even when its canceller arrives after abort", async (t) => {
  replaceGlobal(t, "XMLHttpRequest", undefined);
  let receiveCancel!: (cancel: () => void) => void;
  let rejectRequest!: (reason: Error) => void;
  let cancellations = 0;
  replaceGlobal(t, "Zotero", {
    HTTP: {
      request: (
        _method: string,
        _url: string,
        options: { cancellerReceiver: (cancel: () => void) => void },
      ) => {
        receiveCancel = options.cancellerReceiver;
        return new Promise<never>((_resolve, reject) => {
          rejectRequest = reject;
        });
      },
    },
  });
  assert.equal(hostFetchCanStream(), false);
  const controller = new AbortController();
  const pending = hostFetch("http://localhost/model", {
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  receiveCancel(() => {
    cancellations++;
    rejectRequest(new Error("native cancellation"));
  });
  await rejected;
  assert.equal(cancellations, 1);
});
