// ADR-0021 amendment 3 in the Tasks screen: the trigger chosen at creation (Immediately by
// default, Scheduled, Manual), and the measured execution beside the declared state: schedule
// and next occurrence, submissions with their runs' Gateway times, deliveries and the latest
// checkpoint. Run and Delete are explicit acts; ordinary edits never rerun a task.

import type {
  CreateTaskRequest,
  Task,
  TaskDetailResponse,
  TaskExecutionState,
  TaskScheduleInput,
  TaskSubmissionKind,
  TaskTrigger,
  WorkspaceId,
} from "@deskmates/contracts";
import { Input } from "@deskmates/ui";
import { Select } from "@deskmates/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref } from "../../router.js";
import { WorkspaceFilePreview } from "../files/workspace-file-preview.js";

export interface TriggerDraft {
  trigger: TaskTrigger;
  scheduleKind: "once" | "repeat";
  /** `datetime-local` text, read in the browser's zone. */
  runAt: string;
  cron: string;
  timeZone: string;
}

export function triggerDraft(): TriggerDraft {
  return {
    trigger: "immediate",
    scheduleKind: "once",
    runAt: "",
    cron: "0 9 * * 1",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

/** A fresh client key per intended act; reused for a retry of the same act (A3b). */
export function newIdempotencyKey(): string {
  return `web-${globalThis.crypto.randomUUID()}`;
}

/** The trigger part of a create body, or the message naming what is missing. */
export function triggerRequest(
  draft: TriggerDraft,
  ownerBotId: string,
  now: Date = new Date(),
): Pick<CreateTaskRequest, "trigger" | "schedule"> | { invalid: MessageKey } {
  if (draft.trigger !== "manual" && !ownerBotId) return { invalid: "tasks.invalid.owner" };
  if (draft.trigger !== "scheduled") return { trigger: draft.trigger };
  let schedule: TaskScheduleInput;
  if (draft.scheduleKind === "once") {
    const at = new Date(draft.runAt);
    if (!draft.runAt || Number.isNaN(at.getTime()) || at <= now)
      return { invalid: "tasks.invalid.schedule" };
    schedule = { kind: "once", runAt: at.toISOString(), timeZone: draft.timeZone };
  } else {
    if (draft.cron.trim().split(/\s+/).length !== 5) return { invalid: "tasks.invalid.schedule" };
    schedule = { kind: "repeat", cron: draft.cron.trim(), timeZone: draft.timeZone };
  }
  if (!draft.timeZone.trim()) return { invalid: "tasks.invalid.schedule" };
  return { trigger: "scheduled", schedule };
}

export function TaskTriggerFields({
  draft,
  fieldId,
  onChange,
}: {
  draft: TriggerDraft;
  fieldId: string;
  onChange: (next: TriggerDraft) => void;
}) {
  const t = useT();
  const set = (patch: Partial<TriggerDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="task-trigger">
      <Select
        label={t("tasks.trigger.label")}
        value={draft.trigger}
        onValueChange={(value) => set({ trigger: value as TaskTrigger })}
        options={[
          { value: "immediate", label: t("tasks.trigger.immediate") },
          { value: "scheduled", label: t("tasks.trigger.scheduled") },
          { value: "manual", label: t("tasks.trigger.manual") },
        ]}
      />
      <p className="muted small">{t(`tasks.trigger.help.${draft.trigger}` as MessageKey)}</p>
      {draft.trigger === "scheduled" ? (
        <div className="task-form-row">
          <Select
            label={t("tasks.trigger.kind")}
            value={draft.scheduleKind}
            onValueChange={(value) => set({ scheduleKind: value as "once" | "repeat" })}
            options={[
              { value: "once", label: t("tasks.trigger.once") },
              { value: "repeat", label: t("tasks.trigger.repeat") },
            ]}
          />
          {draft.scheduleKind === "once" ? (
            <label htmlFor={`${fieldId}-runAt`}>
              {t("tasks.trigger.runAt")}
              <Input
                id={`${fieldId}-runAt`}
                type="datetime-local"
                value={draft.runAt}
                onChange={(event) => set({ runAt: event.target.value })}
              />
            </label>
          ) : (
            <label htmlFor={`${fieldId}-cron`}>
              {t("tasks.trigger.cron")}
              <Input
                id={`${fieldId}-cron`}
                value={draft.cron}
                maxLength={200}
                onChange={(event) => set({ cron: event.target.value })}
              />
            </label>
          )}
          <label htmlFor={`${fieldId}-timeZone`}>
            {t("tasks.trigger.timeZone")}
            <Input
              id={`${fieldId}-timeZone`}
              value={draft.timeZone}
              maxLength={64}
              onChange={(event) => set({ timeZone: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

const LIVE = new Set(["queued", "running", "waiting_approval_live"]);

/** A time shown in a named zone, falling back to the browser's when the zone is unknown. */
function inZone(iso: string, zone: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone: zone, timeZoneName: "short" });
  } catch {
    return formatDateTime(iso);
  }
}

export function TaskExecutionPanel({
  api,
  workspaceId,
  task,
  canEdit,
  onChanged,
  onDeleted,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  task: Task;
  canEdit: boolean;
  onChanged: (task: Task) => void;
  onDeleted: (task: Task) => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<TaskDetailResponse>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // One key per intended Run: a double click or a retry after a lost answer reuses it.
  const runKey = useRef(newIdempotencyKey());
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await api.getTaskDetail(workspaceId, task.id);
      if (request === sequence.current) setDetail(next);
    } catch (err) {
      if (request === sequence.current) setError(errorMessage(err));
    }
  }, [api, workspaceId, task.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the record's version moves
  useEffect(() => {
    void load();
  }, [load, task.version]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.runTask(workspaceId, task.id, task.version, runKey.current);
      runKey.current = newIdempotencyKey();
      setNotice(t("tasks.execution.ran"));
      onChanged(result.task);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.deleteTask(workspaceId, task.id, task.version);
      onDeleted(task);
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const execution = detail?.task.id === task.id ? detail.execution : undefined;
  const schedule = task.schedule;
  const activeLinked = execution?.linkedRuns.some((r) => LIVE.has(r.status)) ?? false;
  const latestDelivery = execution?.deliveries[0];
  const checkpoint = execution?.latestCheckpoint;
  const closed = task.status === "accepted" || task.status === "cancelled";

  return (
    <section className="task-execution" aria-label={t("tasks.execution.region")}>
      <h3>{t("tasks.execution.heading")}</h3>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <output className="task-notice">{notice}</output> : null}
      {schedule ? (
        <div className="task-execution-schedule">
          <h4>{t("tasks.execution.schedule")}</h4>
          <p>
            {schedule.kind === "once" && schedule.runAt
              ? t("tasks.execution.scheduleOnce", {
                  time: inZone(schedule.runAt, schedule.timeZone),
                  zone: schedule.timeZone,
                })
              : t("tasks.execution.scheduleRepeat", {
                  cron: schedule.cron ?? "",
                  zone: schedule.timeZone,
                })}
          </p>
          <p className="muted small">
            {schedule.nextFireAt
              ? t("tasks.execution.nextOccurrence", {
                  time: `${inZone(schedule.nextFireAt, schedule.timeZone)} · ${formatDateTime(schedule.nextFireAt)}`,
                })
              : t("tasks.execution.noNextOccurrence")}
          </p>
        </div>
      ) : null}
      {canEdit ? (
        <div className="task-actions">
          <Button
            type="button"
            variant="default"
            disabled={busy || closed || !task.ownerBotId}
            onClick={() => void run()}
          >
            {t("tasks.execution.run")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void remove()}>
            {confirmDelete ? t("tasks.execution.deleteConfirm") : t("tasks.execution.delete")}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void load()}>
            {t("tasks.execution.refresh")}
          </Button>
        </div>
      ) : null}
      {canEdit ? (
        <p className="muted small">
          {confirmDelete ? t("tasks.execution.deleteHelp") : t("tasks.execution.runHelp")}
        </p>
      ) : null}
      {execution ? (
        <>
          <p className="muted small">
            {t("tasks.execution.observed", { time: formatDateTime(execution.observedAt) })}
          </p>
          {activeLinked && task.status === "planned" ? (
            <p className="task-warning">{t("tasks.execution.discrepancy.active")}</p>
          ) : null}
          {latestDelivery?.kind === "partial" ? (
            <p className="task-warning">
              {t("tasks.execution.discrepancy.outstanding", {
                count: latestDelivery.outstanding.length,
              })}
            </p>
          ) : null}
          {execution.submissions.length === 0 ? (
            <p className="muted">{t("tasks.execution.none")}</p>
          ) : (
            <ul className="task-submissions">
              {execution.submissions.map((submission) => (
                <li key={submission.id}>
                  <strong>
                    {t("tasks.execution.submission", {
                      kind: t(
                        `tasks.execution.kind.${submission.kind satisfies TaskSubmissionKind}` as MessageKey,
                      ),
                      time: formatDateTime(submission.createdAt),
                    })}
                  </strong>{" "}
                  <span className={`task-execution-state ${submission.state}`}>
                    {t(
                      `tasks.execution.state.${submission.state satisfies TaskExecutionState}` as MessageKey,
                    )}
                  </span>
                  {submission.runs.map((r) => (
                    <div key={r.id} className="muted small">
                      <a href={runHref(r.id)}>
                        {t("tasks.execution.runLine", {
                          id: r.id,
                          status: r.status,
                          created: formatDateTime(r.createdAt),
                          started: formatDateTime(r.startedAt ?? undefined),
                          finished: formatDateTime(r.finishedAt ?? undefined),
                        })}
                      </a>
                      {r.pendingApprovals > 0
                        ? ` · ${t("tasks.execution.pendingApprovals", { count: r.pendingApprovals })}`
                        : null}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {checkpoint ? (
            <p className="muted small">
              {t("tasks.execution.checkpoint", {
                run: checkpoint.runId ?? "?",
                attempt: checkpoint.attempt,
                time: formatDateTime(checkpoint.createdAt),
                done: checkpoint.completed.filter((u) => u.evidence.length > 0).length,
                missing: checkpoint.completed.filter((u) => u.evidence.length === 0).length,
                open: checkpoint.outstanding.length,
              })}
            </p>
          ) : null}
          {execution.deliveries.length > 0 ? (
            <div className="task-deliveries">
              <h4>{t("tasks.execution.deliveries")}</h4>
              <ul>
                {execution.deliveries.map((delivery) => (
                  <li key={delivery.id}>
                    <strong>
                      {t("tasks.execution.delivery.line", {
                        kind: t(
                          delivery.kind === "partial"
                            ? "tasks.execution.delivery.partial"
                            : "tasks.execution.delivery.complete",
                        ),
                        by: delivery.deliveredBy,
                        time: formatDateTime(delivery.createdAt),
                      })}
                    </strong>
                    <p>{delivery.summary}</p>
                    {delivery.outstanding.length > 0 ? (
                      <p className="muted small">
                        {t("tasks.execution.delivery.outstanding", {
                          items: delivery.outstanding.join("; "),
                        })}
                      </p>
                    ) : null}
                    {delivery.publications.length === 0 ? (
                      <p className="muted small">{t("tasks.execution.delivery.noFiles")}</p>
                    ) : (
                      delivery.publications.map((p) => (
                        <div key={p.path} className="task-delivery-publication">
                          <p className="muted small">
                            {t("tasks.execution.delivery.published", {
                              path: p.path,
                              size: p.sizeBytes,
                              sha: p.sha256.slice(0, 12),
                              time: formatDateTime(p.checkedAt),
                            })}
                          </p>
                          {/* ADR-0014 amendment A6 decision 40: the same drawer as every file link. */}
                          <WorkspaceFilePreview
                            api={api}
                            workspaceId={workspaceId}
                            path={p.path}
                            compact
                          />
                        </div>
                      ))
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
