// A `model_retry` ledger event in words (ADR-0033 decision 8): which retry of how many, why, and
// how long the SDK said it would wait. The raw payload stays one disclosure away.

import { useT } from "../../i18n/i18n-provider.js";

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The reason a retry names: the HTTP status, else the error's type or message, else unknown. */
export function retryReason(payload: Record<string, unknown>): string | undefined {
  const status = num(payload.errorStatus);
  const error = payload.error;
  const type =
    typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? ((error as { type?: unknown; message?: unknown }).type ??
          (error as { message?: unknown }).message)
        : undefined;
  const text = typeof type === "string" ? type.slice(0, 80) : undefined;
  if (status !== undefined && text) return `HTTP ${status} · ${text}`;
  if (status !== undefined) return `HTTP ${status}`;
  return text;
}

export function ModelRetryLine({ payload }: { payload: Record<string, unknown> }) {
  const t = useT();
  const attempt = num(payload.attempt);
  const max = num(payload.maxRetries);
  const wait = num(payload.retryDelayMs);
  const reason = retryReason(payload);
  return (
    <div className="model-retry" data-testid="model-retry">
      <span>
        {t("modelRetry.line", {
          attempt: attempt ?? "?",
          max: max ?? "?",
          reason: reason ?? t("modelRetry.unknownReason"),
        })}
      </span>
      {wait !== undefined ? (
        <span className="muted small">
          {" · "}
          {t("modelRetry.wait", { seconds: Math.round(wait / 100) / 10 })}
        </span>
      ) : null}
      <details className="model-retry-raw">
        <summary>{t("modelRetry.raw")}</summary>
        <pre>{JSON.stringify(payload, null, 2)}</pre>
      </details>
    </div>
  );
}
