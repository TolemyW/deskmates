import type { RunContextMetrics, RunEvent, RunStatus } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useLocale, useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { RoleNote } from "../../state/session-roles.js";

const STATUS_TEXT: Record<RunStatus, MessageKey> = {
  queued: "runContextPanel.status.queued",
  running: "runContextPanel.status.running",
  stalled: "runContextPanel.status.stalled",
  waiting_approval_live: "runContextPanel.status.waitingApprovalLive",
  waiting_approval: "runContextPanel.status.waitingApproval",
  waiting_browser: "runContextPanel.status.waitingBrowser",
  waiting_continuation: "runContextPanel.status.waitingContinuation",
  waiting_platform: "runContextPanel.status.waitingPlatform",
  succeeded: "runContextPanel.status.succeeded",
  silent: "runContextPanel.status.silent",
  failed: "runContextPanel.status.failed",
  cancelled: "runContextPanel.status.cancelled",
  stopped: "runContextPanel.status.stopped",
};

function numberOrUnknown(value: unknown): string {
  const { locale, t } = currentI18n();
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(locale)
    : t("runContextPanel.unknown");
}

/**
 * The continuation limit a run froze when it first started (ADR-0016 amendment 2 decisions 15 and
 * 16): a number, or `null` for `off` (no limit). A run from before the limits were frozen
 * (`limitsVersion` absent) kept the fixed default of 2, as the Gateway still reads it.
 */
export function frozenContinuationLimit(config: Record<string, unknown>): number | null {
  if (config.limitsVersion !== 1) return 2;
  return typeof config.continuationLimit === "number" ? config.continuationLimit : null;
}

