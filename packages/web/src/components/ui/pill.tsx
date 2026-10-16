// Small status label. `RunStatusPill` maps a run status onto a tone and a readable label so the
// same status looks the same in the rail, the transcript, the run page and the inbox.

import type { RunStatus } from "@deskmates/contracts";
import { Pill, type Tone } from "@deskmates/ui";
export { Pill, type Tone } from "@deskmates/ui";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";

const RUN_STATUS_KEY: Readonly<Record<RunStatus, MessageKey>> = {
  queued: "pill.runStatus.queued",
  running: "pill.runStatus.running",
  stalled: "pill.runStatus.stalled",
  waiting_approval_live: "pill.runStatus.waitingApproval",
  waiting_approval: "pill.runStatus.waitingApproval",
  waiting_browser: "pill.runStatus.waitingBrowser",
  waiting_continuation: "pill.runStatus.waitingContinuation",
  succeeded: "pill.runStatus.succeeded",
  silent: "pill.runStatus.silent",
  failed: "pill.runStatus.failed",
  cancelled: "pill.runStatus.cancelled",
  stopped: "pill.runStatus.stopped",
};

/** A run status in words, in the UI's language. */
export function runStatusLabel(status: RunStatus): string {
  return currentI18n().t(RUN_STATUS_KEY[status]);
}

/** Each run status in words; every read gives the UI's language at that moment (issue #23). */
export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = Object.defineProperties(
  {} as Record<RunStatus, string>,
  Object.fromEntries(
    (Object.keys(RUN_STATUS_KEY) as RunStatus[]).map((status) => [
      status,
      { enumerable: true, get: () => runStatusLabel(status) },
    ]),
  ),
);

const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  queued: "info",
  running: "info",
  stalled: "warning",
  waiting_approval_live: "warning",
  waiting_approval: "warning",
  waiting_browser: "warning",
  waiting_continuation: "warning",
  succeeded: "success",
  silent: "success",
  failed: "danger",
  cancelled: "danger",
  stopped: "danger",
};

export function runStatusTone(status: RunStatus): Tone {
  return RUN_STATUS_TONE[status];
}

export function RunStatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const t = useT();
  return (
    <Pill tone={RUN_STATUS_TONE[status]} dot className={className}>
      {t(RUN_STATUS_KEY[status])}
    </Pill>
  );
}
