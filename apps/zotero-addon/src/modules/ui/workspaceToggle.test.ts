import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORKSPACE_SIDEBAR_ID,
  isWorkspaceSidebarVisible,
  workspaceIconAction,
} from "./workspaceToggle";

function fakeDoc(
  pane: {
    hidden?: boolean;
    getBoundingClientRect?: () => { width: number; height: number };
  } | null,
) {
  return {
    getElementById(id: string) {
      return id === WORKSPACE_SIDEBAR_ID ? pane : null;
    },
  };
}

describe("workspaceIconAction", () => {
  it("collapses an already-visible sidebar instead of opening again", () => {
    assert.equal(
      workspaceIconAction({ layout: "sidebar", sidebarVisible: true }),
      "close",
    );
  });

  it("opens the sidebar when it is not visible", () => {
    assert.equal(
      workspaceIconAction({ layout: "sidebar", sidebarVisible: false }),
      "open",
    );
  });

  it("opens a window workspace even if a leftover sidebar node exists", () => {
    assert.equal(
      workspaceIconAction({ layout: "window", sidebarVisible: true }),
      "open",
    );
  });
});

describe("isWorkspaceSidebarVisible + icon action", () => {
  it("treats a present unhidden pane as close on the next icon click", () => {
    const visible = isWorkspaceSidebarVisible(fakeDoc({ hidden: false }));
    assert.equal(visible, true);
    assert.equal(
      workspaceIconAction({ layout: "sidebar", sidebarVisible: visible }),
      "close",
    );
  });

  it("opens when the pane is missing or hidden", () => {
    assert.equal(isWorkspaceSidebarVisible(fakeDoc(null)), false);
    assert.equal(isWorkspaceSidebarVisible(fakeDoc({ hidden: true })), false);
    assert.equal(
      workspaceIconAction({
        layout: "sidebar",
        sidebarVisible: isWorkspaceSidebarVisible(fakeDoc(null)),
      }),
      "open",
    );
  });
});
