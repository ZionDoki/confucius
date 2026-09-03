import assert from "node:assert/strict";
import { win32 } from "node:path";
import { describe, it } from "node:test";
import {
  normalizeCapabilityRequest,
  previewCapabilityRequest,
  repairPersistedCapabilities,
  type CapabilityPathApi,
} from "./TaskCapabilities";

const windowsPaths: CapabilityPathApi = {
  isAbsolute: win32.isAbsolute,
  normalize: win32.normalize,
};

describe("task capability normalization", () => {
  it("clears every directory when returning to Zotero-only mode", () => {
    assert.deepEqual(
      normalizeCapabilityRequest(
        {
          capabilityProfile: "zotero_only",
          workingDirectory: "C:\\Sensitive",
          confirmed: true,
        },
        { capabilityProfile: "workspace", workingDirectory: "C:\\Sensitive" },
        windowsPaths,
      ),
      { capabilityProfile: "zotero_only" },
    );
  });

  it("rejects relative paths and unconfirmed normalized grants", () => {
    assert.throws(
      () =>
        normalizeCapabilityRequest(
          { capabilityProfile: "workspace", workingDirectory: ".\\papers" },
          undefined,
          windowsPaths,
        ),
      /absolute path/,
    );
    assert.throws(
      () =>
        normalizeCapabilityRequest(
          {
            capabilityProfile: "workspace",
            workingDirectory: "C:\\Lab\\drafts\\..\\papers\\",
          },
          undefined,
          windowsPaths,
        ),
      /Confirm the normalized/,
    );
  });

  it("returns the normalized path and does not re-prompt for an unchanged grant", () => {
    const first = normalizeCapabilityRequest(
      {
        capabilityProfile: "workspace",
        workingDirectory: "C:\\Lab\\drafts\\..\\papers\\",
        confirmed: true,
      },
      undefined,
      windowsPaths,
    );
    assert.deepEqual(first, {
      capabilityProfile: "workspace",
      workingDirectory: "C:\\Lab\\papers",
    });
    assert.deepEqual(
      normalizeCapabilityRequest(
        {
          capabilityProfile: "workspace",
          workingDirectory: "C:\\Lab\\papers",
        },
        first,
        windowsPaths,
      ),
      first,
    );
  });

  it("previews the canonical path before a changed grant is confirmed", () => {
    assert.deepEqual(
      previewCapabilityRequest(
        {
          capabilityProfile: "workspace",
          workingDirectory: "C:\\Lab\\drafts\\..\\papers\\",
        },
        { capabilityProfile: "zotero_only" },
        windowsPaths,
      ),
      {
        capabilityProfile: "workspace",
        workingDirectory: "C:\\Lab\\papers",
        confirmationRequired: true,
      },
    );
  });

  it("downgrades malformed persisted workspace grants", () => {
    assert.deepEqual(
      repairPersistedCapabilities(
        { capabilityProfile: "workspace", workingDirectory: "relative" },
        windowsPaths,
      ),
      { capabilityProfile: "zotero_only" },
    );
    assert.deepEqual(
      repairPersistedCapabilities(
        {
          capabilityProfile: "workspace",
          workingDirectory: "C:\\Lab\\drafts\\..\\papers\\",
        },
        windowsPaths,
      ),
      {
        capabilityProfile: "workspace",
        workingDirectory: "C:\\Lab\\papers",
      },
    );
  });
});
