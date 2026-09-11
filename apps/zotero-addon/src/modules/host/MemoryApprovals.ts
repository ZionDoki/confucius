import type { MemoryProposal } from "@confucius/protocol";
import type { MemoryEngine, MemoryOp, AppliedChange } from "@confucius/memory";
import { ResourceLocks, runtimeDigest } from "./RuntimeStorage";
import { canonical } from "./ReliableToolProvider";

/** Durable proposal identity and a serialized, idempotent approval boundary. */
export class MemoryApprovals {
  private locks = new ResourceLocks();
  constructor(
    private options: {
      proposals: Map<string, MemoryProposal>;
      memory: MemoryEngine;
      persist(): Promise<void>;
      digest?: (text: string) => Promise<string>;
    },
  ) {}
  async propose(
    op: MemoryOp,
    context: {
      taskId: string;
      runId?: string;
      turnId?: string;
      source: string;
      sourceId?: string;
    },
  ): Promise<{ proposal: MemoryProposal; created: boolean }> {
    const baseId = `memprop_${await (this.options.digest ?? runtimeDigest)(canonical({ op, taskId: context.taskId, runId: context.runId, source: context.source, sourceId: context.sourceId }))}`;
    return this.locks.run([baseId], async () => {
      // A source ID identifies a replay of one operation. Without it, only a
      // pending proposal is a duplicate; a resolved choice can be made again.
      let id = baseId;
      if (!context.sourceId) {
        let sequence = 1;
        while (
          this.options.proposals.get(id)?.status !== "pending" &&
          this.options.proposals.has(id)
        )
          id = `${baseId}_${sequence++}`;
      }
      const previous = this.options.proposals.get(id);
      if (previous) return { proposal: previous, created: false };
      const proposal: MemoryProposal = {
        ...op,
        id,
        memoryId: op.op === "add" ? undefined : op.id,
        ...context,
        status: "pending",
        createdAt: Date.now(),
      };
      if (op.op !== "add") {
        await this.options.memory.ensureLoaded();
        const existing = this.options.memory.get(op.id);
        proposal.title ??= existing?.title;
        proposal.content ??= existing?.content;
      }
      this.options.proposals.set(id, proposal);
      try {
        await this.options.persist();
      } catch (error) {
        this.options.proposals.delete(id);
        throw error;
      }
      return { proposal, created: true };
    });
  }
  async resolve(
    id: string,
    verdict: "accept" | "reject",
    operation: (proposal: MemoryProposal) => MemoryOp,
  ): Promise<{ proposal: MemoryProposal; changes: AppliedChange[] }> {
    return this.locks.run(["memory-approval", id], async () => {
      const proposal = this.options.proposals.get(id);
      if (!proposal) throw new Error("Unknown memory proposal");
      if (proposal.status !== "pending") return { proposal, changes: [] };
      if (verdict === "reject") {
        if (proposal.approvedOperation)
          throw new Error(
            "An approved write is pending recovery; retry approval to finish it",
          );
        proposal.status = "rejected";
        proposal.resolvedAt = Date.now();
        try {
          await this.options.persist();
        } catch (error) {
          proposal.status = "pending";
          delete proposal.resolvedAt;
          throw error;
        }
        return { proposal, changes: [] };
      }
      const op = (proposal.approvedOperation ??
        operation(proposal)) as MemoryOp;
      proposal.approvedOperation = op as unknown as Record<string, unknown>;
      // Freeze the exact approved content before the first memory write.
      await this.options.persist();
      let changes: AppliedChange[];
      if (op.op === "add") {
        const record = await this.options.memory.save({
          ...op,
          id: `mem_${proposal.id}`,
          sourceSessionId: proposal.taskId,
        });
        changes = [{ op: "add", id: record.id, title: record.title }];
      } else {
        changes = await this.options.memory.applyOps([op], proposal.taskId);
      }
      await this.options.memory.flush();
      proposal.status = "accepted";
      proposal.resolvedAt = Date.now();
      try {
        await this.options.persist();
      } catch (error) {
        proposal.status = "pending";
        delete proposal.resolvedAt;
        throw error;
      }
      return { proposal, changes };
    });
  }
}
