// Which of two records for the same approval to keep when a fetch and the SSE stream disagree.
//
// An approval is decided once and never reopened (ADR-0002 amendment 2: the second decide on the
// same approval is a 409 `invalid_transition`). So a pending record never supersedes a decided
// one, however late it arrives; between two decided records the later `decidedAt` wins, and a
// record with no timestamp on either side falls back to the incoming one.

import type { Approval } from "@deskmates/contracts";

export function newerApproval(existing: Approval | undefined, incoming: Approval): Approval {
  if (!existing) return incoming;
  if (existing.decision === undefined) return incoming;
  if (incoming.decision === undefined) return existing;
  if (existing.decidedAt !== undefined && incoming.decidedAt !== undefined) {
    return incoming.decidedAt >= existing.decidedAt ? incoming : existing;
  }
  return incoming;
}
