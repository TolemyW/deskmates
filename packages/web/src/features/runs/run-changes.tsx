// "What this run changed" in the run drawer (issue #11, ADR-0042 decision 4): what it learned and
// with which trust, the files and sites it touched, the memory it wrote and was given, the
// approvals it asked for and how they were decided, its task checkpoints and artifacts, and the
// model, skill set and SOUL version frozen in its configuration. Two requests per run, in
// parallel: `GET /api/runs/:id/changes` and `GET /api/runs/:id/memory-versions`; everything else
// is on the run row. The section also holds the run's "wrong" mark and the replay export.

import {
  type RunChanges,
  type RunId,
  type RunMark,
  isTerminal,
  recordedSkillSet,
} from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import type { RunSuppliedMemoryVersion } from "./api.js";
import { FailureClassLabel } from "./failure-class.js";
import { RunMarkControl } from "./run-mark.js";

export interface RunChangesSectionProps {
  api: Pick<ApiClient, "getRunChanges" | "listRunMemoryVersions" | "markRun" | "unmarkRun">;
  run: RunView;
}

/** The exact exporter command that turns this run into `evals/traces/<runId>.json`. */
export function replayExportCommand(runId: string, origin: string): string {
  return `npm run replay -- export --gateway ${origin} --run ${runId}`;
}

function frozenModel(config: Record<string, unknown>): string | undefined {
  const model = config.model ?? config.defaultModel;
  return typeof model === "string" && model !== "" ? model : undefined;
}

