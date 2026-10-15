// Approvals (ADR-0002 amendment 2): the inbox, one approval, and a human's decision; the
// workspace approval mode (ADR-0002 amendment 6).

import type {
  Approval,
  ApprovalDecision,
  ApprovalId,
  ApprovalMode,
  ApprovalRule,
  BotId,
  ThreadId,
  WorkspaceAutoApproval,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface ApprovalFilter {
  /** Defaults to `pending` on the Gateway; pass nothing for every approval. */
  status?: "pending" | "decided";
  threadId?: ThreadId;
  botId?: BotId;
  /**
   * Only these approvals of `threadId`, pending and decided unless `status` is set; at most 100
   * (#113 surface 26). Unknown ids are omitted.
   */
  ids?: readonly string[];
}

/** One page of the Attention inbox (#113 surface 23): oldest first, with the visible total. */
export interface PendingApprovalsPage {
  approvals: Approval[];
  nextCursor?: string;
  total?: number;
}

export interface ApprovalsApi {
  decideApproval(
    id: ApprovalId,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<{ approval: Approval; rule?: ApprovalRule }>;
  getApproval(id: ApprovalId): Promise<Approval>;
  getAutoApproval(workspaceId: string): Promise<WorkspaceAutoApproval>;
  listApprovals(filter?: ApprovalFilter): Promise<Approval[]>;
  listPendingApprovalsPage(request?: {
    cursor?: string;
    limit?: number;
  }): Promise<PendingApprovalsPage>;
  /** ADR-0002 amendment 3, A7: minutes an undecided request waits before it expires. */
  setApprovalExpiry(workspaceId: string, expiryMinutes: number): Promise<WorkspaceAutoApproval>;
  /** ADR-0002 amendment 6, D1: manual, automatic review or approve all. */
  setApprovalMode(workspaceId: string, mode: ApprovalMode): Promise<WorkspaceAutoApproval>;
}

export function createApprovalsApi(t: HttpTransport): ApprovalsApi {
  return {
    decideApproval(id, decision, reason) {
      return t.json(
        "POST",
        `/api/approvals/${encodeURIComponent(id)}/decide`,
        stripUndefined({ decision, reason }),
      );
    },
    async getApproval(id) {
      const r = await t.json<{ approval: Approval }>(
        "GET",
        `/api/approvals/${encodeURIComponent(id)}`,
      );
      return r.approval;
    },
    async getAutoApproval(workspaceId) {
      const r = await t.json<{ autoApproval: WorkspaceAutoApproval }>(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/auto-approval`,
      );
      return r.autoApproval;
    },
    async listApprovals(filter = {}) {
      const r = await t.json<{ approvals: Approval[] }>(
        "GET",
        `/api/approvals${query({
          status: filter.status,
          threadId: filter.threadId,
          botId: filter.botId,
          ids: filter.ids?.join(","),
        })}`,
      );
      return r.approvals;
    },
    async listPendingApprovalsPage(request = {}) {
      // 25 is the Gateway's default for this queue, so it is not sent.
      const limit = request.limit === undefined || request.limit === 25 ? undefined : request.limit;
      const r = await t.json<PendingApprovalsPage>(
        "GET",
        `/api/approvals${query({ status: "pending", cursor: request.cursor, limit })}`,
      );
      return {
        approvals: r.approvals,
        ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}),
        ...(typeof r.total === "number" ? { total: r.total } : {}),
      };
    },
    async setApprovalExpiry(workspaceId, expiryMinutes) {
      const r = await t.json<{ autoApproval: WorkspaceAutoApproval }>(
        "PUT",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/auto-approval`,
        { expiryMinutes },
      );
      return r.autoApproval;
    },
    async setApprovalMode(workspaceId, mode) {
      const r = await t.json<{ autoApproval: WorkspaceAutoApproval }>(
        "PUT",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/auto-approval`,
        { mode },
      );
      return r.autoApproval;
    },
  };
}
