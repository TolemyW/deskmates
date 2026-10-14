// Five-field cron (`min hour dom month dow`), parsed and matched in a given IANA time zone.
// Pure and dependency-free, like everything else in contracts: the Gateway's cron runner asks
// `cronMatches` once a minute, and the operator UI can show `nextCronFire`.
//
// Supported: `*`, lists (`1,2`), ranges (`1-5`), steps (`*/5`, `1-10/2`). Month and weekday names
// are not supported — numbers only, with day-of-week 0 and 7 both meaning Sunday. A restricted
// day-of-month and a restricted day-of-week match as an OR, as in Vixie cron.

import { DeskmatesError } from "./errors.js";

export interface ParsedCron {
  /** The expression as given, for error messages and for the ledger. */
  expression: string;
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  /** 1-12. */
  month: ReadonlySet<number>;
  /** 0-6, Sunday 0. */
  dayOfWeek: ReadonlySet<number>;
  /** True when the field was not `*`; with day-of-week it decides the OR. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/** How far `nextCronFire` looks ahead before giving up on an expression like Feb 30. */
export const CRON_SEARCH_MAX_MINUTES = 366 * 24 * 60;

const MINUTE_MS = 60_000;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is accepted and folded onto 0 (Sunday).
  { name: "day-of-week", min: 0, max: 7 },
];

function fail(expression: string, message: string): never {
  throw new DeskmatesError("validation", `bad cron expression "${expression}": ${message}`, {
    expression,
  });
}

function parseInteger(expression: string, spec: FieldSpec, raw: string): number {
  if (!/^\d+$/.test(raw)) fail(expression, `${spec.name} value "${raw}" is not a number`);
  const n = Number.parseInt(raw, 10);
  if (n < spec.min || n > spec.max) {
    fail(expression, `${spec.name} value ${n} is outside ${spec.min}-${spec.max}`);
  }
  return n;
}

function parseField(expression: string, spec: FieldSpec, field: string): number[] {
  const values: number[] = [];
  for (const term of field.split(",")) {
    if (term === "") fail(expression, `${spec.name} has an empty list item`);
    const [rangePart, stepPart, ...rest] = term.split("/");
    if (rest.length > 0) fail(expression, `${spec.name} term "${term}" has more than one step`);
    let step = 1;
    if (stepPart !== undefined) {
      step = parseInteger(
        expression,
        { name: `${spec.name} step`, min: 1, max: spec.max },
        stepPart,
      );
    }
    let from: number;
    let to: number;
    if (rangePart === "*") {
      from = spec.min;
      to = spec.max;
    } else {
      const bounds = (rangePart ?? "").split("-");
      if (bounds.length === 1) {
        from = parseInteger(expression, spec, bounds[0] as string);
        // `5/2` means "from 5 to the end, every 2"; a bare `5` is just 5.
        to = stepPart === undefined ? from : spec.max;
      } else if (bounds.length === 2) {
        from = parseInteger(expression, spec, bounds[0] as string);
        to = parseInteger(expression, spec, bounds[1] as string);
        if (from > to) fail(expression, `${spec.name} range ${from}-${to} runs backwards`);
      } else {
        fail(expression, `${spec.name} term "${term}" is not a range`);
      }
    }
    for (let v = from; v <= to; v += step) values.push(v);
  }
  return values;
}

/** Parses a five-field expression; throws a `validation` DeskmatesError on anything else. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression
    .trim()
    .split(/\s+/)
    .filter((f) => f !== "");
  if (fields.length !== FIELDS.length) {
    fail(expression, `expected ${FIELDS.length} fields, got ${fields.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELDS.map((spec, i) =>
    parseField(expression, spec, fields[i] as string),
  ) as [number[], number[], number[], number[], number[]];
  return {
    expression,
    minute: sortedSet(minute),
    hour: sortedSet(hour),
    dayOfMonth: sortedSet(dayOfMonth),
    month: sortedSet(month),
    // 7 is Sunday, like 0, so both spellings land on the same value.
    dayOfWeek: sortedSet(dayOfWeek.map((d) => (d === 7 ? 0 : d))),
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  };
}

function sortedSet(values: readonly number[]): ReadonlySet<number> {
  return new Set([...new Set(values)].sort((a, b) => a - b));
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0-6, Sunday 0. */
  dayOfWeek: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  const cached = formatters.get(key);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  } catch {
    throw new DeskmatesError("validation", `unknown time zone "${timeZone}"`, { timeZone });
  }
  formatters.set(key, formatter);
  return formatter;
}

/** Wall-clock fields of `date` in `timeZone` (the process zone when undefined). */
export function zonedParts(date: Date, timeZone?: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number.parseInt(get("year"), 10),
    month: Number.parseInt(get("month"), 10),
    day: Number.parseInt(get("day"), 10),
    hour: Number.parseInt(get("hour"), 10),
    minute: Number.parseInt(get("minute"), 10),
    dayOfWeek: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** True when `date` falls in a minute the expression fires in. Seconds are ignored. */
export function cronMatches(cron: ParsedCron | string, date: Date, timeZone?: string): boolean {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const at = zonedParts(date, timeZone);
  if (!parsed.minute.has(at.minute)) return false;
  if (!parsed.hour.has(at.hour)) return false;
  if (!parsed.month.has(at.month)) return false;
  const domHit = parsed.dayOfMonth.has(at.day);
  const dowHit = parsed.dayOfWeek.has(at.dayOfWeek);
  // Vixie cron: with both day fields restricted the match is an OR, not an AND.
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return domHit || dowHit;
  if (parsed.dayOfMonthRestricted) return domHit;
  if (parsed.dayOfWeekRestricted) return dowHit;
  return true;
}

/**
 * The first whole minute strictly after `after` that the expression fires in, or undefined when
 * there is none within `CRON_SEARCH_MAX_MINUTES` (an expression like `0 0 30 2 *` has none).
 */
export function nextCronFire(
  cron: ParsedCron | string,
  after: Date,
  timeZone?: string,
): Date | undefined {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  let ms = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < CRON_SEARCH_MAX_MINUTES; i += 1) {
    const candidate = new Date(ms);
    if (cronMatches(parsed, candidate, timeZone)) return candidate;
    ms += MINUTE_MS;
  }
  return undefined;
}
