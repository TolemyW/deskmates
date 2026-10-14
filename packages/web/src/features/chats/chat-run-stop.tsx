// Stop in an open chat (issue #76): one control per unfinished run of this chat, each naming the
// bot and status of the run it cancels. It asks first and says what stops and what does not;
// cancelling one run never stops the chat, other bots, other runs of the same bot or queued
// follow-ups. It calls the existing `POST /api/runs/:id/cancel`, the same path as Cancel run on
// the run screen, and the Gateway decides permission and the terminal-state race.

import type { RunId, Thread } from "@deskmates/contracts";
import { Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { RoleNote, useCanInOwnSideChat } from "../../state/session-roles.js";
import { runStatusLabel } from "../../state/thread-view.js";

export interface ChatRunStopProps {
  api: ApiClient;
  /** Unfinished runs of this chat, oldest first. Runs of other chats are never offered. */
  runs: readonly RunView[];
  botName: (botId: string) => string;
  /** The chat, once loaded: a Member may cancel only in a side chat they opened. */
  thread: Pick<Thread, "kind" | "sideChatActor"> | undefined;
  memberCount: number;
  /** The run as the Gateway now reports it, after a cancel or a lost terminal-state race. */
  onRunUpdated: (run: RunView) => void;
}

interface Notice {
  kind: "success" | "error";
  text: string;
}

export function ChatRunStop(props: ChatRunStopProps) {
  const { api, runs, botName, onRunUpdated } = props;
  const t = useT();
  const can = useCanInOwnSideChat("run.cancel", props.thread, props.memberCount);
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

  if (runs.length === 0 && notice === undefined && confirming === undefined) return null;
  const target = confirming ? runs.find((run) => run.id === confirming.id) : undefined;
  const targetName = confirming ? botName(confirming.botId) : "";

  return (
    <fieldset className="chat-run-stop" aria-label={t("chatRunStop.groupLabel")}>
      {runs.length > 0 && can.allowed ? (
        <div className="chat-run-stop-actions">
          {runs.map((run) => {
            const name = botName(run.botId);
            const busy = stopping.has(run.id);
            return (
              <Button
                key={run.id}
                type="button"
                size="sm"
                variant="destructive"
                title={run.id}
                disabled={busy}
                onClick={() => setConfirming({ id: run.id, botId: run.botId })}
              >
                <Square size={12} aria-hidden="true" />
                {busy
                  ? t("chatRunStop.stopping", { name })
                  : t("chatRunStop.stop", { name, status: runStatusLabel(run.status) })}
              </Button>
            );
          })}
        </div>
      ) : null}
      {runs.length > 0 ? (
        <RoleNote action="run.cancel" allowed={can.allowed} does={t("run.roleNote.cancel")} />
      ) : null}
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
    </fieldset>
  );
}
