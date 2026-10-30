// The story panel of the run screen: the bot's thoughts as headings, the steps under each in
// plain verbs, the open step ticking while the run is live (`run-story.ts` derives it all from
// the ledger). Screenshots open under their step; the raw payloads stay in the technical log.

import type { RunEvent } from "@deskmates/contracts";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { formatTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { desktopDenials } from "./desktop-denials.js";
import { elapsedMs, formatElapsed, formatSpan } from "./run-activity.js";
import { screenshotSource } from "./run-event-row.js";
import { type StorySegment, type StoryStep, storyOf, storySize } from "./run-story.js";

export interface RunStoryProps {
  events: readonly RunEvent[];
  /** The run is still going: the open step ticks and the heading says so. */
  live: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

/** A clock that ticks once a second while `active`, for the open step's elapsed time. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function RunStory({ events, live, hasOlder, loadingOlder, onLoadOlder }: RunStoryProps) {
  const t = useT();
  const segments = useMemo(() => storyOf(events), [events]);
  const hasOpen = live && segments.some((s) => s.steps.some((step) => step.tool?.open));
  const now = useTick(hasOpen);
  const size = storySize(segments);
  const denials = useMemo(() => desktopDenials(events), [events]);
  return (
    <section className="run-story" aria-label={t("runStory.region")}>
      <h3>{live ? t("runStory.heading.live") : t("runStory.heading.done")}</h3>
      {denials.count > 0 ? (
        <p className="small" role="note" data-testid="story-desktop-denials">
          {t("runStory.desktopDenials", { count: denials.count })}
        </p>
      ) : null}
      {hasOlder ? (
        <Button size="sm" variant="ghost" disabled={loadingOlder} onClick={onLoadOlder}>
          {loadingOlder ? t("runStory.loadingOlder") : t("runStory.loadOlder")}
        </Button>
      ) : null}
      {size === 0 ? (
        <p className="muted small">{live ? t("runStory.empty.live") : t("runStory.empty.done")}</p>
      ) : (
        <ol className="story">
          {segments.map((segment, index) => (
            <Segment
              key={segment.thought?.seq ?? `s${index}`}
              segment={segment}
              live={live}
              now={now}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function Segment({ segment, live, now }: { segment: StorySegment; live: boolean; now: number }) {
  const t = useT();
  const thought = segment.thought;
  return (
    <li className="story-segment">
      {thought ? (
        thought.truncated ? (
          <details className="story-thought">
            <summary>
              <span className="story-thought-text">
                {t("runStory.thought", { text: thought.heading })}
              </span>
              <time className="story-time" dateTime={thought.ts}>
                {formatTime(thought.ts)}
              </time>
            </summary>
            <pre className="story-thought-full">{thought.text}</pre>
          </details>
        ) : (
          <p className="story-thought">
            <span className="story-thought-text">
              {t("runStory.thought", { text: thought.heading })}
            </span>
            <time className="story-time" dateTime={thought.ts}>
              {formatTime(thought.ts)}
            </time>
          </p>
        )
      ) : null}
      {segment.steps.length > 0 ? (
        <ol className="story-steps">
          {segment.steps.map((step) => (
            <Step key={step.seq} step={step} live={live} now={now} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function Step({ step, live, now }: { step: StoryStep; live: boolean; now: number }) {
  const t = useT();
  const open = live && step.tool?.open === true;
  const tone = step.tool?.open && !live ? "warn" : step.tone;
  const values = messageValues(step);
  const timing = open
    ? t("runStory.now", { elapsed: formatElapsed(elapsedMs(step.ts, now)) })
    : step.tool?.durationMs !== undefined
      ? formatSpan(step.tool.durationMs)
      : undefined;
  return (
    <li className={`story-step tone-${tone}${open ? " story-open" : ""}`} data-seq={step.seq}>
      <span className="story-mark" aria-hidden="true" />
      <time className="story-time" dateTime={step.ts}>
        {formatTime(step.ts)}
      </time>
      <span className="story-body">
        <span className="story-line">
          <span className="story-verb">{t(step.verb, values)}</span>
          {step.object ? <code className="story-object">{step.object}</code> : null}
        </span>
        {step.text ? <p className="story-text">{step.text}</p> : null}
        {step.screenshot ? <StoryScreenshot payload={step.screenshot} /> : null}
      </span>
      {timing ? <span className="story-meta">{timing}</span> : null}
    </li>
  );
}

/** The verb's values with durations already formatted, so the message stays a plain sentence. */
function messageValues(step: StoryStep): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(step.values ?? {})) {
    if (key === "idleMs" && typeof value === "number") out.idle = formatElapsed(value);
    else out[key] = value;
  }
  return out;
}

function StoryScreenshot({ payload }: { payload: Record<string, unknown> }) {
  const t = useT();
  const { src } = screenshotSource(payload);
  if (!src) return null;
  const caption = typeof payload.caption === "string" ? payload.caption : undefined;
  return (
    <details className="story-shot">
      <summary>{t("runStory.screenshot")}</summary>
      <figure className="screenshot">
        <img src={src} alt={caption ?? t("runEventRow.screenshot.alt")} />
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>
    </details>
  );
}
