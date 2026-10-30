// The paused state of a conversation (ADR-0005 amendment 3): why it is paused and, for a
// turn-budget pause, when it resumes by itself (rewritten decision 22), with Resume for those who
// may take it (decision 23). An operator pause ends only on Resume; a human message is kept and
// wakes nobody (decision 24), which the composer note says where the message is written.

import type { Thread } from "@deskmates/contracts";
import { PauseCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { formatTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";

type PausedFacts = Pick<Thread, "status" | "pauseReason" | "resumeAt">;

/** Whether a human message ends this pause (decision 24): every pause but an operator's. */
export function humanMessageResumes(thread: PausedFacts): boolean {
  return thread.status === "paused" && thread.pauseReason !== "operator";
}

/** Whole minutes until `resumeAt`, never below zero. */
export function minutesUntil(resumeAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(resumeAt) - now) / 60_000));
}

/** Re-render once a minute while a resume time is shown, so the countdown stays true. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface ThreadPausedBannerProps {
  thread: PausedFacts;
  /** Shown when the session may Resume (an Owner or Admin); absent hides the button. */
  onResume?: (() => void) | undefined;
  resuming?: boolean;
}

export function ThreadPausedBanner(props: ThreadPausedBannerProps) {
  const { thread } = props;
  const t = useT();
  const now = useMinuteClock(thread.status === "paused" && thread.resumeAt !== undefined);
  if (thread.status !== "paused") return null;
  let text: string;
  if (thread.pauseReason === "operator") text = t("chatPane.paused.operator");
  else if (thread.resumeAt) {
    const minutes = minutesUntil(thread.resumeAt, now);
    text =
      minutes > 0
        ? t("chatPane.paused.turnBudget", { time: formatTime(thread.resumeAt), minutes })
        : t("chatPane.paused.turnBudgetSoon");
  } else text = t("chatPane.paused");
  return (
    <output className="paused-banner">
      <PauseCircle size={16} aria-hidden="true" />
      <span>{text}</span>
      {props.onResume ? (
        <Button
          type="button"
          className="paused-banner-resume"
          disabled={props.resuming}
          onClick={props.onResume}
        >
          {t("chatPane.resume")}
        </Button>
      ) : null}
    </output>
  );
}
