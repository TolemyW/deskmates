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
  api: Pick<ApiClient, "getRunContext" | "decideContinuation">;
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
      </dl>
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
