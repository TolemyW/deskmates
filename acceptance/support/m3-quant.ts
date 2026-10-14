// Frozen M3 quant fixture and independent oracle. Only PRICES_CSV and the task specification
// reach the bot; expected positions and return vectors stay in the host test process.
import { createHash } from "node:crypto";
import type { ExecRequest, ExecResult } from "@deskmates/contracts";

export const PRICES_CSV = `date,A,B,C
2026-01-01,100,100,100
2026-01-02,110,100,90
2026-01-03,99,110,99
2026-01-04,108.9,99,108.9
2026-01-05,119.79,108.9,98.01
2026-01-06,107.811,119.79,107.811
`;

// Host-only replay input: different rankings/turnover and a final recovery. Never sent in
// the task prompt. A cached answer or a script that only hashes its input cannot pass.
export const REPLAY_PRICES_CSV = `date,A,B,C
2026-02-01,100,100,100
2026-02-02,90,110,100
2026-02-03,99,99,100
2026-02-04,99,108.9,90
2026-02-05,108.9,108.9,99
2026-02-06,98.01,108.9,108.9
2026-02-07,88.209,108.9,119.79
`;

export const QUANT_TASK = `Implement a one-day momentum long/short backtest using /work/prices.csv.
For each date starting on the third row, rank symbols by the previous day's simple return
(price[t-1]/price[t-2]-1). Returns within 1e-12 tie; break ties alphabetically.
Hold +0.5 in the highest symbol and -0.5 in the lowest; the other weight is zero.
Gross return is sum(weight[s]*(price[t]/price[t-1]-1)). Do not use today's returns to rank.
Turnover is sum(abs(new weight - previous weight)), initially from all-zero weights.
Charge 0.001 times turnover every date, including initial entry. Do not liquidate at the end.
Net return = gross - fee. Start equity at 1; compound net returns.
Write /work/backtest.json with sourceSha256 (SHA256 of the exact CSV bytes),
daily:[{date,weights:{A,B,C},gross,turnover,net,equity}], totalReturn and maxDrawdown
(positive largest fractional fall from an equity peak, including initial equity 1).
Write runnable /work/backtest.mjs, using built-in Node APIs only, and execute it.
Report the total return and maximum drawdown from the actual output. This is a frozen synthetic
factor-reproduction test, not an investment decision. Do not request downloads or packages.`;

const EXPECTED = [
  { date: "2026-01-03", weights: { A: 0.5, B: 0, C: -0.5 }, gross: -0.1, turnover: 1, net: -0.101 },
  { date: "2026-01-04", weights: { A: -0.5, B: 0.5, C: 0 }, gross: -0.1, turnover: 2, net: -0.102 },
  { date: "2026-01-05", weights: { A: 0.5, B: -0.5, C: 0 }, gross: 0, turnover: 2, net: -0.002 },
  { date: "2026-01-06", weights: { A: 0.5, B: 0, C: -0.5 }, gross: -0.1, turnover: 1, net: -0.101 },
] as const;

const REPLAY_EXPECTED = [
  { date: "2026-02-03", weights: { A: -0.5, B: 0.5, C: 0 }, gross: -0.1, turnover: 1, net: -0.101 },
  {
    date: "2026-02-04",
    weights: { A: 0.5, B: -0.5, C: 0 },
    gross: -0.05,
    turnover: 2,
    net: -0.052,
  },
  {
    date: "2026-02-05",
    weights: { A: 0, B: 0.5, C: -0.5 },
    gross: -0.05,
    turnover: 2,
    net: -0.052,
  },
  {
    date: "2026-02-06",
    weights: { A: 0.5, B: -0.5, C: 0 },
    gross: -0.05,
    turnover: 2,
    net: -0.052,
  },
  { date: "2026-02-07", weights: { A: -0.5, B: 0, C: 0.5 }, gross: 0.1, turnover: 2, net: 0.098 },
] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected object");
  return value as Record<string, unknown>;
}

function near(value: unknown, expected: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value - expected) > 1e-9)
    throw Error(`${label} differs from the frozen oracle`);
}

export function verifyQuantArtifact(
  value: unknown,
  fixture: "original" | "replay" = "original",
): void {
  const prices = fixture === "original" ? PRICES_CSV : REPLAY_PRICES_CSV;
  const expectedRows = fixture === "original" ? EXPECTED : REPLAY_EXPECTED;
  const data = record(value);
  if (data.sourceSha256 !== createHash("sha256").update(prices).digest("hex"))
    throw Error("source hash differs from the frozen fixture");
  if (!Array.isArray(data.daily) || data.daily.length !== expectedRows.length)
    throw Error("daily return coverage differs");
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (let i = 0; i < expectedRows.length; i++) {
    const expected = expectedRows[i];
    if (!expected) throw Error("oracle date missing");
    const row = record(data.daily[i]);
    if (row.date !== expected.date) throw Error("date differs");
    const weights = record(row.weights);
    for (const symbol of ["A", "B", "C"] as const)
      near(weights[symbol], expected.weights[symbol], `${row.date} ${symbol} weight`);
    for (const field of ["gross", "turnover", "net"] as const)
      near(row[field], expected[field], `${row.date} ${field}`);
    equity *= 1 + expected.net;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    near(row.equity, equity, `${row.date} equity`);
  }
  near(data.totalReturn, equity - 1, "total return");
  near(data.maxDrawdown, drawdown, "max drawdown");
}

/** Reproduce the same submitted executable from fresh output on both host-held inputs.
 * The caller retains each execution before assertions, including failures and timeouts.
 * No model retry occurs and the submitted program must remain byte-identical.
 */
export async function replayQuantArtifact(
  exec: (request: ExecRequest) => Promise<ExecResult>,
  read: (path: string) => Promise<string>,
  source: string,
  retain: (fixture: "original" | "replay", evidence: unknown) => void,
): Promise<void> {
  for (const fixture of ["original", "replay"] as const) {
    const prices = fixture === "original" ? PRICES_CSV : REPLAY_PRICES_CSV;
    const prepared = await exec({
      cmd: [
        "node",
        "-e",
        "const f=require('node:fs');f.writeFileSync('/work/prices.csv',f.readFileSync(0));f.rmSync('/work/backtest.json',{force:true});",
      ],
      stdin: prices,
      timeoutMs: 10_000,
    });
    retain(fixture, { stage: "prepare", result: prepared });
    if (prepared.exitCode !== 0 || prepared.timedOut)
      throw Error("quant replay preparation failed");
    const result = await exec({ cmd: ["node", "/work/backtest.mjs"], timeoutMs: 30_000 });
    retain(fixture, { stage: "execute", result });
    if (result.exitCode !== 0 || result.timedOut) throw Error("quant replay execution failed");
    const raw = await read("/work/backtest.json");
    retain(fixture, { stage: "raw-artifact", raw });
    const artifact = JSON.parse(raw) as unknown;
    retain(fixture, { stage: "artifact", artifact });
    if ((await read("/work/prices.csv")) !== prices) throw Error("quant replay changed its input");
    if ((await read("/work/backtest.mjs")) !== source)
      throw Error("quant replay changed its executable");
    verifyQuantArtifact(artifact, fixture);
  }
}
