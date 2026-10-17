// Where a pending approval's run stands while it waits (issue #9, ADR-0002 decision 2): during the
// short wait the PreToolUse hook blocks live and the card counts down to the moment the run parks;
// after it the run is parked, its process gone, and it resumes when someone decides. The card also
// shows the run's latest screenshot, so the person deciding sees what the bot was looking at.

import {
  type Approval,
  type RunEvent,
  type RunStatus,
  SHORT_WAIT_SECONDS_DEFAULT,
} from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref } from "../../router.js";
import { useNow } from "../../state/use-now.js";
import { formatElapsed } from "../runs/run-activity.js";
import { screenshotSource } from "../runs/run-event-row.js";

export type ApprovalWaitState =
  | { kind: "live"; remainingMs: number }
  | { kind: "parked" }
  | undefined;

/**
 * The wait a pending approval is in. The run's status decides when the screen knows it; without
 * it (the inbox), the approval's own wait mode and the end of the short wait do.
 */
export function approvalWaitState(
  approval: Pick<Approval, "decision" | "waitMode" | "createdAt">,
  runStatus: RunStatus | undefined,
  now: number,
): ApprovalWaitState {
  if (approval.decision !== undefined) return undefined;
  if (
    runStatus === "waiting_approval" ||
    runStatus === "waiting_continuation" ||
    approval.waitMode === "deferred"
  )
    return { kind: "parked" };
  const remainingMs = Date.parse(approval.createdAt) + SHORT_WAIT_SECONDS_DEFAULT * 1000 - now;
  if (runStatus === "waiting_approval_live")
    return { kind: "live", remainingMs: Math.max(0, remainingMs) };
  // Ended, cancelled or already moving again: nothing is waiting on this card any more.
  if (runStatus !== undefined) return undefined;
  return remainingMs > 0 ? { kind: "live", remainingMs } : { kind: "parked" };
}

export function ApprovalWait({
  approval,
  runStatus,
  api,
}: {
  approval: Approval;
  runStatus: RunStatus | undefined;
  api: Pick<ApiClient, "latestRunScreenshot">;
}) {
  const t = useT();
  const pending = approval.decision === undefined;
  const live = approvalWaitState(approval, runStatus, Date.now())?.kind === "live";
  const now = useNow(live);
  const state = approvalWaitState(approval, runStatus, now);
  const [shot, setShot] = useState<RunEvent | null>(null);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    api
      .latestRunScreenshot(approval.runId)
      .then((event) => {
        if (active) setShot(event);
      })
      .catch(() => {
        // A Guest cannot read run events, and a thumbnail is not worth an error.
      });
    return () => {
      active = false;
    };
  }, [api, approval.runId, pending]);
  if (!pending) return null;
  const src = shot ? screenshotSource(shot.payload).src : undefined;
  return (
    <div className="approval-wait" data-testid="approval-wait" data-wait={state?.kind ?? "none"}>
      {state?.kind === "live" ? (
        <p className="small approval-wait-text">
          {state.remainingMs > 0
            ? t("approvalCard.wait.live", { remaining: formatElapsed(state.remainingMs) })
            : t("approvalCard.wait.parking")}
        </p>
      ) : state?.kind === "parked" ? (
        <p className="small approval-wait-text">{t("approvalCard.wait.parked")}</p>
      ) : null}
      {src ? (
        <figure className="approval-shot">
          <a href={runHref(approval.runId)}>
            <img src={src} alt={t("approvalCard.wait.shotAlt")} loading="lazy" />
          </a>
          <figcaption className="muted small">{t("approvalCard.wait.shotCaption")}</figcaption>
        </figure>
      ) : null}
    </div>
  );
}
