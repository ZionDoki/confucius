import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactRecord } from "@confucius/protocol";
import {
  ArtifactWindows,
  ARTIFACT_WINDOW_FEATURES,
  openNativeArtifactWindow,
} from "./artifactWindow";
import { artifactRevisionSelection } from "./artifactWindowView";
import { ArtifactWritebackApproval } from "./artifactWritebackApproval";
import { citationTarget, hydrateReadingCitations } from "./readingCitations";

test("report citation components navigate to the recorded physical page and native annotation", () => {
  const citation = {
    id: "e1",
    itemLibraryID: 3,
    itemKey: "PARENT",
    attachmentKey: "PDF",
    page: 4,
    annotationKey: "MARK",
    title: "Source",
    quote: "Evidence",
  };
  const clicked: unknown[] = [];
  let replacement: HTMLElement | undefined;
  const marker = {
    getAttribute: () => "e1",
    replaceWith: (node: HTMLElement) => {
      replacement = node;
    },
  };
  const root = {
    ownerDocument: {},
    querySelectorAll: () => [marker],
  } as unknown as HTMLElement;
  hydrateReadingCitations(root, [citation], (_doc, target) => {
    const button = Object.assign(new EventTarget(), {
      classList: { add: () => {} },
      setAttribute: () => {},
      title: "",
      textContent: "",
    });
    button.addEventListener("click", () => clicked.push(target));
    return button as unknown as HTMLElement;
  });
  assert.equal(replacement?.textContent, "p. 4");
  replacement!.dispatchEvent(new Event("click"));
  assert.deepEqual(clicked, [
    { libraryID: 3, key: "PDF", pageIndex: 3, annotationKey: "MARK" },
  ]);
  assert.match(replacement!.title, /Evidence/);
  assert.deepEqual(citationTarget({ itemLibraryID: 1, itemKey: "ABSTRACT" }), {
    libraryID: 1,
    key: "ABSTRACT",
    pageIndex: undefined,
    annotationKey: undefined,
    selectItem: true,
  });
  replacement = undefined;
  hydrateReadingCitations(root, [citation, citation], () =>
    assert.fail("must not guess a duplicate citation"),
  );
  hydrateReadingCitations(root, [], () =>
    assert.fail("must not guess a missing citation"),
  );
  assert.equal(replacement, undefined);
});

class FakeWindow extends EventTarget {
  closed = false;
  ready = false;
  focuses = 0;
  document = { getElementById: () => (this.ready ? {} : null) };
  focus() {
    this.focuses++;
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("unload"));
  }
  load() {
    this.ready = true;
    this.dispatchEvent(new Event("DOMContentLoaded"));
    this.dispatchEvent(new Event("load"));
  }
}
const artifact = {
  id: "report",
  taskId: "task",
  revision: 3,
  revisions: [{ revision: 1 }, { revision: 2 }, { revision: 3 }],
} as ArtifactRecord;
const host = { rpc: async () => ({}) };
const markdown = () => {};

test("report windows reuse one native window before and after loading, without mounting a workspace", () => {
  const wins: FakeWindow[] = [];
  const selections: Array<number | undefined> = [];
  let mounts = 0,
    disposals = 0;
  const manager = new ArtifactWindows(
    () => {
      const win = new FakeWindow();
      wins.push(win);
      return win as unknown as Window;
    },
    (_win, _host, _artifact, revision) => {
      mounts++;
      selections.push(revision);
      return {
        select: (revision) => selections.push(revision),
        dispose: () => {
          disposals++;
        },
      };
    },
  );
  const first = manager.open(host, artifact, undefined, markdown);
  assert.equal(manager.open(host, artifact, 1, markdown), first);
  assert.equal(wins.length, 1);
  assert.equal(mounts, 0);
  wins[0].dispatchEvent(new Event("unload")); // initial about:blank replacement
  wins[0].load();
  assert.equal(mounts, 1);
  assert.deepEqual(selections, [1]);
  manager.open(host, artifact, undefined, markdown);
  assert.deepEqual(selections, [1, undefined]);
  assert.equal(wins[0].focuses, 2);
  manager.open(
    host,
    { ...artifact, id: "other", taskId: "another-task" },
    undefined,
    markdown,
  );
  wins[1].load();
  manager.closeTask("task");
  assert.equal(wins[0].closed, true);
  assert.equal(wins[1].closed, false);
  assert.equal(disposals, 1);
  manager.closeAll();
  assert.equal(disposals, 2);
});

test("closing an old window cannot remove a reopened report from the registry", () => {
  const wins: FakeWindow[] = [];
  const manager = new ArtifactWindows(() => {
    const win = new FakeWindow();
    wins.push(win);
    return win as unknown as Window;
  });
  manager.open(host, artifact, undefined, markdown);
  wins[0].closed = true;
  const second = manager.open(host, artifact, undefined, markdown);
  wins[0].dispatchEvent(new Event("unload"));
  assert.equal(manager.open(host, artifact, undefined, markdown), second);
  assert.equal(wins.length, 2);
  manager.closeAll();
});

