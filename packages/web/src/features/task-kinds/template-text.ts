// Words for the values the kind view and templates show (ADR-0021 amendment 4).

import type {
  TaskCriterionState,
  TaskReviewRole,
  TaskSlaState,
  TaskStallReason,
} from "@deskmates/contracts";
import type { MessageKey } from "../../i18n/catalogs.js";
import type { useT } from "../../i18n/i18n-provider.js";

type T = ReturnType<typeof useT>;

export const REVIEW_LABELS: Record<TaskReviewRole, MessageKey> = {
  human: "taskKinds.review.human",
  peer_bot: "taskKinds.review.peerBot",
  none: "taskKinds.review.none",
};

export const STALL_LABELS: Record<TaskStallReason, MessageKey> = {
  waiting_approval: "taskKinds.stall.waitingApproval",
  waiting_human: "taskKinds.stall.waitingHuman",
  awaiting_acceptance: "taskKinds.stall.awaitingAcceptance",
  no_activity: "taskKinds.stall.noActivity",
};

export const SLA_LABELS: Record<TaskSlaState, MessageKey> = {
  none: "taskKinds.sla.none",
  on_track: "taskKinds.sla.onTrack",
  at_risk: "taskKinds.sla.atRisk",
  overdue: "taskKinds.sla.overdue",
  within: "taskKinds.sla.within",
  breached: "taskKinds.sla.breached",
};

export const CRITERION_LABELS: Record<TaskCriterionState, MessageKey> = {
  met: "taskKinds.criterion.met",
  open: "taskKinds.criterion.open",
  unreported: "taskKinds.criterion.unreported",
};

export function reviewLabel(t: T, review: TaskReviewRole): string {
  return t(REVIEW_LABELS[review]);
}

/** Minutes as days, hours or minutes, whichever is whole. */
export function durationLabel(t: T, minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0)
    return t("taskKinds.duration.days", { count: minutes / 1440 });
  if (minutes >= 60 && minutes % 60 === 0)
    return t("taskKinds.duration.hours", { count: minutes / 60 });
  if (minutes >= 120) return t("taskKinds.duration.hours", { count: Math.round(minutes / 60) });
  return t("taskKinds.duration.minutes", { count: minutes });
}

export function slaLabel(t: T, minutes: number | null): string {
  return minutes === null
    ? t("taskKinds.target.none")
    : t("taskKinds.target.value", { duration: durationLabel(t, minutes) });
}
