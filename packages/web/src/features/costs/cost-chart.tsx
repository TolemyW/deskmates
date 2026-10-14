// The daily chart of the Costs page: one unit per chart (ADR-0032 decision 9). Money stacks
// known and estimated USD; usage stacks the four token categories. Days come from the report's
// server totals for the whole range, never from a page of rows.

import type { CostDay } from "@deskmates/contracts";
import { useT } from "../../i18n/i18n-provider.js";
import { compactTokens, shortDollars } from "./cost-format.js";

export type CostView = "money" | "usage";

interface Part {
  key: string;
  label: string;
  value: number;
  hue: number;
  estimate?: boolean;
}

function partsOf(day: CostDay, view: CostView, labels: Record<string, string>): Part[] {
  if (view === "money")
    return [
      { key: "known", label: labels.known ?? "", value: day.knownCostUsd ?? 0, hue: 1 },
      {
        key: "estimated",
        label: labels.estimated ?? "",
        value: day.estimatedCostUsd ?? 0,
        hue: 2,
        estimate: true,
      },
    ];
  return [
    { key: "input", label: labels.input ?? "", value: day.inputTokens, hue: 1 },
    { key: "output", label: labels.output ?? "", value: day.outputTokens, hue: 2 },
    { key: "cacheRead", label: labels.cacheRead ?? "", value: day.cacheReadTokens, hue: 3 },
    { key: "cacheCreate", label: labels.cacheCreate ?? "", value: day.cacheCreateTokens, hue: 4 },
  ];
}

export function CostChart({ days, view }: { days: readonly CostDay[]; view: CostView }) {
  const t = useT();
  const labels: Record<string, string> = {
    known: t("costs.money.known"),
    estimated: t("costs.money.estimated"),
    input: t("costs.activity.input"),
    output: t("costs.activity.output"),
    cacheRead: t("costs.activity.cacheRead"),
    cacheCreate: t("costs.activity.cacheCreate"),
  };
  const bars = days.map((day) => {
    const parts = partsOf(day, view, labels);
    return { day: day.day, parts, total: parts.reduce((sum, p) => sum + p.value, 0) };
  });
  const width = 720;
  const height = 180;
  const pad = { top: 10, right: 8, bottom: 26, left: 8 };
  const max = Math.max(...bars.map((b) => b.total), 0);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const slot = innerW / Math.max(bars.length, 1);
  const barW = Math.min(36, slot * 0.6);
  const format = (v: number) => (view === "money" ? shortDollars(v) : compactTokens(v));
  const labelEvery = Math.max(1, Math.ceil(bars.length / 10));
  const legend = bars[0]?.parts ?? partsOf({ day: "" } as CostDay, view, labels);
  const title = view === "money" ? t("costs.chart.spendTitle") : t("costs.chart.tokensTitle");
  return (
    <figure className="cost-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={view === "money" ? t("costs.chart.spendAria") : t("costs.chart.tokensAria")}
      >
        <title>{title}</title>
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + innerH}
          y2={pad.top + innerH}
          className="cost-chart-axis"
        />
        {bars.map((bar, i) => {
          const x = pad.left + slot * i + (slot - barW) / 2;
          let y = pad.top + innerH;
          return (
            <g key={bar.day}>
              <title>{`${bar.day}: ${format(bar.total)}`}</title>
              {bar.parts.map((part) => {
                const h = max > 0 ? (part.value / max) * innerH : 0;
                y -= h;
                return (
                  <rect
                    key={part.key}
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                    rx={2}
                    className={`cost-chart-bar${part.estimate ? " cost-chart-estimate" : ""}`}
                    data-hue={part.hue}
                  />
                );
              })}
              {bar.total > 0 ? (
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" className="cost-chart-value">
                  {format(bar.total)}
                </text>
              ) : null}
              {i % labelEvery === 0 ? (
                <text
                  x={x + barW / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="cost-chart-label"
                >
                  {bar.day.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="cost-legend">
        {legend.map((part) => (
          <span key={part.key}>
            <i
              className={`cost-swatch${part.estimate ? " cost-chart-estimate" : ""}`}
              data-hue={part.hue}
            />{" "}
            {part.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