export function RunContextPanel({
  api,
  run,
  events,
  onRunChanged,
  canContinue = true,
}: {
  api: Pick<ApiClient, "getRunContext" | "decideContinuation"> &
    Partial<Pick<ApiClient, "resumePlatformRuns">>;
  run: RunView;
  events: readonly RunEvent[];
  onRunChanged: (run: RunView) => void;
  /** False for a Member outside their own side chat (ADR-0022 amendment 1 A12). */
  canContinue?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [metrics, setMetrics] = useState<RunContextMetrics>();
  const [metricsError, setMetricsError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const measurementSeq = events
    .filter((event) => event.kind === "turn_usage" || event.kind === "compact_boundary")
    .at(-1)?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: status, attempt and receipt changes invalidate server-derived metrics; refresh is the explicit retry key.
  useEffect(() => {
    let active = true;
    api
      .getRunContext(run.id)
      .then((next) => {
        if (active) {
          setMetrics(next);
          setMetricsError("");
        }
      })
      .catch((error: unknown) => {
        if (active) setMetricsError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [api, run.id, run.status, run.attempt, measurementSeq, refresh]);

  const decide = async (decision: "continue" | "stop") => {
    setBusy(true);
    setActionError("");
    try {
      onRunChanged((await api.decideContinuation(run.id, decision)).run);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  // ADR-0029 decision 6: an operator lets a run the restart breaker holds continue.
  const resumeHeld = async () => {
    setBusy(true);
    setActionError("");
    try {
      await api.resumePlatformRuns?.([run.id]);
      onRunChanged({ ...run, config: { ...run.config, platformHeld: false } });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const memory = events.filter((event) => event.kind === "memory_index").at(-1)?.payload;
  const skipped = events.filter(
    (event) =>
      event.kind === "memory_skipped" ||
      (event.kind === "log" && event.payload.kind === "memory_skipped"),
  );
  const ruleChanges = events.filter((event) => event.kind === "rule_file_modified");
  const handoff = typeof run.config.handoffPath === "string" ? run.config.handoffPath : undefined;
  const continuationLimit = frozenContinuationLimit(run.config);
  return (
    <section aria-label={t("runContextPanel.region")} className="management-subsection">
      <h3>{t("runContextPanel.heading")}</h3>
      <output>{t(STATUS_TEXT[run.status])}</output>
      <p>
        {continuationLimit === null
          ? t("runContextPanel.attemptNoLimit", {
              attempt: run.attempt ?? 1,
              used: numberOrUnknown(run.config.continuationCount ?? 0),
            })
          : t("runContextPanel.attempt", {
              attempt: run.attempt ?? 1,
              used: numberOrUnknown(run.config.continuationCount ?? 0),
              limit: numberOrUnknown(continuationLimit),
            })}
      </p>
      {run.status === "waiting_continuation" ? (
        <div>
          <p>
            {handoff
              ? t.rich("runContextPanel.partialWork", {
                  path: handoff,
                  code: (chunks) => <code>{chunks}</code>,
                })
              : t("runContextPanel.noHandoff")}
          </p>
          <p>{t("runContextPanel.continueHelp")}</p>
          {canContinue ? (
            <>
              <Button disabled={busy} onClick={() => void decide("continue")}>
                {t("runContextPanel.continue")}
              </Button>
              <Button disabled={busy} onClick={() => void decide("stop")}>
                {t("runContextPanel.stop")}
              </Button>
            </>
          ) : null}
          <RoleNote
            action="run.continue"
            allowed={canContinue}
            does={t("runContextPanel.roleNote")}
          />
          {actionError ? <p role="alert">{actionError}</p> : null}
        </div>
      ) : null}
      {run.status === "waiting_platform" &&
      run.config.platformHeld === true &&
      api.resumePlatformRuns ? (
        <div>
          <p>{t("runContextPanel.platformHeld")}</p>
          <Button disabled={busy} onClick={() => void resumeHeld()}>
            {t("runContextPanel.platformResume")}
          </Button>
          {actionError ? <p role="alert">{actionError}</p> : null}
        </div>
      ) : null}
      <h4>{t("runContextPanel.contextHeading")}</h4>
      {metricsError ? (
        <p role="alert">{t("runContextPanel.metricsUnavailable", { error: metricsError })}</p>
      ) : null}
      <Button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        {t("runContextPanel.refresh")}
      </Button>
      <dl className="run-facts">
        <dt>{t("runContextPanel.turns")}</dt>
        <dd>{numberOrUnknown(metrics?.turns)}</dd>
        <dt>{t("runContextPanel.peakInput")}</dt>
        <dd>{t("runContextPanel.tokens", { count: numberOrUnknown(metrics?.peakInputTokens) })}</dd>
        <dt>{t("runContextPanel.p95Input")}</dt>
        <dd>{t("runContextPanel.tokens", { count: numberOrUnknown(metrics?.p95InputTokens) })}</dd>
        <dt>{t("runContextPanel.cacheHitRatio")}</dt>
        <dd>
          {typeof metrics?.cacheHitRatio === "number"
            ? metrics.cacheHitRatio.toLocaleString(locale, {
                style: "percent",
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })
            : t("runContextPanel.unknown")}
        </dd>
        <dt>{t("runContextPanel.compactions")}</dt>
        <dd>{metrics ? metrics.compactions.length : t("runContextPanel.unknown")}</dd>
        <dt>{t("runContextPanel.window")}</dt>
        <dd>
          {typeof metrics?.maxContextTokens === "number"
            ? t("runContextPanel.tokens", { count: numberOrUnknown(metrics.maxContextTokens) })
            : t("runContextPanel.windowUnknown")}
        </dd>
        <dt>{t("runContextPanel.promptHash")}</dt>
        <dd>
          {metrics?.systemPromptSha256 ? (
            <code title={metrics.systemPromptSha256}>
              {metrics.systemPromptSha256.slice(0, 12)}
            </code>
          ) : (
            t("runContextPanel.unknown")
          )}
        </dd>
        <dt>{t("runContextPanel.modelRequests")}</dt>
        <dd>
          {metrics
            ? t("runContextPanel.modelRequestsValue", {
                count: numberOrUnknown(metrics.modelRequests.count),
                distinct: numberOrUnknown(metrics.modelRequests.distinctSystemHashes),
              })
            : t("runContextPanel.unknown")}
        </dd>
      </dl>
      {metrics?.modelRequests.changedWithinAttempt ? (
        <p role="alert">{t("runContextPanel.promptChanged")}</p>
      ) : null}
      <WindowMeter metrics={metrics} />
      <SectionSizes sections={metrics?.contextSections ?? null} />
      <p>{t("runContextPanel.missingMeaning")}</p>
      {memory ? (
        <p>
          {t("runContextPanel.memoryIndex", {
            considered: numberOrUnknown(memory.considered),
            pinned: numberOrUnknown(memory.pinned),
            untrusted: numberOrUnknown(memory.untrusted),
            budget: numberOrUnknown(memory.budget),
            ineligible: numberOrUnknown(memory.ineligible),
          })}
        </p>
      ) : (
        <p>{t("runContextPanel.noMemoryIndex")}</p>
      )}
      <p>{t("runContextPanel.indexScope")}</p>
      {skipped.length ? <p>{t("runContextPanel.skipped", { count: skipped.length })}</p> : null}
      {ruleChanges.length ? (
        <p role="alert">{t("runContextPanel.ruleChanges", { count: ruleChanges.length })}</p>
      ) : null}
    </section>
  );
}

/**
 * Issue #9: the largest input window the run reached against the window the CLI was given. With
 * no window reported there is no denominator, and the panel says so instead of guessing one.
 */
function WindowMeter({ metrics }: { metrics: RunContextMetrics | undefined }) {
  const t = useT();
  const locale = useLocale();
  const peak = metrics?.peakInputTokens;
  const limit = metrics?.maxContextTokens;
  if (typeof peak !== "number" || typeof limit !== "number" || limit <= 0) return null;
  const share = peak / limit;
  return (
    <p className="context-meter">
      <label>
        {t("runContextPanel.meter")}{" "}
        <meter min={0} max={limit} low={limit * 0.6} high={limit * 0.85} optimum={0} value={peak}>
          {share.toLocaleString(locale, { style: "percent" })}
        </meter>{" "}
        <span className="muted small">
          {t("runContextPanel.meterValue", {
            percent: share.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 }),
          })}
        </span>
      </label>
    </p>
  );
}

/** Issue #9: the system prompt's sections by size, largest first, as the sidecar measured them. */
function SectionSizes({ sections }: { sections: Record<string, number> | null }) {
  const t = useT();
  if (!sections || Object.keys(sections).length === 0)
    return <p>{t("runContextPanel.sectionsNone")}</p>;
  const entries = Object.entries(sections).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const largest = Math.max(1, ...entries.map(([, size]) => size));
  return (
    <>
      <h4>{t("runContextPanel.sectionsHeading")}</h4>
      <ul className="context-sections" aria-label={t("runContextPanel.sectionsList")}>
        {entries.map(([name, size]) => (
          <li key={name}>
            <code>{name}</code>
            <span className="context-section-bar" aria-hidden="true">
              <span style={{ width: `${(size / largest) * 100}%` }} />
            </span>
            <span className="muted small">
              {t("runContextPanel.sectionSize", { count: numberOrUnknown(size) })}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
