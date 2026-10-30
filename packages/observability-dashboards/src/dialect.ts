// The dialect layer of ADR-0046 decision 7: the five things a dashboard query needs that SQL
// engines spell differently. A panel query is plain SQL over the obs views (`views.ts`) plus these
// macros; anything else engine-specific in a query is a defect in the spec. The obs model already
// precomputes durations and keeps timestamps as ISO-8601 UTC text (run-observability.md), which is
// what keeps this list at five.
//
// Phase 1 ships the `sqlite` engine only. A `postgres` dialect (phase 2) implements the same
// interface; `dialect.test.ts` runs its table against every entry of `DIALECTS`.

/** The query's current time, as the `later` or `earlier` side of `timeDiffMs`. */
export const NOW = { now: true } as const;

export type Instant = string | typeof NOW;

export interface MedianSpec {
  /** A SELECT whose output has the `value` column and every `by` column. */
  from: string;
  /** The column whose median is taken; NULLs are left out. */
  value: string;
  /** Group columns; the relation has one row per group. Empty: one row for the whole input. */
  by?: readonly string[];
}

/**
 * The portable subset of a regular-expression extract: an optional `^`, a literal prefix, one
 * lazy capture `(.*?)` or `(.+?)`, then a literal suffix or `$`. A literal character that is a
 * regular-expression metacharacter is escaped with a backslash. The capture may span newlines.
 */
export interface ExtractPattern {
  anchored: boolean;
  prefix: string;
  /** `(.+?)`: the capture holds at least one character. */
  nonEmpty: boolean;
  /** null: the capture runs to the end of the text (`$`). */
  suffix: string | null;
}

export interface Dialect {
  readonly engine: string;
  /** The start of the hour holding `ts` (ISO-8601 UTC text), as ISO-8601 UTC text. */
  hourBucket(ts: string): string;
  /**
   * A relation (use it in FROM or JOIN, parenthesized) with the `by` columns and `median`, one
   * row per group. The relation is self-contained: its aliases start with `median_`.
   */
  median(spec: MedianSpec): string;
  /** The first capture of `pattern` in `text`, or NULL when it does not match. */
  regexExtract(text: string, pattern: string): string;
  /** Milliseconds from `earlier` to `later`, both ISO-8601 UTC text or `NOW`; REAL. */
  timeDiffMs(later: Instant, earlier: Instant): string;
  /** The scalar at `path` (object keys) inside the JSON text `json`, or NULL. */
  jsonField(json: string, path: readonly string[]): string;
}

/** A SQL string literal. */
export function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`${what} must be a lower-case identifier: ${name}`);
  return name;
}

const META = new Set([..."\\^$.|?*+()[]{}"]);

/** Reads `literal` characters from `pattern` at `start` up to the first unescaped metacharacter. */
function readLiteral(pattern: string, start: number): { text: string; end: number } {
  let text = "";
  let i = start;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined || !META.has(next))
        throw new Error(`regexExtract: only a metacharacter may be escaped in ${pattern}`);
      text += next;
      i += 2;
      continue;
    }
    if (META.has(c)) break;
    text += c;
    i += 1;
  }
  return { text, end: i };
}

/** Parses a pattern of the portable subset, or throws naming what is outside it. */
export function parseExtractPattern(pattern: string): ExtractPattern {
  let i = 0;
  const anchored = pattern.startsWith("^");
  if (anchored) i = 1;
  const prefix = readLiteral(pattern, i);
  i = prefix.end;
  const capture = pattern.slice(i, i + 5);
  if (capture !== "(.*?)" && capture !== "(.+?)")
    throw new Error(`regexExtract: expected (.*?) or (.+?) after the prefix in ${pattern}`);
  i += 5;
  const suffix = readLiteral(pattern, i);
  i = suffix.end;
  const end = pattern.slice(i) === "$";
  if (i < pattern.length && !end)
    throw new Error(
      `regexExtract: only a literal suffix or $ may follow the capture in ${pattern}`,
    );
  if (end && suffix.text !== "")
    throw new Error(`regexExtract: a suffix and $ cannot both end ${pattern}`);
  if (!end && suffix.text === "")
    throw new Error(`regexExtract: a lazy capture needs a suffix or $ after it in ${pattern}`);
  return {
    anchored,
    prefix: prefix.text,
    nonEmpty: capture === "(.+?)",
    suffix: end ? null : suffix.text,
  };
}

/** Mirrors `strftime`'s `now` so a `NOW` side reads like a timestamp column. */
function sqliteInstant(at: Instant): string {
  return typeof at === "string" ? `julianday(${at})` : "julianday('now')";
}

export const sqliteDialect: Dialect = {
  engine: "sqlite",

  hourBucket: (ts) => `strftime('%Y-%m-%dT%H:00:00Z', ${ts})`,

  median({ from, value, by = [] }) {
    identifier(value, "median value");
    const keys = by.map((key) => identifier(key, "median group column"));
    const partition = keys.length ? `PARTITION BY ${keys.join(", ")} ` : "";
    const select = [...keys, value].join(", ");
    const group = keys.length ? ` GROUP BY ${keys.join(", ")}` : "";
    return [
      `SELECT ${[...keys, `avg(${value}) AS median`].join(", ")} FROM (`,
      `SELECT ${select}, row_number() OVER (${partition}ORDER BY ${value}) AS median_rn,`,
      ` count(*) OVER (${partition.trim()}) AS median_n`,
      ` FROM (${from}) median_src WHERE ${value} IS NOT NULL) median_ranked`,
      ` WHERE median_rn IN ((median_n + 1) / 2, (median_n + 2) / 2)${group}`,
    ].join("");
  },

  regexExtract(text, pattern) {
    const p = parseExtractPattern(pattern);
    const prefix = literal(p.prefix);
    const length = [...p.prefix].length;
    // Where the text after the prefix starts, and whether the prefix is there at all.
    const found =
      p.prefix === ""
        ? "1"
        : p.anchored
          ? `substr(${text}, 1, ${length}) = ${prefix}`
          : `instr(${text}, ${prefix}) > 0`;
    const rest =
      p.prefix === ""
        ? text
        : p.anchored
          ? `substr(${text}, ${length + 1})`
          : `substr(${text}, instr(${text}, ${prefix}) + ${length})`;
    if (p.suffix === null)
      return p.nonEmpty
        ? `(CASE WHEN ${found} AND length(${rest}) > 0 THEN ${rest} END)`
        : `(CASE WHEN ${found} THEN ${rest} END)`;
    const suffix = literal(p.suffix);
    // The first suffix after the capture's shortest allowed length: 0 characters, or 1.
    return p.nonEmpty
      ? `(CASE WHEN ${found} AND instr(substr(${rest}, 2), ${suffix}) > 0 THEN substr(${rest}, 1, instr(substr(${rest}, 2), ${suffix})) END)`
      : `(CASE WHEN ${found} AND instr(${rest}, ${suffix}) > 0 THEN substr(${rest}, 1, instr(${rest}, ${suffix}) - 1) END)`;
  },

  timeDiffMs: (later, earlier) =>
    `((${sqliteInstant(later)} - ${sqliteInstant(earlier)}) * 86400000.0)`,

  jsonField(json, path) {
    if (path.length === 0) throw new Error("jsonField needs at least one key");
    for (const key of path) identifier(key, "jsonField key");
    return `json_extract(${json}, ${literal(`$.${path.join(".")}`)})`;
  },
};

/** Every dialect the generator writes, by engine id. */
export const DIALECTS: Readonly<Record<string, Dialect>> = { sqlite: sqliteDialect };
