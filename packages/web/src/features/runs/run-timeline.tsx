// Compact startup timeline of a run (ADR-0037 decision 5): one list per attempt, every stage in
// order with its time since submission and the wait before it. A stage without a mark says "not
// observed"; nothing is filled in. The timeline is derived by the Gateway from the whole ledger.

import type {
  RunAttemptTimeline,
  RunTimeline,
  RunTimelineStage,
  RunTimelineStageName,
} from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { errorMessage, formatDuration } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";

const STAGE_LABEL: Readonly<Record<RunTimelineStageName, MessageKey>> = {
  submitted: "runTimeline.stage.submitted",
  routed: "runTimeline.stage.routed",
  attempt_started: "runTimeline.stage.attemptStarted",
  sandbox_ready: "runTimeline.stage.sandboxReady",
  sidecar_spawned: "runTimeline.stage.sidecarSpawned",
  sidecar_started: "runTimeline.stage.sidecarStarted",
  query_started: "runTimeline.stage.queryStarted",
  sdk_init: "runTimeline.stage.sdkInit",
  first_upstream_request: "runTimeline.stage.firstUpstreamRequest",
  first_upstream_byte: "runTimeline.stage.firstUpstreamByte",
  first_stream_event: "runTimeline.stage.firstStreamEvent",
  first_token: "runTimeline.stage.firstToken",
  first_text: "runTimeline.stage.firstText",
  first_visible_text: "runTimeline.stage.firstVisibleText",
  run_ended: "runTimeline.stage.runEnded",
  attempt_closed: "runTimeline.stage.attemptClosed",
};

/** A signed duration in the UI's duration format; negative only under clock skew. */
function signedDuration(ms: number): string {
  const text = formatDuration(new Date(0).toISOString(), new Date(Math.abs(ms)).toISOString());
  return ms < 0 ? `−${text}` : text;
}

function StageRow({ stage, slowest }: { stage: RunTimelineStage; slowest: boolean }) {
  const t = useT();
  return (
    <li
      className={`run-timeline-stage${stage.observed ? "" : " missing"}${slowest ? " slowest" : ""}`}
    >
      <span className="run-timeline-label">{t(STAGE_LABEL[stage.stage])}</span>
      {stage.observed ? (
        <>
          <span className="run-timeline-since">
            {stage.sinceStartMs === null ? "" : `+${signedDuration(stage.sinceStartMs)}`}
          </span>
          <span className="run-timeline-gap muted small">
            {stage.gapMs === null ? "" : t("runTimeline.gap", { gap: signedDuration(stage.gapMs) })}
          </span>
        </>
      ) : (
        <span className="run-timeline-since muted small">
          {stage.missing === "not_applicable"
            ? t("runTimeline.notApplicable")
            : t("runTimeline.notObserved")}
        </span>
      )}
    </li>
  );
}

function AttemptTimeline({ attempt }: { attempt: RunAttemptTimeline }) {
  const t = useT();
  const tags = [
    t(attempt.start === "fresh" ? "runTimeline.start.fresh" : "runTimeline.start.resume"),
    t(`runTimeline.session.${attempt.session}`),
    t(`runTimeline.sandbox.${attempt.sandbox}`),
    ...(attempt.sandboxRetried ? [t("runTimeline.sandboxRetried")] : []),
    ...(attempt.modelRetries > 0
      ? [t("runTimeline.modelRetries", { count: attempt.modelRetries })]
      : []),
  ];
  return (
    <section
      className="run-timeline-attempt"
      aria-label={t("runTimeline.attempt", { attempt: attempt.attempt })}
    >
      <h4>
        {t("runTimeline.attempt", { attempt: attempt.attempt })}{" "}
        <span className="muted small">{tags.join(" · ")}</span>
      </h4>
      {attempt.waitingFor ? (
        <p className="small">
          {t("runTimeline.waitingFor", { stage: t(STAGE_LABEL[attempt.waitingFor]) })}
        </p>
      ) : null}
      {attempt.slowestStage ? (
        <p className="small">
          {t("runTimeline.slowest", { stage: t(STAGE_LABEL[attempt.slowestStage]) })}
        </p>
      ) : null}
      <ol className="run-timeline">
        {attempt.stages.map((stage) => (
          <StageRow
            key={stage.stage}
            stage={stage}
            slowest={stage.stage === attempt.slowestStage}
          />
        ))}
      </ol>
      {attempt.sdkReported.ttftMs !== undefined ? (
        <p className="muted small">
          {t("runTimeline.sdkTtft", { duration: signedDuration(attempt.sdkReported.ttftMs) })}
        </p>
      ) : null}
    </section>
  );
}

export function RunTimelinePanel({
  api,
  run,
}: {
  api: Pick<ApiClient, "getRunTimeline">;
  run: RunView;
}) {
  const t = useT();
  const [timeline, setTimeline] = useState<RunTimeline>();
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a status or attempt change adds marks, so the server-derived timeline is read again.
  useEffect(() => {
    let active = true;
    api
      .getRunTimeline(run.id)
      .then((next) => {
        if (active) {
          setTimeline(next);
          setError("");
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [api, run.id, run.status, run.attempt]);
  return (
    <section
      aria-label={t("runTimeline.heading")}
      className="management-subsection run-timeline-panel"
    >
      {error ? <p className="error">{t("runTimeline.error", { error })}</p> : null}
      {!timeline && !error ? <p className="muted">{t("runTimeline.loading")}</p> : null}
      {timeline ? (
        <>
          {timeline.e2eMs !== null ? (
            <p>{t("runTimeline.e2e", { duration: signedDuration(timeline.e2eMs) })}</p>
          ) : null}
          {timeline.attempts.map((attempt) => (
            <AttemptTimeline key={attempt.attempt} attempt={attempt} />
          ))}
          <p className="muted small">{t("runTimeline.clockNote")}</p>
        </>
      ) : null}
    </section>
  );
}
