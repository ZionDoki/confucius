import type { MemoryProposal } from "@confucius/protocol";

export function renderMemoryProposal(
  doc: Document,
  proposal: MemoryProposal,
  zh: boolean,
  resolve: (id: string, verdict: "accept" | "reject") => Promise<void>,
): HTMLElement {
  const row = doc.createElement("section");
  row.dataset.proposalStatus = proposal.status;
  row.dataset.entryId = `memory-proposal:${proposal.id}`;
  row.style.cssText =
    "display:flex;align-items:start;gap:8px;padding:8px 0;font-size:12px";
  const details = doc.createElement("details");
  details.style.flex = "1";
  const summary = doc.createElement("summary");
  const action =
    proposal.op === "delete"
      ? zh
        ? "删除"
        : "Delete"
      : proposal.op === "update"
        ? zh
          ? "修改"
          : "Update"
        : zh
          ? "新增"
          : "Add";
  const label = `${zh ? "记忆提案" : "Memory proposal"} · ${action}`;
  summary.textContent = `${label} · ${(proposal.title ?? proposal.content ?? proposal.memoryId ?? "").replace(/\s+/g, " ").slice(0, 90)}`;
  const full = doc.createElement("div");
  full.style.cssText = "white-space:pre-wrap;padding:6px 0";
  full.textContent = proposal.content ?? proposal.title ?? "";
  const brief = doc.createElement("span");
  brief.style.cssText =
    "display:block;font-weight:normal;opacity:.8;margin-top:3px";
  brief.textContent = (proposal.content ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 100);
  summary.append(brief);
  details.append(summary, full);
  row.append(details);
  const status = doc.createElement("span");
  status.setAttribute("role", "status");
  if (proposal.status !== "pending") {
    status.textContent =
      proposal.status === "accepted"
        ? zh
          ? "已批准"
          : "Approved"
        : zh
          ? "已拒绝"
          : "Rejected";
    row.append(status);
    return row;
  }
  const reject = doc.createElement("button");
  reject.type = "button";
  reject.textContent = "×";
  const accept = doc.createElement("button");
  accept.type = "button";
  accept.textContent = "√";
  reject.title = zh ? "拒绝" : "Reject";
  accept.title = zh ? "批准并写入" : "Approve and save";
  reject.setAttribute("aria-label", reject.title);
  accept.setAttribute("aria-label", accept.title);
  reject.disabled = !!proposal.approvedOperation;
  for (const [button, verdict] of [
    [reject, "reject"],
    [accept, "accept"],
  ] as const) {
    button.addEventListener("click", async () => {
      accept.disabled = reject.disabled = true;
      status.textContent = "";
      try {
        await resolve(proposal.id, verdict);
      } catch (error) {
        status.textContent = String(error);
        accept.disabled = false;
        reject.disabled = !!proposal.approvedOperation;
      }
    });
  }
  row.append(reject, accept, status);
  return row;
}
