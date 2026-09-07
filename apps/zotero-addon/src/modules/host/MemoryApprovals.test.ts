import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  InMemoryFileSystem,
  MemoryEngine,
  type MemoryOp,
} from "@confucius/memory";
import type { MemoryProposal } from "@confucius/protocol";
import { MemoryApprovals } from "./MemoryApprovals";
import { ConfuciusMemoryToolProvider } from "./MemoryTools";
const op: MemoryOp = {
  op: "add",
  type: "fact",
  title: "Preference",
  content: "Use source-grounded evidence tables",
};
const digest = async (text: string) =>
  createHash("sha256").update(text).digest("hex");
test("proposals never write memory; reject and concurrent approvals are durable and idempotent", async () => {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const proposals = new Map<string, MemoryProposal>();
  let saved: MemoryProposal[] = [];
  const service = new MemoryApprovals({
    memory,
    proposals,
    digest,
    persist: async () => {
      saved = structuredClone([...proposals.values()]);
    },
  });
  const a = await service.propose(op, {
    taskId: "a",
    turnId: "turn1",
    source: "extraction",
  });
  assert.equal(memory.stats().total, 0);
  assert.equal(
    (
      await service.propose(op, {
        taskId: "a",
        turnId: "turn2",
        source: "extraction",
      })
    ).created,
    false,
  );
  assert.equal(a.proposal.turnId, "turn1");
  await service.resolve(a.proposal.id, "reject", () => op);
  assert.equal(memory.stats().total, 0);
  const b = await service.propose(op, { taskId: "b", source: "agent-tool" });
  await Promise.all([
    service.resolve(b.proposal.id, "accept", () => op),
    service.resolve(b.proposal.id, "accept", () => op),
  ]);
  assert.equal(memory.stats().total, 1);
  assert.equal(saved.find((p) => p.id === b.proposal.id)?.status, "accepted");
  const restored = new MemoryApprovals({
    memory: new MemoryEngine({ fs, root: "/memory" }),
    proposals: new Map(saved.map((p) => [p.id, p])),
    digest,
    persist: async () => {},
  });
  assert.equal(
    (await restored.resolve(b.proposal.id, "accept", () => op)).changes.length,
    0,
  );
});
test("lost acceptance receipt resumes the frozen approval without writing a second memory", async () => {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const proposals = new Map<string, MemoryProposal>();
  let fail = true;
  const service = new MemoryApprovals({
    memory,
    proposals,
    digest,
    persist: async () => {
      if (fail && [...proposals.values()].some((p) => p.status === "accepted"))
        throw new Error("disk busy");
    },
  });
  const { proposal } = await service.propose(op, {
    taskId: "a",
    source: "extraction",
  });
  await assert.rejects(
    service.resolve(proposal.id, "accept", () => op),
    /disk busy/,
  );
  assert.equal(proposal.status, "pending");
  assert.equal(memory.stats().total, 1);
  fail = false;
  await service.resolve(proposal.id, "accept", () => ({
    ...op,
    content: "Do not substitute unapproved changes",
  }));
  assert.equal(memory.stats().total, 1);
  assert.equal((await memory.list())[0].content, op.content);
});
test("unbound Agent memory writes fail closed even when a tool is granted", async () => {
  const memory = new MemoryEngine({
    fs: new InMemoryFileSystem(),
    root: "/memory",
  });
  const provider = new ConfuciusMemoryToolProvider(memory);
  for (const name of ["memory_save", "memory_update", "memory_delete"]) {
    const result = await provider.call(name, {
      content: "unapproved",
      id: "anything",
    });
    assert.equal(result.ok, false);
  }
  assert.equal(memory.stats().total, 0);
});

test("approval reconciles a memory file written before a lost filesystem receipt", async () => {
  class LostReceiptFileSystem extends InMemoryFileSystem {
    fail = true;
    memoryWrites = 0;
    override async writeFile(path: string, content: string) {
      await super.writeFile(path, content);
      if (path.includes("/memories/")) {
        this.memoryWrites++;
        if (this.fail) {
          this.fail = false;
          throw new Error("lost filesystem receipt");
        }
      }
    }
  }
  const fs = new LostReceiptFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const proposals = new Map<string, MemoryProposal>();
  const service = new MemoryApprovals({
    memory,
    proposals,
    digest,
    persist: async () => {},
  });
  const { proposal } = await service.propose(op, {
    taskId: "a",
    source: "agent-tool",
  });
  await assert.rejects(
    service.resolve(proposal.id, "accept", () => op),
    /lost filesystem receipt/,
  );
  assert.equal(proposal.status, "pending");
  await service.resolve(proposal.id, "accept", () => op);
  assert.equal(proposal.status, "accepted");
  assert.equal(memory.stats().total, 1);
  assert.equal(fs.memoryWrites, 1);
  const restarted = new MemoryEngine({ fs, root: "/memory" });
  assert.equal((await restarted.list()).length, 1);
});
