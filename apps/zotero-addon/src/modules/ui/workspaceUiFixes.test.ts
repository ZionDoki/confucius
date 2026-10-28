import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recoverPendingWriteback } from "../host/ArtifactWriteback";
import {
  createModelSaveScheduler,
  endpointModelPatch,
} from "../preferences/prefsPane";
import { fileURLToPath } from "node:url";
import {
  createArtifactList,
  createPermissionSendGate,
  createPermissionUpdates,
  taskDeleteConfirmation,
  taskScopedFailure,
  taskSelectionCurrent,
  type PermissionMode,
} from "./workspaceTasks";

const uiDirectory = fileURLToPath(new URL("./", import.meta.url).href);
const preferencesDirectory = fileURLToPath(
  new URL("../preferences/", import.meta.url).href,
);

function source(name: string): string {
  return readFileSync(`${uiDirectory}${name}.ts`, "utf8");
}

function body(start: string, end: string, text: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return text.slice(from, to);
}

const view = source("WorkspaceView");
const writeback = source("artifactWriteback");
const prefsPane = readFileSync(`${preferencesDirectory}prefsPane.ts`, "utf8");

test("deleting a task requires an explicit confirmation naming the task", () => {
  const english = taskDeleteConfirmation("Graph review", "en-US");
  assert.match(english, /Graph review/);
  assert.match(english, /permanently deletes/);
  assert.match(english, /cannot be undone/);
  const chinese = taskDeleteConfirmation("图论综述", "zh-CN");
  assert.match(chinese, /图论综述/);
  assert.match(chinese, /永久删除/);
  assert.match(chinese, /无法撤销/);
  assert.match(
    view,
    /win\?\.confirm\(taskDeleteConfirmation\(title, configuredUiLanguage\(\)\)\)/,
  );
  assert.match(
    view,
    /if \(!win\?\.confirm\(taskDeleteConfirmation\(title, configuredUiLanguage\(\)\)\)\)\s*return;/,
  );
});

