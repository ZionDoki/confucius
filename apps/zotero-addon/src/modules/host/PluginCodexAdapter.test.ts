import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codexAccountReady,
  pluginCodexAppServerArgs,
  pluginCodexRuntimeConfig,
} from "./PluginCodexAdapter";

describe("in-plugin Codex adapter", () => {
  it("uses the explicit requiresOpenaiAuth result instead of account presence alone", () => {
    assert.equal(
      codexAccountReady({ account: { email: "user@example.test" } }),
      true,
    );
    assert.equal(
      codexAccountReady({ account: null, requiresOpenaiAuth: false }),
      true,
    );
    assert.equal(
      codexAccountReady({ account: null, requiresOpenaiAuth: true }),
      false,
    );
  });

  it("disables shell and file-capable features in Zotero-only mode", () => {
    const args = pluginCodexAppServerArgs("zotero_only");
    assert.equal(args.includes("shell_tool"), true);
    assert.equal(args.includes("unified_exec"), true);
    assert.equal(args.includes("allow_login_shell=false"), true);

    const config = pluginCodexRuntimeConfig("zotero_only", ["user-server"], {
      url: "http://127.0.0.1:23119/confucius/v1/mcp",
      token: "memory-only-token",
    });
    const servers = config.mcp_servers as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(servers["user-server"], { enabled: false });
    assert.equal(servers.confucius.required, true);
    assert.equal(
      (config.features as Record<string, boolean>).shell_tool,
      false,
    );
  });
});
