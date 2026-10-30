// A templated task's kind on its task page (ADR-0021 amendment 4): the kind and its fields, the
// criteria progress the Gateway reads from checkpoints and deliveries (A4e), and related tasks of
// the same kind with their reasons (A4h). Discrepancies are named, never corrected; nothing here
// merges or changes a task.

import type {
  RelatedTaskList,
  Task,
  TaskDetailResponse,
  TaskKindProgress,
  WorkspaceId,
} from "@deskmates/contracts";
import { Pill } from "@deskmates/ui";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { taskHref } from "../tasks/route.js";
import { CRITERION_LABELS, reviewLabel, slaLabel } from "./template-text.js";

export function TaskKindPanel({
  api,
  workspaceId,
  task,
}: {
  api: Pick<ApiClient, "getTaskDetail" | "listRelatedTasks">;
  workspaceId: WorkspaceId;
  task: Task;
}) {
  const t = useT();
  const kind = task.kind;
  const [progress, setProgress] = useState<TaskKindProgress>();
  const [related, setRelated] = useState<RelatedTaskList>();
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version of the task rereads both.
  useEffect(() => {
    if (!kind) return;
    let live = true;
    setError("");
    Promise.all([
      api.getTaskDetail(workspaceId, task.id),
      api.listRelatedTasks(workspaceId, task.id),
    ]).then(
      ([detail, list]: [TaskDetailResponse, RelatedTaskList]) => {
        if (!live) return;
        setProgress(detail.kindProgress);
        setRelated(list);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, task.id, task.version, kind]);
  if (!kind) return null;
  const stageName = (key: string | null) =>
    key === null ? "" : (kind.stages.find((s) => s.key === key)?.name ?? key);
  const fieldEntries = kind.fieldDefs.filter((d) => (kind.fields[d.key] ?? "") !== "");
  return (
    <section className="task-kind-panel" aria-label={t("taskKinds.panel.region")}>
      <h3>{t("taskKinds.panel.heading", { name: kind.name })}</h3>
      <p className="muted small">
        {slaLabel(t, kind.slaMinutes)} · {reviewLabel(t, kind.review)} ·{" "}
        {t("taskKinds.panel.templateVersion", { version: kind.templateVersion })}
      </p>
      {fieldEntries.length > 0 ? (
        <dl className="task-kind-fields">
          {fieldEntries.map((def) => (
            <div key={def.key}>
              <dt>{def.label}</dt>
              <dd>{kind.fields[def.key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {progress ? (
        <div className="task-kind-progress">
          <h4>{t("taskKinds.progress.heading")}</h4>
          <p className="muted small">
            {progress.currentStage === null
              ? t("taskKinds.progress.allMet")
              : t("taskKinds.progress.currentStage", { stage: stageName(progress.currentStage) })}
          </p>
          <ul>
            {progress.criteria.map((c) => (
              <li key={c.label}>
                <Pill
                  tone={c.state === "met" ? "success" : c.state === "open" ? "warning" : "neutral"}
                >
                  {t(CRITERION_LABELS[c.state])}
                </Pill>{" "}
                <code>{c.label}</code> {c.text}
                {c.state === "met" ? (
                  <span className="muted small">
                    {" "}
                    {t("taskKinds.progress.evidence", { count: c.evidence })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {progress.missingCheckpoints.length > 0 ? (
            <p className="muted small">
              {t("taskKinds.progress.missingCheckpoints", {
                stages: progress.missingCheckpoints.map(stageName).join(", "),
              })}
            </p>
          ) : null}
          {progress.discrepancies.map((d) => (
            <p key={d.kind} className="task-warning" role="note">
              {d.kind === "delivered_missing_checkpoint"
                ? t("taskKinds.progress.deliveredMissingCheckpoint", {
                    stages: d.items.map(stageName).join(", "),
                  })
                : t("taskKinds.progress.deliveredOpenCriteria", { labels: d.items.join(", ") })}
            </p>
          ))}
          <p className="muted small">{t("taskKinds.progress.note")}</p>
        </div>
      ) : null}
      {related ? (
        <div className="task-kind-related">
          <h4>{t("taskKinds.related.heading")}</h4>
          <p className="muted small">
            {related.method === "embedding"
              ? t("taskKinds.related.methodEmbedding")
              : related.method === "lexical_fallback"
                ? t("taskKinds.related.methodFallback")
                : t("taskKinds.related.methodLexical")}
          </p>
          {related.related.length === 0 ? (
            <p className="muted">{t("taskKinds.related.none")}</p>
          ) : (
            <ul>
              {related.related.map((r) => (
                <li key={r.id}>
                  <a href={taskHref(r.id)}>{r.title}</a>{" "}
                  {r.possibleDuplicate ? (
                    <Pill tone="warning">{t("taskKinds.related.duplicate")}</Pill>
                  ) : null}
                  <span className="muted small">
                    {" "}
                    {r.reasons
                      .map((reason) =>
                        reason.kind === "field"
                          ? t("taskKinds.related.sameField", {
                              label: reason.label ?? reason.field ?? "",
                              value: reason.value ?? "",
                            })
                          : t("taskKinds.related.similarText", {
                              score: (reason.score ?? 0).toFixed(2),
                            }),
                      )
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">{t("taskKinds.related.note")}</p>
        </div>
      ) : null}
    </section>
  );
}
