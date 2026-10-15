// Stop in an open chat (issue #76): cancelling one unfinished run of this chat. Since issue #126
// the Stop buttons sit in the expanded run list of `chat-run-status.tsx`, one per run; this file
// owns what happens after a press. It asks first, naming the exact run and its status, and says
// what stops and what does not: cancelling one run never stops the chat, other bots, other runs
// of the same bot or queued follow-ups. It calls the existing `POST /api/runs/:id/cancel`, the
// same path as Cancel run on the run screen, and the Gateway decides permission and the
// terminal-state race. There is no bulk stop.

import type { RunId } from "@deskmates/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError, type RunView } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runStatusLabel } from "../../state/thread-view.js";

export interface RunStopOptions {
  api: ApiClient;
  /** Unfinished runs of this chat. Runs of other chats are never offered. */
  runs: readonly RunView[];
  botName: (botId: string) => string;
  /** The run as the Gateway now reports it, after a cancel or a lost terminal-state race. */
  onRunUpdated: (run: RunView) => void;
}

export interface RunStopController {
  /** Runs whose cancel request is in flight. */
  stopping: ReadonlySet<RunId>;
  /** Open the confirmation for exactly this run. */
  ask: (run: Pick<RunView, "id" | "botId">) => void;
  /** The last outcome and the confirmation dialog; render it once. */
  feedback: ReactNode;
  /** Whether a confirmation or an outcome is showing, so it stays after the last run ends. */
  active: boolean;
}

interface Notice {
  kind: "success" | "error";
  text: string;
}

export function useRunStop(options: RunStopOptions): RunStopController {
  const { api, runs, botName, onRunUpdated } = options;
  const t = useT();
  const [confirming, setConfirming] = useState<{ id: RunId; botId: string } | undefined>();
  const [stopping, setStopping] = useState<ReadonlySet<RunId>>(new Set());
  const [notice, setNotice] = useState<Notice | undefined>();
  // A ref, not state: two clicks in one tick must not send two requests.
  const inFlight = useRef(new Set<RunId>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const stop = async (runId: RunId, botId: string): Promise<void> => {
    if (inFlight.current.has(runId)) return;
    inFlight.current.add(runId);
    setConfirming(undefined);
    setNotice(undefined);
    setStopping((current) => new Set(current).add(runId));
    const name = botName(botId);
    try {
      const { run } = await api.cancelRun(runId);
      if (!mounted.current) return;
      onRunUpdated(run);
      setNotice({ kind: "success", text: t("chatRunStop.result.cancelled", { name }) });
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.code === "invalid_transition") {
        // The run ended before the cancel arrived: say so and show its real final state.
        setNotice({ kind: "success", text: t("chatRunStop.result.alreadyFinished", { name }) });
        api
          .getRun(runId)
          .then(({ run }) => {
            if (mounted.current) onRunUpdated(run);
          })
          .catch(() => {});
      } else if (err instanceof ApiError && err.code === "forbidden") {
        setNotice({
          kind: "error",
          text: t("chatRunStop.result.forbidden", { name, error: errorMessage(err) }),
        });
      } else if (err instanceof ApiError && err.code === "network") {
        setNotice({ kind: "error", text: t("chatRunStop.result.network", { name }) });
      } else {
        setNotice({
          kind: "error",
          text: t("chatRunStop.result.failed", { name, error: errorMessage(err) }),
        });
      }
    } finally {
      inFlight.current.delete(runId);
      if (mounted.current)
        setStopping((current) => {
          const next = new Set(current);
          next.delete(runId);
          return next;
        });
    }
  };

  const target = confirming ? runs.find((run) => run.id === confirming.id) : undefined;
  const targetName = confirming ? botName(confirming.botId) : "";

  const feedback = (
    <>
      {notice ? (
        notice.kind === "error" ? (
          <p className="error small" role="alert">
            {notice.text}
          </p>
        ) : (
          <output className="muted small">{notice.text}</output>
        )
      ) : null}
      <Dialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <DialogContent className="max-w-md" closeLabel={t("chatRunStop.dialog.close")}>
          <DialogTitle className="text-lg font-semibold">
            {t("chatRunStop.dialog.title", { name: targetName })}
          </DialogTitle>
          {confirming && target ? (
            <>
              <DialogDescription className="small">
                {t.rich("chatRunStop.dialog.target", {
                  runId: confirming.id,
                  status: runStatusLabel(target.status),
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </DialogDescription>
              <div className="chat-run-stop-scope small">
                <p>{t("chatRunStop.dialog.stops")}</p>
                <p>{t("chatRunStop.dialog.continues", { name: targetName })}</p>
                <p className="muted">{t("chatRunStop.dialog.process")}</p>
              </div>
              <div className="desktop-dialog-footer">
                <Button type="button" onClick={() => setConfirming(undefined)}>
                  {t("chatRunStop.dialog.keep")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void stop(confirming.id, confirming.botId)}
                >
                  {t("chatRunStop.dialog.confirm")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogDescription className="small">
                {t("chatRunStop.dialog.finished")}
              </DialogDescription>
              <div className="desktop-dialog-footer">
                <Button type="button" onClick={() => setConfirming(undefined)}>
                  {t("chatRunStop.dialog.close")}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    stopping,
    ask: (run) => setConfirming({ id: run.id, botId: run.botId }),
    feedback,
    active: notice !== undefined || confirming !== undefined,
  };
}