test("model fields write through the endpoint id instead of legacy prefs", () => {
  assert.deepEqual(endpointModelPatch("ep_1", "apiKey", "secret"), {
    endpoint: { id: "ep_1", apiKey: "secret" },
  });
  assert.deepEqual(endpointModelPatch("ep_1", "maxTokens", 4096), {
    endpoint: { id: "ep_1", maxTokens: 4096 },
  });
  assert.match(
    prefsPane,
    /win\.addEventListener\("focus", refreshModelFields\)/,
  );
  assert.match(prefsPane, /activeEndpointId = config\.activeEndpointId/);
  assert.match(prefsPane, /endpointModelPatch\(endpoint, field\.key, value\)/);
  // The old per-field legacy write would mix endpoint fields again.
  assert.doesNotMatch(prefsPane, /setPref\(field\.key/);
});

function fakeTimers() {
  let nextHandle = 0;
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer(callback: () => void, delay: number) {
      const handle = ++nextHandle;
      timers.set(handle, { at: now + delay, run: callback });
      return handle;
    },
    clearTimer(handle: number) {
      timers.delete(handle);
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.run();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

test("model field typing is debounced so a half-typed key is not written", () => {
  const timers = fakeTimers();
  const saves: string[] = [];
  const scheduler = createModelSaveScheduler({
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.schedule("apiKey", () => saves.push("s"));
  scheduler.schedule("apiKey", () => saves.push("se"));
  scheduler.schedule("apiKey", () => saves.push("secret"));
  timers.advance(399);
  assert.deepEqual(saves, [], "no write happens while the user is typing");
  timers.advance(1);
  assert.deepEqual(
    saves,
    ["secret"],
    "the debounce writes once with the newest value",
  );
  assert.equal(timers.pending, 0);
});

test("a committed edit cancels the debounced copy instead of writing twice", () => {
  const timers = fakeTimers();
  const saves: string[] = [];
  const scheduler = createModelSaveScheduler({
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.schedule("model", () => saves.push("debounced"));
  timers.advance(200);
  // change/blur commit the field through persistModelField, which cancels the
  // queued keystroke write before saving the same value.
  scheduler.cancel("model");
  saves.push("committed");
  assert.equal(timers.pending, 0, "the debounced copy was cancelled");
  timers.advance(400);
  assert.deepEqual(
    saves,
    ["committed"],
    "a committed field must not be written twice",
  );
});

test("closing Settings flushes every field that is still waiting to save", () => {
  const timers = fakeTimers();
  const saves: string[] = [];
  const scheduler = createModelSaveScheduler({
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.schedule("apiKey", () => saves.push("key"));
  scheduler.schedule("baseUrl", () => saves.push("url"));
  scheduler.flush();
  assert.deepEqual(saves, ["key", "url"], "unload saves the pending edits");
  assert.equal(timers.pending, 0);
  timers.advance(400);
  assert.deepEqual(saves, ["key", "url"], "flushed fields do not save again");
});

test("model fields persist on input with a debounce and flush on unload", () => {
  assert.match(prefsPane, /field\.el\.addEventListener\("input"/);
  assert.match(prefsPane, /delay: 400/);
  assert.match(prefsPane, /modelSaves\.schedule\(field\.key/);
  // change/blur still save immediately rather than waiting for the debounce.
  assert.match(
    prefsPane,
    /addEventListener\("change", \(\) => persistModelField\(field\)\)/,
  );
  assert.match(
    prefsPane,
    /addEventListener\("blur", \(\) => persistModelField\(field\)\)/,
  );
  const persist = body(
    "const persistModelField = (",
    "for (const field of modelFields)",
    prefsPane,
  );
  const cancel = persist.indexOf("modelSaves.cancel(field.key)");
  const save = persist.indexOf(
    "saveModelField(field, activeEndpointId, value)",
  );
  assert.ok(
    cancel !== -1 && save > cancel,
    "a committed edit drops the debounced copy before saving",
  );
  assert.match(
    prefsPane,
    /win\.addEventListener\(\s*"unload",\s*\(\) => \{\s*\/\/ Closing Settings must not lose a debounced edit\.\s*modelSaves\.flush\(\);/,
  );
});

test("template staging never writes its composer draft into another task", () => {
  const staging = body(
    "async function stageTemplate",
    "async function consumeLaunchIntent",
    view,
  );
  const localDraft = staging.indexOf("composerDrafts.set(task.id, draft)");
  const guard = staging.indexOf(
    "if (state.sessionId !== task.id || selection !== taskLoadGeneration)",
  );
  const composerWrite = staging.indexOf("prompt.value = draft");
  assert.ok(localDraft !== -1 && guard > localDraft && composerWrite > guard);
  assert.match(staging, /selection = taskLoadGeneration;/);
});

test("a failed template stage reports only to the task that still owns the composer", () => {
  const owner = { taskId: "a", generation: 4 };
  assert.deepEqual(
    taskScopedFailure(owner, { ...owner }, new Error("stage failed")),
    { taskId: "a", message: "stage failed" },
  );
  assert.equal(
    taskScopedFailure(owner, { taskId: "b", generation: 5 }, new Error("x")),
    null,
    "a failure after switching tasks must not become the new task's error",
  );
  assert.equal(
    taskScopedFailure(owner, { taskId: "a", generation: 5 }, new Error("x")),
    null,
    "a newer selection generation owns the visible error",
  );
  assert.equal(
    taskSelectionCurrent(
      { taskId: "created", generation: 8 },
      { taskId: "created", generation: 8 },
    ),
    true,
  );
  assert.equal(
    taskSelectionCurrent(
      { taskId: "created", generation: 8 },
      { taskId: "other", generation: 8 },
    ),
    false,
  );
  // The catch uses the shared fence, and the launch path fences its composer.
  const staging = body(
    "async function stageTemplate",
    "async function consumeLaunchIntent",
    view,
  );
  assert.match(staging, /taskScopedFailure\(/);
  assert.match(staging, /stagedTaskId = task\.id;/);
  const launch = body(
    "async function consumeLaunchIntent",
    "function artifactKindLabel",
    view,
  );
  const launchDraft = launch.indexOf("composerDrafts.set(created.id, draft)");
  const launchFence = launch.indexOf("taskSelectionCurrent(");
  const launchComposer = launch.indexOf("prompt.value = draft");
  assert.ok(
    launchDraft !== -1 &&
      launchFence > launchDraft &&
      launchComposer > launchFence,
  );
});

test("a superseded prompt keeps its text and attachments", () => {
  const sending = body(
    "async function sendPrompt",
    "async function resolveApproval",
    view,
  );
  const superseded = sending.indexOf("if (started.superseded)");
  const attachmentRemoval = sending.indexOf(
    "for (let index = pendingAttachments.length - 1",
  );
  assert.ok(superseded !== -1 && attachmentRemoval > superseded);
  assert.match(
    sending.slice(superseded, attachmentRemoval),
    /Prompt not submitted/,
  );
  assert.match(sending.slice(superseded, attachmentRemoval), /return;/);
  assert.match(
    body('resume.addEventListener("click", () => {', "})();", view),
    /if \(state\.sending\) return;/,
  );
});

test("approval decisions are caught and disabled while resolving", () => {
  const card = body(
    "function renderApprovalCard",
    "function currentTask",
    view,
  );
  assert.match(
    card,
    /for \(const control of decisions\) control\.disabled = true/,
  );
  assert.match(
    card,
    /void resolveApproval\(item\.id, verdict, scope\)\.catch\(/,
  );
  const resolve = body(
    "async function resolveApproval",
    "async function refreshConfig",
    view,
  );
  assert.match(resolve, /state\.sendError =/);
});

test("context updates do not reselect the captured task after an await", () => {
  const context = body(
    "async function updateTaskContext",
    "function renderTemplatePicker",
    view,
  );
  const guard = context.indexOf(
    "if (state.sessionId !== task.id || selection !== taskLoadGeneration)",
  );
  const reload = context.indexOf("await loadTask(task.id)");
  assert.ok(guard !== -1 && reload > guard);
  assert.match(context, /const selection = taskLoadGeneration;/);
});

function artifactHarness() {
  const state = {
    artifacts: [] as string[],
    artifactsTaskId: null as string | null,
    artifactError: null as string | null,
  };
  let selection = { taskId: "A", generation: 1 };
  const loads: {
    taskId: string;
    resolve: (artifacts: string[]) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const list = createArtifactList({
    state,
    load: (taskId) =>
      new Promise<string[]>((resolve, reject) => {
        loads.push({ taskId, resolve, reject });
      }),
    selection: () => selection,
  });
  return {
    state,
    list,
    loads,
    /** The task switch path: a new selection generation, list cleared. */
    startTask(taskId: string) {
      selection = { taskId, generation: selection.generation + 1 };
      list.select(taskId);
    },
    /** A selection change that did not clear the old list. */
    pointAt(taskId: string) {
      selection = { taskId, generation: selection.generation };
    },
    lastLoad() {
      return loads.at(-1)!;
    },
  };
}

test("switching tasks drops the previous artifact list and retries after a failed read", async () => {
  const h = artifactHarness();
  const first = h.list.refresh("A");
  h.loads[0].resolve(["a1"]);
  await first;
  assert.deepEqual(h.list.visible("A"), ["a1"]);

  h.startTask("B");
  assert.deepEqual(h.state.artifacts, [], "the old task's files are cleared");
  assert.equal(h.state.artifactsTaskId, "B");

  const failed = h.list.refresh("B");
  h.lastLoad().reject(new Error("artifact/list unavailable"));
  await failed;
  assert.deepEqual(h.list.visible("B"), []);
  assert.deepEqual(
    h.state.artifacts,
    [],
    "a failed read must not restore the previous task's files",
  );
  assert.equal(h.state.artifactError, "artifact/list unavailable");
  assert.equal(
    h.list.needsRefresh("B"),
    true,
    "the poll retries a task whose list never loaded",
  );

  const retried = h.list.refresh("B");
  h.lastLoad().resolve(["b1"]);
  await retried;
  assert.deepEqual(h.list.visible("B"), ["b1"]);
  assert.equal(h.state.artifactError, null);
});

test("a failed artifact read keeps the last list only for its own task", async () => {
  const h = artifactHarness();
  const loaded = h.list.refresh("A");
  h.lastLoad().resolve(["a1"]);
  await loaded;

  const sameTask = h.list.refresh("A");
  h.lastLoad().reject(new Error("temporary failure"));
  await sameTask;
  assert.deepEqual(h.list.visible("A"), ["a1"]);
  assert.equal(
    h.list.needsRefresh("A"),
    true,
    "a failed read retries on the next poll",
  );

  // A selection change that did not clear must not leak A's files into B.
  h.pointAt("B");
  assert.deepEqual(h.list.visible("B"), []);
  assert.equal(h.list.needsRefresh("B"), true);
  const staleOwner = h.list.refresh("B");
  h.lastLoad().reject(new Error("still unavailable"));
  await staleOwner;
  assert.deepEqual(h.state.artifacts, []);
  assert.equal(h.state.artifactsTaskId, "B");
  assert.equal(h.state.artifactError, "still unavailable");
});

test("only the newest artifact refresh for a task replaces the visible list", async () => {
  const h = artifactHarness();
  const older = h.list.refresh("A");
  const newest = h.list.refresh("A");
  h.loads[1].resolve(["new"]);
  await newest;
  h.loads[0].resolve(["old"]);
  await older;
  assert.deepEqual(h.list.visible("A"), ["new"]);

  const stale = h.list.refresh("A");
  h.startTask("B");
  const current = h.list.refresh("B");
  h.lastLoad().resolve(["b1"]);
  await current;
  h.loads.at(-2)!.resolve(["late a1"]);
  await stale;
  assert.deepEqual(h.state.artifacts, ["b1"]);
  assert.equal(h.state.artifactsTaskId, "B");
  assert.deepEqual(h.list.visible("A"), [], "A's late response stays out");
});

test("the view renders and opens only artifacts owned by the selected task", () => {
  assert.match(
    view,
    /const artifact = visibleArtifacts\(\)\.find\(\(item\) => item\.id === artifactId\)/,
  );
  assert.match(view, /for \(const artifact of visibleArtifacts\(\)\)/);
  assert.match(view, /artifactList\.needsRefresh\(polledSessionId\)/);
  const loading = body(
    "async function loadTask",
    "function syncFocusedReader",
    view,
  );
  const clear = loading.indexOf("artifactList.select(taskId)");
  const load = loading.indexOf('rpc("task/load"');
  assert.ok(
    clear !== -1 && clear < load,
    "a task switch clears the previous list before loading",
  );
});

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function permissionHarness(initial: PermissionMode) {
  const updates = createPermissionUpdates(initial);
  const gate = createPermissionSendGate();
  const sends: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  const rejections: { confirmed: PermissionMode; message: string }[] = [];
  const prompts: PermissionMode[] = [];
  const sendErrors: string[] = [];
  const apply = (mode: PermissionMode, isCurrent = () => true) => {
    const write = updates.apply(mode, {
      send: () =>
        new Promise<void>((resolve, reject) => {
          sends.push({ resolve, reject });
        }),
      isCurrent,
      rejected: (confirmed, error) =>
        rejections.push({ confirmed, message: messageOf(error) }),
    });
    gate.track(write);
    return write;
  };
  /** The view's send path: the permission write gates the prompt call. */
  const send = async (): Promise<boolean> => {
    try {
      await gate.wait();
    } catch (error) {
      sendErrors.push(messageOf(error));
      return false;
    }
    prompts.push(updates.confirmed);
    return true;
  };
  return {
    updates,
    gate,
    sends,
    rejections,
    prompts,
    sendErrors,
    apply,
    send,
  };
}

test("consecutive rejected permission choices roll back to the host-confirmed mode", async () => {
  const h = permissionHarness("ask");
  const first = h.apply("auto_allow");
  const second = h.apply("deny");
  await flushMicrotasks();
  assert.equal(h.sends.length, 1, "permission choices are serialized");
  h.sends[0].reject(new Error("first rejected"));
  await flushMicrotasks();
  assert.equal(h.sends.length, 2);
  h.sends[1].reject(new Error("second rejected"));
  await assert.rejects(second, /second rejected/);
  await assert.rejects(
    first,
    /first rejected/,
    "each queued write reports its own failure to its caller",
  );
  assert.equal(h.updates.confirmed, "ask");
  assert.deepEqual(
    h.rejections,
    [{ confirmed: "ask", message: "second rejected" }],
    "the second failure rolls back to the host value, not the first optimistic one",
  );
});

test("a rejected permission choice rolls back to the last host-confirmed value", async () => {
  const h = permissionHarness("ask");
  const first = h.apply("auto_allow");
  await flushMicrotasks();
  h.sends[0].resolve();
  await first;
  assert.equal(h.updates.confirmed, "auto_allow");

  const second = h.apply("deny");
  await flushMicrotasks();
  h.sends[1].reject(new Error("denied by host"));
  await assert.rejects(second, /denied by host/);
  assert.equal(h.updates.confirmed, "auto_allow");
  assert.deepEqual(h.rejections, [
    { confirmed: "auto_allow", message: "denied by host" },
  ]);
});

test("a stale permission failure does not roll back another task's mode", async () => {
  const h = permissionHarness("ask");
  let current = true;
  const update = h.apply("deny", () => current);
  await flushMicrotasks();
  current = false;
  h.sends[0].reject(new Error("old task"));
  await assert.rejects(update, /old task/);
  assert.equal(h.updates.confirmed, "ask");
  assert.deepEqual(h.rejections, []);
});

test("a task load adopts the host-confirmed mode as the rollback target", async () => {
  const h = permissionHarness("deny");
  h.updates.reset("auto_allow");
  const update = h.apply("ask");
  await flushMicrotasks();
  h.sends[0].reject(new Error("not saved"));
  await assert.rejects(update, /not saved/);
  assert.equal(h.updates.confirmed, "auto_allow");
  assert.deepEqual(h.rejections, [
    { confirmed: "auto_allow", message: "not saved" },
  ]);
});

test("a failed permission write aborts the send instead of using the old mode", async () => {
  const h = permissionHarness("ask");
  h.apply("deny");
  const sending = h.send();
  await flushMicrotasks();
  assert.equal(h.sends.length, 1, "the permission write was attempted");
  h.sends[0].reject(new Error("prefs write failed"));
  assert.equal(await sending, false);
  assert.deepEqual(
    h.prompts,
    [],
    "task/prompt must not start with the host's previous mode",
  );
  assert.deepEqual(h.sendErrors, ["prefs write failed"]);
  assert.equal(h.updates.confirmed, "ask", "the visible mode rolls back");
  assert.deepEqual(h.rejections, [
    { confirmed: "ask", message: "prefs write failed" },
  ]);

  // The failure must not poison the next send: the gate settles to resolved.
  assert.equal(await h.send(), true);
  assert.deepEqual(h.prompts, ["ask"]);
  assert.equal(h.sends.length, 1, "the retry reused the settled gate");
});

test("a later successful permission choice sends normally", async () => {
  const h = permissionHarness("ask");
  h.apply("deny");
  const failed = h.send();
  await flushMicrotasks();
  h.sends[0].reject(new Error("not saved"));
  assert.equal(await failed, false);
  assert.deepEqual(h.prompts, []);

  h.apply("auto_allow");
  const sent = h.send();
  await flushMicrotasks();
  assert.equal(
    h.sends.length,
    2,
    "the new choice is written after the failure",
  );
  h.sends[1].resolve();
  assert.equal(await sent, true);
  assert.deepEqual(h.prompts, ["auto_allow"]);
  assert.equal(h.updates.confirmed, "auto_allow");
  assert.deepEqual(h.rejections, [{ confirmed: "ask", message: "not saved" }]);
});

test("a reported permission failure does not block a later send", async () => {
  const h = permissionHarness("ask");
  h.apply("deny");
  await flushMicrotasks();
  h.sends[0].reject(new Error("not saved"));
  await flushMicrotasks();
  assert.equal(h.updates.confirmed, "ask");
  assert.deepEqual(h.sendErrors, []);
  assert.equal(
    await h.send(),
    true,
    "a failure reported before the send must not abort it",
  );
  assert.deepEqual(h.prompts, ["ask"]);
});

test("sendPrompt aborts a turn whose permission write failed", () => {
  const sending = body(
    "async function sendPrompt",
    "async function resolveApproval",
    view,
  );
  const gateWait = sending.indexOf("pendingPermissionGate.wait()");
  const promptCall = sending.indexOf('rpc("task/prompt"');
  assert.ok(
    gateWait !== -1 && promptCall > gateWait,
    "task/prompt waits for the permission write",
  );
  assert.match(
    sending,
    /const pendingPermissionUpdate = pendingPermissionGate\.wait\(\);/,
  );
  assert.match(
    sending,
    /await Promise\.all\(\[\s*pendingPermissionUpdate,\s*mentionSources\.flush\(promptSessionId\)/,
    "the prompt still waits for the permission write and the mention flush",
  );
  assert.match(
    sending,
    /state\.sendError = message;/,
    "the send catch surfaces the failure",
  );
  assert.match(
    view,
    /const pendingPermissionGate = createPermissionSendGate\(\)/,
  );
  assert.match(
    view,
    /pendingPermissionGate\.track\(\s*permissionUpdates\.apply\(/,
  );
  const loading = body(
    "async function loadTask",
    "function syncFocusedReader",
    view,
  );
  const resetMode = loading.indexOf(
    "permissionUpdates.reset(state.permission)",
  );
  const resetGate = loading.indexOf("pendingPermissionGate.reset()");
  assert.ok(
    resetMode !== -1 && resetGate > resetMode,
    "a task load must not inherit another task's rejected gate",
  );
});

test("a failed writeback preview leaves a retry path", () => {
  assert.match(writeback, /let previewReady = false;/);
  assert.match(
    writeback,
    /if \(!previewReady\) \{\s*void loadPreview\(\);\s*return;/,
  );
  const preview = body(
    "const loadPreview = async () => {",
    "cancel.addEventListener",
    writeback,
  );
  const failure = preview.slice(preview.indexOf("} catch (error) {"));
  assert.match(failure, /requestApproval\.disabled = false/);
});

test("an unknown write outcome never promotes a planned note key", () => {
  const previous = {
    state: "pending" as const,
    target: "zotero_note" as const,
    revision: 1,
    operationId: "op",
  };
  const operation = {
    id: "op",
    name: "create_note",
    args: { libraryID: 1 },
    context: { plannedKeys: { item: "PLANNED" } },
    resources: [] as string[],
    startedAt: 1,
  };
  const unknown = recoverPendingWriteback(previous, {
    ...operation,
    result: {
      ok: true as const,
      toolName: "create_note",
      effect: "unknown" as const,
      data: {},
    },
  });
  assert.equal(unknown.state, "unknown");
  assert.equal(
    unknown.targetRef,
    undefined,
    "ok:true with an unknown effect is not a committed write",
  );
  const applied = recoverPendingWriteback(previous, {
    ...operation,
    result: {
      ok: true as const,
      toolName: "create_note",
      effect: "applied" as const,
      data: {},
    },
  });
  assert.equal(applied.state, "committed");
  assert.equal(applied.targetRef, "1:PLANNED");
});
