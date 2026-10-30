// Who answers a credential release (ADR-0045 decision 4, as accepted on 2026-10-17, against the
// approval modes of ADR-0002 amendment 6). The broker does most of it: a stored rule answers only
// when it binds the exact entry, revision, operation and origin (`approvalRuleMatches`); in
// `automatic` the reviewer never sees one (`reviewIneligibility` says `credential`) and it is
// posted for people; in `manual` it is posted to the thread; in `approve_all` the mode allows it
// and records `mode:approve_all`. This file adds the one rule the broker cannot express: in
// `automatic` a release goes to a human, so a teammate bot's `approval_decide` is refused there,
// while in `manual` any member of the thread may decide it as for any other request (ADR-0002
// amendment 2, a soft boundary).

import { type Approval, DeskmatesError, isVaultUseAction } from "@deskmates/contracts";
import { AutoApprovalSettings } from "../approvals/auto-approval.js";
import type { GatewayContext } from "../context.js";

export function assertBotMayDecideVaultRelease(
  ctx: Pick<GatewayContext, "db">,
  approval: Approval,
): void {
  if (!isVaultUseAction(approval.action)) return;
  const workspaceId = (
    ctx.db.prepare("SELECT workspace_id FROM approvals WHERE id = ?").get(approval.id) as
      | { workspace_id: string }
      | undefined
  )?.workspace_id;
  if (workspaceId === undefined) return;
  if (new AutoApprovalSettings(ctx.db).mode(workspaceId) === "automatic")
    throw new DeskmatesError(
      "forbidden",
      "in automatic approval mode a credential release is decided by a human",
      { approvalId: approval.id, refusal: "vault_human_only" },
    );
}