export function RunChangesSection({ api, run }: RunChangesSectionProps) {
  const t = useT();
  // The mark, the memory it was given, what was frozen at start and the replay export are for
  // tuning (docs/use-and-tune-views.md); the use view keeps what the run changed.
  const tune = useTuneView();
  const runId = run.id as RunId;
  const [changes, setChanges] = useState<RunChanges>();
  const [supplied, setSupplied] = useState<RunSuppliedMemoryVersion[]>();
  const [error, setError] = useState<string>();
  const [mark, setMark] = useState<RunMark | undefined>(run.mark);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([api.getRunChanges(runId), api.listRunMemoryVersions(runId)])
      .then(([loaded, versions]) => {
        if (!active) return;
        setChanges(loaded);
        setSupplied(versions);
        setMark(loaded.mark);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [api, runId]);

  const learned = run.summary?.learned ?? [];
  const files = run.summary?.filesChanged ?? [];
  const sites = run.summary?.sitesVisited ?? [];
  const model = frozenModel(run.config);
  const skills = recordedSkillSet(run.config)?.set ?? [];
  const soulVersion = run.config.canonicalSoulVersion;
  const promptSha = run.config.systemPromptSha256;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const command = replayExportCommand(runId, origin);
  const canCopy = typeof navigator !== "undefined" && navigator.clipboard !== undefined;

  return (
    <details className="run-metadata run-changes" data-testid="run-changes">
      <summary>{t("runChanges.heading")}</summary>
      {error ? <p className="error small">{error}</p> : null}
      {run.failureClass ? (
        <p className="small">
          {t("runChanges.failureClass")} <FailureClassLabel failureClass={run.failureClass} />
        </p>
      ) : null}
      {tune ? (
        <RunMarkControl
          runId={runId}
          mark={mark}
          actions={{ mark: api.markRun, unmark: api.unmarkRun }}
          onChange={setMark}
        />
      ) : null}
      {changes?.prunedAt ? (
        <p className="notice small">
          {t("runChanges.pruned", { when: formatDateTime(changes.prunedAt) })}
        </p>
      ) : null}

      <h4>{t("runChanges.learned")}</h4>
      {learned.length === 0 ? (
        <p className="muted small">{t("runChanges.none")}</p>
      ) : (
        <ul className="small">
          {learned.map((item, index) => (
            // The summary is immutable once stored; its position is the item's identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordinal is the item's ledger key.
            <li key={index}>
              <span className={`trust-mark ${item.trust ?? "untrusted"}`}>
                {t(
                  item.trust === "trusted"
                    ? "runChanges.trust.trusted"
                    : "runChanges.trust.untrusted",
                )}
              </span>{" "}
              <span className="muted">{item.proposedScope}</span> {item.body}
            </li>
          ))}
        </ul>
      )}

      <h4>{t("runChanges.files")}</h4>
      {files.length === 0 ? (
        <p className="muted small">{t("runChanges.none")}</p>
      ) : (
        <ul className="small">
          {files.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      )}

      <h4>{t("runChanges.sites")}</h4>
      {sites.length === 0 ? (
        <p className="muted small">{t("runChanges.none")}</p>
      ) : (
        <ul className="small">
          {sites.map((site) => (
            <li key={site}>
              <code>{site}</code>
            </li>
          ))}
        </ul>
      )}

      <h4>{t("runChanges.memoryWritten")}</h4>
      {changes === undefined ? (
        <p className="muted small">{t("runChanges.loading")}</p>
      ) : changes.memoryWritten.length === 0 ? (
        <p className="muted small">{t("runChanges.none")}</p>
      ) : (
        <ul className="small">
          {changes.memoryWritten.map((entry) => (
            <li key={entry.entryId}>
              <span className={`trust-mark ${entry.trust}`}>
                {t(
                  entry.trust === "trusted"
                    ? "runChanges.trust.trusted"
                    : "runChanges.trust.untrusted",
                )}
              </span>{" "}
              <span className="muted">
                {t("runChanges.entryMeta", {
                  scope: entry.scope,
                  kind: entry.kind,
                  version: entry.version,
                })}
              </span>{" "}
              {entry.tombstoned ? (
                <em className="muted">{t("runChanges.forgotten")}</em>
              ) : (
                entry.body
              )}
            </li>
          ))}
        </ul>
      )}

      {tune ? (
        <>
          <h4>{t("runChanges.memorySupplied")}</h4>
          {supplied === undefined ? (
            <p className="muted small">{t("runChanges.loading")}</p>
          ) : supplied.length === 0 ? (
            <p className="muted small">{t("runChanges.none")}</p>
          ) : (
            <ul className="small">
              {supplied.map((version) => (
                <li key={`${version.entryId}@${version.version}:${version.via}`}>
                  <code>
                    {version.entryId}@{version.version}
                  </code>{" "}
                  <span className="muted">{version.via}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <h4>{t("runChanges.approvals")}</h4>
      {changes === undefined ? (
        <p className="muted small">{t("runChanges.loading")}</p>
      ) : changes.approvals.length === 0 ? (
        <p className="muted small">{t("runChanges.none")}</p>
      ) : (
        <ul className="small">
          {changes.approvals.map((approval) => (
            <li key={approval.id}>
              <code>{approval.action.toolName}</code>{" "}
              {approval.decision
                ? t("runChanges.approvalDecided", {
                    decision: approval.decision,
                    who: approval.decidedBy ?? "",
                    when: formatDateTime(approval.decidedAt),
                  })
                : t("runChanges.approvalPending")}
            </li>
          ))}
        </ul>
      )}

      <h4>{t("runChanges.tasks")}</h4>
      {changes === undefined ? (
        <p className="muted small">{t("runChanges.loading")}</p>
      ) : changes.checkpoints.length === 0 && changes.artifacts.length === 0 ? (
        <p className="muted small">{t("runChanges.none")}</p>
      ) : (
        <ul className="small">
          {changes.checkpoints.map((checkpoint) => (
            <li key={checkpoint.id}>
              {t("runChanges.checkpoint", {
                task: checkpoint.taskId,
                attempt: checkpoint.attempt,
                when: formatDateTime(checkpoint.createdAt),
              })}
            </li>
          ))}
          {changes.artifacts.map((artifact) => (
            <li key={`${artifact.taskId}:${artifact.ordinal}`}>
              {t("runChanges.artifact", { task: artifact.taskId, label: artifact.label })}{" "}
              <code>{artifact.path}</code>
            </li>
          ))}
        </ul>
      )}

      {tune ? (
        <>
          <h4>{t("runChanges.frozen")}</h4>
          <dl className="run-facts small">
            <dt>{t("runChanges.model")}</dt>
            <dd>{model ? <code>{model}</code> : t("runChanges.notRecorded")}</dd>
            <dt>{t("runChanges.skills")}</dt>
            <dd>
              {skills.length === 0
                ? t("runChanges.none")
                : skills.map((skill) => `${skill.name}@${skill.version}`).join(", ")}
            </dd>
            <dt>{t("runChanges.soul")}</dt>
            <dd>
              {typeof soulVersion === "number"
                ? t("runChanges.version", { version: soulVersion })
                : t("runChanges.notRecorded")}
            </dd>
            {typeof promptSha === "string" ? (
              <>
                <dt>{t("runChanges.systemPrompt")}</dt>
                <dd>
                  <code>{promptSha.slice(0, 12)}</code>
                </dd>
              </>
            ) : null}
          </dl>

          {isTerminal(run.status) ? (
            <div className="run-replay" data-testid="run-replay">
              <h4>{t("runChanges.replay.heading")}</h4>
              <p className="muted small">
                {t("runChanges.replay.how", { path: `evals/traces/${runId}.json` })}
              </p>
              <pre className="small">{command}</pre>
              {canCopy ? (
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(command).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? t("runChanges.replay.copied") : t("runChanges.replay.copy")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
