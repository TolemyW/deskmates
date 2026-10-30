// The panel spec (ADR-0046 decision 7): a dashboard is sections of panels, and a panel's query is
// a function of the dialect, so one spec is written per engine by `generate.ts`. What a panel
// shows is decided here; how Grafana draws it is `grafana.ts`.
//
// Rules a query keeps (`spec.test.ts` checks them): it reads the views of `views.ts` only; it is
// plain SQL plus the five macros of `dialect.ts`; it filters by the dashboard's time range with
// `inRange` and refers to a dashboard variable with `variable`, both written as Grafana template
// variables that Grafana substitutes before the engine sees the text; and an ORDER BY on a column
// that can be NULL first filters the NULLs out, since engines sort them at different ends.

import type { Dialect } from "./dialect.js";

export type PanelKind = "stat" | "timeseries" | "table";

/** Grafana unit ids the panels use. */
export type Unit = "short" | "ms" | "percent" | "currencyUSD";

export interface Panel {
  title: string;
  /** One or two sentences: what the panel answers. Shown as the panel's info tooltip. */
  description: string;
  kind: PanelKind;
  /** Width on Grafana's 24-column grid, and height in grid rows. */
  w: number;
  h: number;
  /**
   * The query. A `timeseries` query returns a `time` column (ISO-8601 UTC text), optionally one
   * text column naming the series, and numeric columns.
   */
  sql: (d: Dialect) => string;
  /** The unit of every numeric value. */
  unit?: Unit;
  /** Per column, for a table whose columns differ. */
  columnUnits?: Readonly<Record<string, Unit>>;
  /** Columns holding a run id, linked to the run view of the agent runs dashboard. */
  runLinks?: readonly string[];
  /** `timeseries`: bars stacked per series (counts), or lines (rates, durations). */
  style?: "stacked-bars" | "lines";
}

export interface Section {
  title: string;
  panels: readonly Panel[];
}

/** A dashboard variable: free text (a run id, a display threshold). */
export interface Variable {
  name: string;
  label: string;
  description: string;
  /** The text it starts with; empty when absent. */
  default?: string;
}

export interface DashboardSpec {
  /** Grafana uid, stable across releases: links from the web UI and other dashboards use it. */
  uid: string;
  /** The file name under `observability/grafana/<engine>/dashboards/`, and the URL slug. */
  slug: string;
  title: string;
  description: string;
  /** Default time range, Grafana relative syntax. */
  from: string;
  variables: readonly Variable[];
  sections: readonly Section[];
}

/** The dashboard time range's start and end, as ISO-8601 UTC text Grafana substitutes. */
const FROM = "'${__from:date:iso}'";
const TO = "'${__to:date:iso}'";

/**
 * `column` is inside the dashboard's time range. Timestamps are ISO-8601 UTC text in the obs
 * model, and Grafana's `date:iso` is the same shape, so the comparison is text order in every
 * engine.
 */
export function inRange(column: string): string {
  return `${column} >= ${FROM} AND ${column} < ${TO}`;
}

/** A dashboard variable as a quoted, escaped SQL string literal (Grafana's `sqlstring`). */
export function variable(name: string): string {
  return `\${${name}:sqlstring}`;
}

/** The run view: the agent runs dashboard with its `run` variable set to one run id. */
export const RUN_VIEW = {
  uid: "deskmates-agent-runs",
  slug: "agent-runs",
  variable: "run",
} as const;
