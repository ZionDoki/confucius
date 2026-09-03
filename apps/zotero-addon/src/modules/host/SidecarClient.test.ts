import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SidecarClient, validateDescriptor } from "./SidecarClient";

const descriptor = {
  protocol: 1 as const,
  pid: 42,
  baseUrl: "http://127.0.0.1:4567",
  token: "s".repeat(43),
  version: "0.3.0",
  startedAt: 1,
};

describe("SidecarClient", () => {
  it("rejects descriptors that can exfiltrate the bearer token", () => {
    assert.throws(
      () =>
        validateDescriptor({ ...descriptor, baseUrl: "https://example.com" }),
      /validation|invalid URL/,
    );
  });

  it("registers the pairing token in memory without changing the descriptor", async () => {
    const requests: Array<{
      url: string;
      authorization: string;
      body: string;
    }> = [];
    const reader = {
      exists: async () => true,
      read: async () => JSON.stringify(descriptor),
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: String(
          (init?.headers as Record<string, string> | undefined)
            ?.Authorization ?? "",
        ),
        body: String(init?.body ?? ""),
      });
      const payload = url.endsWith("/health")
        ? { ok: true }
        : JSON.parse(String(init?.body ?? "{}")).method === "host/register"
          ? { jsonrpc: "2.0", id: 1, result: { ok: true } }
          : {
              jsonrpc: "2.0",
              id: 2,
              result: { hostConnected: true, runtimes: [] },
            };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      } as unknown as Response;
    };
    const client = new SidecarClient(
      "sidecar.json",
      reader,
      fetchImpl,
      () => "pairing-secret",
    );
    const result = await client.listRuntimes();
    assert.equal(result.sidecarConnected, true);
    const registration = requests.find((entry) =>
      entry.body.includes("host/register"),
    );
    assert.ok(registration?.body.includes("pairing-secret"));
    assert.equal(registration?.authorization, `Bearer ${descriptor.token}`);
    assert.equal((await reader.read()).includes("pairing-secret"), false);
  });

  it("discovers a replacement descriptor on the first call after restart", async () => {
    let current = descriptor;
    const restarted = {
      ...descriptor,
      pid: 84,
      baseUrl: "http://127.0.0.1:5678",
      token: "r".repeat(43),
      startedAt: 2,
    };
    const registrations: string[] = [];
    const reader = {
      exists: async () => true,
      read: async () => JSON.stringify(current),
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.body
        ? (JSON.parse(String(init.body)) as { method?: string }).method
        : undefined;
      if (method === "host/register") registrations.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith("/health")
            ? { ok: true }
            : method === "host/register"
              ? { jsonrpc: "2.0", id: 1, result: { ok: true } }
              : {
                  jsonrpc: "2.0",
                  id: 2,
                  result: { hostConnected: true, runtimes: [] },
                },
      } as unknown as Response;
    };
    const client = new SidecarClient(
      "sidecar.json",
      reader,
      fetchImpl,
      () => "pairing-secret",
    );
    assert.equal((await client.listRuntimes()).sidecarConnected, true);
    current = restarted;
    assert.equal((await client.listRuntimes()).sidecarConnected, true);
    assert.deepEqual(registrations, [
      `${descriptor.baseUrl}/rpc`,
      `${restarted.baseUrl}/rpc`,
    ]);
  });
});
