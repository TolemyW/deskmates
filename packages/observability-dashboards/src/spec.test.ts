// T0 (ADR-0046 decisions 1 and 7): every panel query reads the obs views and nothing else. Each
// query, after Grafana's variables are substituted, is compiled in a SQLite database that holds
// the views' columns as tables and no base table, so a query naming `run_events` or `runs` does
// not compile. It is also run against the sqlite sink's real schema, read from
// packages/gateway/observability/sqlite.sql as a file (this package imports no other package).
// The test also checks what Grafana needs from each query's shape: a stat answers one column, a
// time series starts with `time`, and the columns a panel styles or links are ones it returns.

import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { DASHBOARDS } from "./dashboards/index.js";
import { ENGINES, sqliteEngine } from "./engines.js";
import { type DashboardSpec, RUN_VIEW } from "./spec.js";
import { OBS_VIEWS } from "./views.js";

const SCHEMA = readFileSync(
  new URL("../../gateway/observability/sqlite.sql", import.meta.url),
  "utf8",
);

const real = new Database(":memory:");
real.exec(SCHEMA);
const viewsOnly = new Database(":memory:");
for (const view of OBS_VIEWS) {
  const columns = real.prepare(`PRAGMA table_info(${view})`).all() as { name: string }[];
  viewsOnly.exec(`CREATE TABLE ${view} (${columns.map((c) => `"${c.name}"`).join(", ")})`);
}
afterAll(() => {
  real.close();
  viewsOnly.close();
});

/** Grafana's global variables a query may use, with a value of the shape Grafana substitutes. */
const GLOBALS: Readonly<Record<string, string>> = {
  "__from:date:iso": "2026-10-16T00:00:00.000Z",
  "__to:date:iso": "2026-10-18T00:00:00.000Z",
};

/** The query as the engine receives it, or a failure naming a variable the dashboard lacks. */
function interpolate(sql: string, spec: DashboardSpec): string {
  const declared = new Set(spec.variables.map((v) => v.name));
  const out = sql.replace(/\$\{([^}]*)\}/g, (_, inner: string) => {
    const global = GLOBALS[inner];
    if (global !== undefined) return global;
    const [name, format] = inner.split(":");
    if (name === undefined || !declared.has(name) || format !== "sqlstring")
      throw new Error(`${spec.uid}: \${${inner}} is not a declared variable as sqlstring`);
    return "'run_1'";
  });
  if (/\$[A-Za-z_{]/.test(out) || out.includes("[["))
    throw new Error(`${spec.uid}: a variable outside the \${name:format} form in ${sql}`);
  return out;
}

const panels = DASHBOARDS.flatMap((spec) =>
  spec.sections.flatMap((section) => section.panels.map((panel) => ({ spec, panel }))),
);

describe("the panel spec", () => {
  it("allows exactly the views the sqlite sink's schema creates", () => {
    const created = [...SCHEMA.matchAll(/^CREATE VIEW (\w+) AS/gm)].map((m) => m[1]);
    expect([...OBS_VIEWS]).toEqual([...created].sort());
  });

  it("has distinct dashboard uids and slugs, and the run view among them", () => {
    expect(new Set(DASHBOARDS.map((d) => d.uid)).size).toBe(DASHBOARDS.length);
    expect(new Set(DASHBOARDS.map((d) => d.slug)).size).toBe(DASHBOARDS.length);
    const slugs = DASHBOARDS.map((d) => d.slug);
    expect(slugs).toEqual([...slugs].sort());
    const runView = DASHBOARDS.find((d) => d.uid === RUN_VIEW.uid);
    expect(runView?.slug).toBe(RUN_VIEW.slug);
    expect(runView?.variables.map((v) => v.name)).toContain(RUN_VIEW.variable);
  });

  for (const engine of ENGINES)
    for (const { spec, panel } of panels)
      it(`${engine.id} ${spec.slug} "${panel.title}" reads views only`, () => {
        const sql = interpolate(panel.sql(engine.dialect), spec);
        if (engine === sqliteEngine) {
          const statement = viewsOnly.prepare(sql);
          const columns = statement.columns().map((c) => c.name);
          if (panel.kind === "stat") expect(columns).toHaveLength(1);
          if (panel.kind === "timeseries") expect(columns[0]).toBe("time");
          for (const column of [...Object.keys(panel.columnUnits ?? {}), ...(panel.runLinks ?? [])])
            expect(columns, column).toContain(column);
          expect(() => real.prepare(sql).all()).not.toThrow();
        }
      });

  it("gives every panel a title, a description and a width that fits the grid", () => {
    for (const { spec, panel } of panels) {
      expect(panel.title.trim(), spec.slug).not.toBe("");
      expect(panel.description.trim(), panel.title).not.toBe("");
      expect(panel.w, panel.title).toBeGreaterThan(0);
      expect(panel.w, panel.title).toBeLessThanOrEqual(24);
      expect(panel.h, panel.title).toBeGreaterThan(0);
    }
  });
});
