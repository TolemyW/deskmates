// Draws a dashboard spec as Grafana dashboard JSON for one engine. Layout flows each section's
// panels left to right on the 24-column grid under a row header. Panel ids and key order are
// deterministic, so the generated files diff cleanly.

import { DATASOURCE_UID, type Engine } from "./engines.js";
import { type DashboardSpec, type Panel, RUN_VIEW, type Unit } from "./spec.js";

/** The dashboard JSON schema the files are written in; Grafana migrates it forward on load. */
export const SCHEMA_VERSION = 39;

const GRID_COLUMNS = 24;

type Json = Record<string, unknown>;

/** The run view, as a Grafana data link on a column holding a run id. */
const RUN_LINK = {
  title: "Open this run",
  url: `/d/${RUN_VIEW.uid}/${RUN_VIEW.slug}?var-${RUN_VIEW.variable}=\${__value.raw}&\${__url_time_range}`,
};

function fieldConfig(panel: Panel): Json {
  const defaults: Json = { unit: panel.unit ?? "short" };
  if (panel.kind === "timeseries") {
    defaults.custom =
      panel.style === "lines"
        ? { drawStyle: "line", lineWidth: 2, fillOpacity: 10, showPoints: "auto", spanNulls: false }
        : {
            drawStyle: "bars",
            fillOpacity: 80,
            lineWidth: 1,
            stacking: { mode: "normal", group: "A" },
          };
  }
  if (panel.kind === "table") defaults.custom = { align: "auto", filterable: true };
  const overrides: Json[] = [];
  for (const [column, unit] of Object.entries(panel.columnUnits ?? {}) as [string, Unit][])
    overrides.push({
      matcher: { id: "byName", options: column },
      properties: [{ id: "unit", value: unit }],
    });
  for (const column of panel.runLinks ?? [])
    overrides.push({
      matcher: { id: "byName", options: column },
      properties: [{ id: "links", value: [RUN_LINK] }],
    });
  return { defaults, overrides };
}

function options(panel: Panel): Json {
  switch (panel.kind) {
    case "stat":
      return {
        reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        colorMode: "value",
        graphMode: "none",
        justifyMode: "auto",
        textMode: "auto",
      };
    case "timeseries":
      return {
        legend: { displayMode: "list", placement: "bottom", showLegend: true },
        tooltip: { mode: "multi", sort: "desc" },
      };
    case "table":
      return { showHeader: true, cellHeight: "sm" };
  }
}

/** The dashboard as Grafana JSON for `engine`. */
export function grafanaDashboard(spec: DashboardSpec, engine: Engine): Json {
  const datasource = { type: engine.datasourceType, uid: DATASOURCE_UID };
  const panels: Json[] = [];
  let id = 0;
  let y = 0;
  for (const section of spec.sections) {
    id += 1;
    panels.push({
      id,
      type: "row",
      title: section.title,
      collapsed: false,
      gridPos: { h: 1, w: GRID_COLUMNS, x: 0, y },
      panels: [],
    });
    y += 1;
    let x = 0;
    let rowHeight = 0;
    for (const panel of section.panels) {
      if (panel.w < 1 || panel.w > GRID_COLUMNS)
        throw new Error(`${panel.title}: width ${panel.w}`);
      if (x + panel.w > GRID_COLUMNS) {
        y += rowHeight;
        x = 0;
        rowHeight = 0;
      }
      id += 1;
      panels.push({
        id,
        type: panel.kind,
        title: panel.title,
        description: panel.description,
        datasource,
        gridPos: { h: panel.h, w: panel.w, x, y },
        targets: [
          { refId: "A", datasource, ...engine.target(panel.sql(engine.dialect), panel.kind) },
        ],
        fieldConfig: fieldConfig(panel),
        options: options(panel),
      });
      x += panel.w;
      rowHeight = Math.max(rowHeight, panel.h);
    }
    y += rowHeight;
  }
  return {
    uid: spec.uid,
    title: spec.title,
    description: spec.description,
    tags: ["deskmates"],
    editable: false,
    graphTooltip: 1,
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    time: { from: spec.from, to: "now" },
    refresh: "5m",
    timezone: "browser",
    links: [
      {
        title: "Deskmates dashboards",
        type: "dashboards",
        tags: ["deskmates"],
        asDropdown: true,
        includeVars: false,
        keepTime: true,
      },
    ],
    templating: {
      list: spec.variables.map((variable) => ({
        type: "textbox",
        name: variable.name,
        label: variable.label,
        description: variable.description,
        query: variable.default ?? "",
        current: { text: variable.default ?? "", value: variable.default ?? "" },
        hide: 0,
      })),
    },
    annotations: { list: [] },
    panels,
  };
}
