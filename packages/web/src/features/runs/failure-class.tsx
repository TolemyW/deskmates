// A run's failure class in words (ADR-0042 decision 1). The Gateway derives the class from the
// run's error; the runs index, the drawer and the filters show it with these labels.

import type { RunFailureClass } from "@deskmates/contracts";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";

export const FAILURE_CLASS_LABEL: Readonly<Record<RunFailureClass, MessageKey>> = {
  model_unavailable: "runFailure.modelUnavailable",
  model_deadline: "runFailure.modelDeadline",
  tool_allowlist: "runFailure.toolAllowlist",
  egress_blocked: "runFailure.egressBlocked",
  approval_denied: "runFailure.approvalDenied",
  wall_clock: "runFailure.wallClock",
  sdk_abort: "runFailure.sdkAbort",
  no_reply: "runFailure.noReply",
  budget_limit: "runFailure.budgetLimit",
  other: "runFailure.other",
};

/** The class as a small label; nothing for a run without one. */
export function FailureClassLabel({ failureClass }: { failureClass: RunFailureClass | undefined }) {
  const t = useT();
  if (!failureClass) return null;
  return (
    <span className="run-failure-class" data-failure-class={failureClass}>
      {t(FAILURE_CLASS_LABEL[failureClass])}
    </span>
  );
}