test("a slow chrome document mounts even when its load events are lost, and startup stops after close", () => {
  const wins: FakeWindow[] = [];
  const pending: Array<() => void> = [];
  let mounts = 0,
    disposals = 0;
  const manager = new ArtifactWindows(
    () => {
      const win = new FakeWindow();
      wins.push(win);
      return win as unknown as Window;
    },
    () => {
      mounts++;
      return {
        select() {},
        dispose() {
          disposals++;
        },
      };
    },
    (callback) => pending.push(callback),
  );
  manager.open(host, artifact, undefined, markdown);
  for (let i = 0; i < 30; i++) pending.shift()!();
  assert.equal(mounts, 0);
  assert.equal(pending.length, 1);
  wins[0].ready = true; // no load event after the inner window was replaced
  pending.shift()!();
  wins[0].load();
  assert.equal(mounts, 1);
  assert.equal(pending.length, 0);
  manager.closeTask("task");
  assert.equal(disposals, 1);
  manager.open(host, artifact, undefined, markdown);
  wins[1].close();
  pending.shift()!();
  assert.equal(mounts, 1);
  assert.equal(pending.length, 0);
});

test("the production opener creates a parentless nonmodal window with native chrome", (t) => {
  const calls: unknown[][] = [];
  const win = new FakeWindow();
  const before = Object.getOwnPropertyDescriptor(globalThis, "Services");
  Object.defineProperty(globalThis, "Services", {
    configurable: true,
    value: {
      ww: {
        openWindow: (...args: unknown[]) => {
          calls.push(args);
          return win;
        },
      },
    },
  });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "Services", before);
    else Reflect.deleteProperty(globalThis, "Services");
  });
  assert.equal(openNativeArtifactWindow(), win);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], null);
  assert.equal(calls[0][1], "chrome://confucius/content/artifact.xhtml");
  assert.equal(calls[0][3], ARTIFACT_WINDOW_FEATURES);
  assert.match(ARTIFACT_WINDOW_FEATURES, /dialog=no/);
  assert.match(ARTIFACT_WINDOW_FEATURES, /dependent=no/);
  assert.doesNotMatch(ARTIFACT_WINDOW_FEATURES, /modal=yes|alwaysRaised/);
});

test("latest opens follow revisions while explicitly chosen history remains pinned", () => {
  assert.equal(artifactRevisionSelection(artifact), undefined);
  assert.equal(artifactRevisionSelection(artifact, 3), undefined);
  assert.equal(artifactRevisionSelection(artifact, 1), 1);
  assert.equal(artifactRevisionSelection(artifact, 99), undefined);
  const updated = {
    ...artifact,
    revision: 4,
    revisions: [
      ...artifact.revisions,
      { revision: 4 } as ArtifactRecord["revisions"][number],
    ],
  };
  assert.equal(artifactRevisionSelection(updated, undefined), undefined);
  assert.equal(artifactRevisionSelection(updated, 1), 1);
});

test("report writeback needs explicit confirmation and cancellation denies only its own approval", async () => {
  const calls: unknown[] = [];
  const approval = new ArtifactWritebackApproval({
    async rpc(method, params) {
      calls.push({ method, params });
      return {
        approvalId: "window-approval",
        preview: { before: "old", after: "fresh" },
      };
    },
  });
  assert.deepEqual(await approval.prepare({ id: "report", revision: 1 }), {
    before: "old",
    after: "fresh",
  });
  assert.equal(approval.pending, true);
  assert.equal(calls.length, 1); // preparing does not resolve the request
  await approval.approve();
  await approval.close();
  assert.deepEqual(calls[1], {
    method: "approval/resolve",
    params: { id: "window-approval", verdict: "allow", scope: "once" },
  });
  assert.equal(calls.length, 2); // closing does not deny an approved write

  const cancelled = new ArtifactWritebackApproval({
    async rpc(method, params) {
      calls.push({ method, params });
      return {
        approvalId: "cancelled-approval",
        preview: { before: "", after: "" },
      };
    },
  });
  await cancelled.prepare({ id: "report" });
  await cancelled.close();
  await cancelled.close();
  await cancelled.approve();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3], {
    method: "approval/resolve",
    params: { id: "cancelled-approval", verdict: "deny", scope: "once" },
  });
});

test("closing a report while its approval is being prepared leaves no hidden request", async () => {
  let finish!: (value: unknown) => void;
  const resolutions: unknown[] = [];
  const approval = new ArtifactWritebackApproval({
    async rpc(method, params) {
      if (method === "artifact/writebackCommit")
        return new Promise((resolve) => {
          finish = resolve;
        });
      resolutions.push(params);
      return {};
    },
  });
  const pending = approval.prepare({ id: "report" });
  await approval.close();
  finish({ approvalId: "late-approval", preview: { before: "", after: "" } });
  assert.equal(await pending, undefined);
  assert.deepEqual(resolutions, [
    { id: "late-approval", verdict: "deny", scope: "once" },
  ]);
  assert.equal(approval.pending, false);
});
