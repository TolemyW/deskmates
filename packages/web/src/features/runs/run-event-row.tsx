// One ledger event in the run replay. Thinking is collapsed by default, tool calls and results
// expand to their JSON, screenshots render inline when the payload carries an image this origin
// can serve (see `screenshotSource`), and everything else is a labelled row. Per-turn usage, model
// switches, compactions, skills and stalls read as one line (issue #9); their JSON stays behind
// the row's details. A call paired with its result is `tool-call-row.tsx`.

import {
  type RunEvent,
  type ToolEvidenceReference,
  isBrowserEvidencePath,
} from "@deskmates/contracts";
import { useState } from "react";
import { formatTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { ModelRetryLine } from "./model-retry.js";
import { formatElapsed } from "./run-activity.js";

export interface RunEventRowProps {
  event: RunEvent;
  evidenceUrl?: ((path: string) => string) | undefined;
}

const IMAGE_KEYS = ["dataUrl", "data_url", "url", "src", "image", "ref", "path", "file"] as const;

/** A screenshot payload is ledger data the agent influenced; only these two shapes reach `src`. */
const DATA_IMAGE_URL = /^data:image\/[a-z0-9.+-]+[;,]/i;
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;
const SAME_ORIGIN_PREFIX = "/api/";

/**
 * Find an image reference in a screenshot payload. Returns a `src` only when loading it cannot
 * reach a third party: a `data:image/*` URL, or an absolute `/api/` path this origin serves.
 *
 * An `https://` reference is deliberately not loadable. The operator UI talks only to the Gateway
 * (packages/web/README.md), and a run's payload is written from tool output the agent produced on
 * a page it visited, so an absolute URL is an attacker-chosen one: rendering it into `<img src>`
 * would fetch it from the operator's browser, which is a tracking pixel with the operator's IP,
 * and would leak the referrer. Such a value is shown as text instead.
 */
export function screenshotSource(payload: Record<string, unknown>): {
  src?: string;
  text?: string;
} {
  const base64 = payload.base64 ?? payload.data;
  if (typeof base64 === "string" && base64.length > 0 && !base64.startsWith("data:")) {
    // An unvalidated `mimeType` is interpolated straight into the URL, so a payload could pick
    // the type the browser parses the bytes as, or inject further URL syntax. Only an image type
    // that cannot carry markup separators gets through; anything else falls back to PNG.
    const declared = payload.mimeType;
    const mime = typeof declared === "string" && IMAGE_MIME.test(declared) ? declared : "image/png";
    return { src: `data:${mime};base64,${base64}` };
  }
  for (const key of IMAGE_KEYS) {
    const v = payload[key];
    if (typeof v !== "string" || v.length === 0) continue;
    if (DATA_IMAGE_URL.test(v) || v.startsWith(SAME_ORIGIN_PREFIX)) return { src: v };
    return { text: v };
  }
  return {};
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A token count in the UI's locale; an unmeasured one is a dash, never 0. */
function tokens(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString(currentI18n().locale) : "—";
}

export function RunEventRow({ event, evidenceUrl }: RunEventRowProps) {
  const p = event.payload;
  return (
    <li className={`event ${event.kind}`}>
      <div className="event-head">
        <span className="seq">#{event.seq}</span>
        <span className={`kind ${event.kind}`}>{event.kind}</span>
        <span className="muted small">{formatTime(event.ts)}</span>
        <span className="event-summary">{summary(event)}</span>
      </div>
      <Body event={event} payload={p} />
      {event.kind === "tool_result" ? <EvidenceLink payload={p} evidenceUrl={evidenceUrl} /> : null}
    </li>
  );
}

function summary(event: RunEvent): string {
  const p = event.payload;
  const { t } = currentI18n();
  switch (event.kind) {
    case "tool_call":
      return [str(p.toolName), str(p.riskLevel)].filter(Boolean).join(" · ");
    case "tool_result":
      return p.isError === true ? t("runEventRow.summary.error") : "";
    case "log":
      if (p.source === "stall" && typeof p.idleMs === "number")
        return p.op === "resumed"
          ? t("runEventRow.summary.stallResumed", { idle: formatElapsed(p.idleMs) })
          : t("runEventRow.summary.stalled", { idle: formatElapsed(p.idleMs) });
      return [str(p.source), str(p.level)].filter(Boolean).join(" · ");
    case "approval":
      return [str(p.phase), str(p.toolName), str(p.decision)].filter(Boolean).join(" · ");
    case "takeover":
      // `taken` / `handed_back` when a human moved the lock; the tool name when a run was parked.
      return [str(p.phase), str(p.toolName)].filter(Boolean).join(" · ");
    case "cap_breached":
      return str(p.cap) ?? str(p.reason) ?? "";
    case "pricing_missing":
      return str(p.model) ? t("runEventRow.summary.noPrice", { model: str(p.model) }) : "";
    case "memory_index":
      return t("runEventRow.summary.memoryIndex", {
        count: typeof p.pinned === "number" ? p.pinned : t("runEventRow.summary.unknownCount"),
      });
    case "memory_skipped":
      return t("runEventRow.summary.notLearned", {
        reason: (str(p.reason) ?? t("runEventRow.summary.reasonUnavailable")).replaceAll("_", " "),
      });
    case "turn_usage":
      return t("runEventRow.summary.turnUsage", {
        turn: tokens(p.turn),
        model: str(p.model) ?? "?",
        input: tokens(p.inputTokens),
        output: tokens(p.outputTokens),
        cacheRead: tokens(p.cacheReadTokens),
        cacheWrite: tokens(p.cacheCreateTokens),
      });
    case "model_switch":
      return t("runEventRow.summary.modelSwitch", {
        from: str(p.from) ?? "?",
        to: str(p.to) ?? "?",
        source: str(p.source) ?? "?",
      });
    case "compact_boundary":
      return typeof p.postTokens === "number"
        ? t("runEventRow.summary.compacted", {
            trigger: str(p.trigger) ?? "?",
            pre: tokens(p.preTokens),
            post: tokens(p.postTokens),
          })
        : t("runEventRow.summary.compactedAt", {
            trigger: str(p.trigger) ?? "?",
            pre: tokens(p.preTokens),
          });
    case "skill_used":
      return t("runEventRow.summary.skillUsed", { skill: str(p.skill) ?? "?" });
    case "rule_file_modified":
      return t("runEventRow.summary.ruleFile", {
        file: str(p.fileName) ?? t("runEventRow.summary.ruleFileDefault"),
        reason: (str(p.reason) ?? t("runEventRow.summary.changeObserved")).replaceAll("_", " "),
      });
    default:
      return "";
  }
}

function Body({ event, payload }: { event: RunEvent; payload: Record<string, unknown> }) {
  const t = useT();
  switch (event.kind) {
    case "thinking":
      return (
        <details className="thinking">
          <summary>{t("runEventRow.thinking", { count: str(payload.text)?.length ?? 0 })}</summary>
          <pre>{str(payload.text) ?? pretty(payload)}</pre>
        </details>
      );
    case "tool_call":
    case "tool_result":
      return (
        <JsonDetails
          payload={payload}
          label={
            event.kind === "tool_call"
              ? t("runEventRow.label.input")
              : t("runEventRow.label.result")
          }
        />
      );
    case "screenshot":
      return <Screenshot payload={payload} />;
    case "model_retry":
      return <ModelRetryLine payload={payload} />;
    case "rule_file_modified":
      return (
        <details>
          <summary>{t("runEventRow.ruleFile.summary")}</summary>
          <pre>{str(payload.diff) ?? t("runEventRow.ruleFile.missing")}</pre>
          <p>
            {payload.restoredOnNextRun === true
              ? t("runEventRow.ruleFile.restored")
              : t("runEventRow.ruleFile.shared")}
          </p>
        </details>
      );
    case "takeover": {
      // The wait message the hook handed back to the tool; a phase-only event has none.
      const text = str(payload.waitMessage);
      return text ? (
        <p className="takeover-text muted">{text}</p>
      ) : (
        <JsonDetails payload={payload} label={t("runEventRow.label.details")} />
      );
    }
    case "log": {
      const text = str(payload.text) ?? str(payload.error);
      return text ? (
        <pre className="log-text">{text}</pre>
      ) : (
        <JsonDetails payload={payload} label={t("runEventRow.label.details")} />
      );
    }
    default:
      return <JsonDetails payload={payload} label={t("runEventRow.label.details")} />;
  }
}

export function JsonDetails({
  payload,
  label,
}: { payload: Record<string, unknown>; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{label}</summary>
      {open ? <pre>{pretty(payload)}</pre> : null}
    </details>
  );
}

function Screenshot({ payload }: { payload: Record<string, unknown> }) {
  const t = useT();
  const { src, text } = screenshotSource(payload);
  if (src) {
    return (
      <figure className="screenshot">
        <img src={src} alt={str(payload.caption) ?? t("runEventRow.screenshot.alt")} />
        {str(payload.caption) ? <figcaption>{str(payload.caption)}</figcaption> : null}
      </figure>
    );
  }
  return (
    <div className="screenshot-ref">
      <span className="muted">{t("runEventRow.screenshot.notLoadable")}</span>
      <code>{text ?? pretty(payload)}</code>
    </div>
  );
}

export function EvidenceLink({
  payload,
  evidenceUrl,
}: { payload: Record<string, unknown>; evidenceUrl?: ((path: string) => string) | undefined }) {
  const t = useT();
  const evidence = payload.evidence;
  if (!evidenceUrl || !evidence || typeof evidence !== "object") return null;
  const path = (evidence as Partial<Record<keyof ToolEvidenceReference, unknown>>).path;
  if (!isBrowserEvidencePath(path)) return null;
  return (
    <a href={evidenceUrl(path)} download rel="noopener">
      {t("workspaceFilePreview.download")}: {path}
    </a>
  );
}
