import type { Approval } from "@deskmates/contracts";
import type { RunStore } from "../ledger/runs.js";
import { scrubSecretShaped } from "./secret-shaped.js";

export const APPROVAL_PRESENTATION = "approval_presentation";

/** Called once after a new approval is persisted; never blocks the approval on a model. */
export function queueApprovalPresentation(
  approval: Approval,
  runs: RunStore,
  config: Record<string, unknown>,
  model: string,
) {
  if (approval.kind === "egress" || approval.kind === "continuation" || approval.decision) return;
  const source = JSON.stringify(
    scrubSecretShaped({ action: approval.action, instruction: approval.instruction }).value,
  );
  if (source.length <= 800) return;
  return runs.create({
    botId: approval.botId,
    lane: "background",
    triggerKind: "cron",
    triggerRef: `approval_presentation:${approval.id}`,
    triggerPayload: { prompt: source.slice(0, 12000) },
    config: {
      ...config,
      runType: APPROVAL_PRESENTATION,
      approvalId: approval.id,
      model,
      maxTurns: 1,
      presentationVersion: 1,
    },
  });
}
