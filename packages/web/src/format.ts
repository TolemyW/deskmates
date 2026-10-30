// Small display helpers shared by the screens. Dates, numbers and units go through Intl in the
// locale the UI renders in, and words come from the message catalog (issue #23).

import {
  RUN_ERROR_CRON_MISFIRE,
  RUN_ERROR_DEADLINE,
  RUN_ERROR_GATEWAY_RESTARTED,
  RUN_ERROR_NO_REPLY,
  RUN_ERROR_OPERATOR_PAUSE,
  RUN_ERROR_TURN_BUDGET,
} from "@deskmates/contracts";
import { ApiError } from "./api/types.js";
import { currentI18n } from "./i18n/intl.js";

function locale(): string {
  return currentI18n().locale;
}

/** A count with a narrow unit: "5m", "2h", "3d" in English. */
function narrowUnit(value: number, unit: "minute" | "hour" | "day"): string {
  return new Intl.NumberFormat(locale(), { style: "unit", unit, unitDisplay: "narrow" }).format(
    value,
  );
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale());
}

/** `null` means the Gateway had no price for the model (README: `cost_usd` NULL). */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return currentI18n().t("format.cost.unpriced");
  return costUsd.toLocaleString(locale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
    useGrouping: false,
  });
}

export function formatDuration(start: string | undefined, end: string | undefined): string {
  if (!start) return "-";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e)) return "-";
  const ms = Math.max(0, e - s);
  const { t } = currentI18n();
  if (ms < 1000) return t("format.duration.milliseconds", { milliseconds: ms });
  const sec = ms / 1000;
  if (sec < 60)
    return t("format.duration.seconds", {
      seconds: sec.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });
  const min = Math.floor(sec / 60);
  return t("format.duration.minutesSeconds", {
    minutes: min,
    seconds: Math.round(sec - min * 60),
  });
}

/** Split a comma- or newline-separated list into trimmed non-empty entries. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && (err.code === "network" || err.status === 0))
    return currentI18n().t("app.gateway.unreachable");
  return err instanceof Error ? err.message : String(err);
}

/**
 * A run's `error` as the run view shows it. Reasons the server records itself get an actionable
 * sentence; internal codes belong in technical details, not in the user-facing notice.
 */
export function describeRunError(error: string): string {
  const { t } = currentI18n();
  if (error === RUN_ERROR_NO_REPLY) return t("format.runError.noReply");
  if (error === RUN_ERROR_DEADLINE) return t("format.runError.deadline");
  if (error === RUN_ERROR_TURN_BUDGET) return t("format.runError.turnBudget");
  if (error === RUN_ERROR_OPERATOR_PAUSE) return t("format.runError.operatorPause");
  if (error === RUN_ERROR_GATEWAY_RESTARTED) return t("format.runError.gatewayRestarted");
  if (error === RUN_ERROR_CRON_MISFIRE) return t("format.runError.cronMisfire");
  if (/issue with the selected model|it may not exist or you may not have access/i.test(error))
    return t("format.runError.modelUnavailable");
  return error;
}

/** "just now", "5m", "2h", "3d", else a short date; for list rows where space is tight. The
 * units are Intl's narrow units in the active locale. */
export function formatRelative(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return currentI18n().t("format.relative.justNow");
  if (min < 60) return narrowUnit(min, "minute");
  const hours = Math.floor(min / 60);
  if (hours < 24) return narrowUnit(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return narrowUnit(days, "day");
  return new Date(iso).toLocaleDateString(locale(), { month: "short", day: "numeric" });
}

/** A day label for transcript dividers: Today, Yesterday, or the date. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const { t } = currentI18n();
  if (sameDay(d, now)) return t("format.day.today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return t("format.day.yesterday");
  return d.toLocaleDateString(locale(), { weekday: "short", month: "short", day: "numeric" });
}
