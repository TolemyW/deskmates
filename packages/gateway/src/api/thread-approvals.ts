// A chat's approvals bounded to its loaded messages (#113 surface 26). The transcript opens on its
// newest window, so the chat asks only for the approvals its loaded messages refer to:
// `GET /api/approvals?threadId=…&ids=a,b,…`, at most 100 ids per request. Unknown ids, ids of
// another thread and rows the caller may not see are omitted, never reported. With no explicit
// status both pending and decided rows are returned, because a card renders either.

import {
  type Approval,
  type ApprovalId,
  DeskmatesError,
  type ThreadId,
} from "@deskmates/contracts";
import type { FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { parseIdBatch } from "./name-lookup.js";
import { visibleOfKind } from "./workspace-access.js";

/** The named approvals of one thread the caller may see, oldest first. */
export function threadApprovalsByIds(
  ctx: GatewayContext,
  request: FastifyRequest,
  query: { threadId?: string; ids: string; status?: string },
): { approvals: Approval[] } {
  if (!query.threadId)
    throw new DeskmatesError("validation", "ids needs a threadId", { field: "threadId" });
  const threadId = query.threadId as ThreadId;
  const ids = parseIdBatch(query.ids) as ApprovalId[];
  const status = query.status === "pending" || query.status === "decided" ? query.status : "all";
  const rows = ids
    .map((id) => ctx.approvals.get(id))
    .filter((approval): approval is Approval => approval?.threadId === threadId)
    .filter(
      (approval) =>
        status === "all" || (status === "pending") === (approval.decision === undefined),
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  return { approvals: visibleOfKind(ctx, request, "approval", rows) };
}
