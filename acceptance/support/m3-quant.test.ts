import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PRICES_CSV,
  REPLAY_PRICES_CSV,
  replayQuantArtifact,
  verifyQuantArtifact,
} from "./m3-quant.js";

// A hand-worked reference, independent of a submitted implementation. Initial entry costs
// 10 bp; the two rotations cost 20 bp each and the last partial rotation costs 10 bp.
function reference() {
  const net = [-0.101, -0.102, -0.002, -0.101];
  let equity = 1;
  const weights = [
    { A: 0.5, B: 0, C: -0.5 },
    { A: -0.5, B: 0.5, C: 0 },
    { A: 0.5, B: -0.5, C: 0 },
    { A: 0.5, B: 0, C: -0.5 },
  ];
  const daily = net.map((value, i) => {
    equity *= 1 + value;
    return {
      date: `2026-01-0${i + 3}`,
      weights: weights[i],
      gross: [-0.1, -0.1, 0, -0.1][i],
      turnover: [1, 2, 2, 1][i],
      net: value,
      equity,
    };
  });
  return {
    sourceSha256: createHash("sha256").update(PRICES_CSV).digest("hex"),
    daily,
    totalReturn: equity - 1,
    maxDrawdown: 1 - equity,
  };
}

describe("M3 frozen quant oracle", () => {
  it("accepts the hand-worked lagged positions and compounded net returns", () => {
    expect(() => verifyQuantArtifact(reference())).not.toThrow();
  });
  it.each(["gross", "net", "turnover", "equity"] as const)(
    "rejects a wrong %s even when the aggregate report is correct",
    (field) => {
      const artifact = reference();
      const row = artifact.daily[0];
      if (!row) throw Error("missing row");
      row[field] = 0;
      expect(() => verifyQuantArtifact(artifact)).toThrow(/differs/);
    },
  );
  it("rejects lookahead positions and altered source bytes", () => {
    const artifact = reference();
    const row = artifact.daily[0];
    if (!row) throw Error("missing row");
    row.weights = { A: -0.5, B: 0.5, C: 0 };
    expect(() => verifyQuantArtifact(artifact)).toThrow(/weight/);
    const altered = reference();
    altered.sourceSha256 = createHash("sha256").update(`${PRICES_CSV}\n`).digest("hex");
    expect(() => verifyQuantArtifact(altered)).toThrow(/source hash/);
  });
});

// Independent hand calculation of the withheld input. Its last day recovers, so final
// loss is smaller than maximum drawdown. This also catches a final-equity-only oracle.
function replayReference() {
  const net = [-0.101, -0.052, -0.052, -0.052, 0.098];
  let equity = 1;
  let maxDrawdown = 0;
  const weights = [
    { A: -0.5, B: 0.5, C: 0 },
    { A: 0.5, B: -0.5, C: 0 },
    { A: 0, B: 0.5, C: -0.5 },
    { A: 0.5, B: -0.5, C: 0 },
    { A: -0.5, B: 0, C: 0.5 },
  ];
  const daily = net.map((value, i) => {
    equity *= 1 + value;
    maxDrawdown = Math.max(maxDrawdown, 1 - equity);
    return {
      date: `2026-02-0${i + 3}`,
      weights: weights[i],
      gross: [-0.1, -0.05, -0.05, -0.05, 0.1][i],
      turnover: [1, 2, 2, 2, 2][i],
      net: value,
      equity,
    };
  });
  return {
    sourceSha256: createHash("sha256").update(REPLAY_PRICES_CSV).digest("hex"),
    daily,
    totalReturn: equity - 1,
    maxDrawdown,
  };
}

function harness(submit: (files: Map<string, string>) => void, failure?: "prepare" | "timeout") {
  const source = "submitted executable";
  // The stale artifact is deliberately correct; it must be removed before each replay.
  const files = new Map([
    ["/work/backtest.mjs", source],
    ["/work/backtest.json", JSON.stringify(reference())],
  ]);
  const receipts: unknown[] = [];
  let executions = 0;
  const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  return {
    run: () =>
      replayQuantArtifact(
        async (request) => {
          if (request.cmd[1] === "-e") {
            if (failure === "prepare") return { ...result, exitCode: 1 };
            expect(request.cmd[2]).toContain("f.rmSync('/work/backtest.json',{force:true})");
            files.set("/work/prices.csv", request.stdin ?? "");
            files.delete("/work/backtest.json");
          } else {
            executions++;
            submit(files);
            if (failure === "timeout") return { ...result, timedOut: true };
          }
          return result;
        },
        async (path) => {
          const value = files.get(path);
          if (value === undefined) throw Error(`missing artifact ${path}`);
          return value;
        },
        source,
        (fixture, evidence) => receipts.push({ fixture, evidence }),
      ),
    receipts,
    executions: () => executions,
  };
}

const regenerate = (files: Map<string, string>) =>
  files.set(
    "/work/backtest.json",
    JSON.stringify(files.get("/work/prices.csv") === PRICES_CSV ? reference() : replayReference()),
  );

describe("M3 independent quant executable replay", () => {
  it("accepts both newly generated outputs and retains each stage", async () => {
    const trial = harness(regenerate);
    await trial.run();
    expect(trial.executions()).toBe(2);
    expect(trial.receipts).toHaveLength(8);
  });
  it("rejects a no-op executable even with an existing correct artifact", async () => {
    const trial = harness(() => {});
    await expect(trial.run()).rejects.toThrow(/missing artifact/);
    expect(trial.executions()).toBe(1);
  });
  it("rejects a cached answer on changed input", async () => {
    await expect(
      harness((files) => files.set("/work/backtest.json", JSON.stringify(reference()))).run(),
    ).rejects.toThrow(/source hash/);
  });
  it("rejects changed-input hash with unchanged numerical answers", () => {
    const cached = reference();
    cached.sourceSha256 = replayReference().sourceSha256;
    expect(() => verifyQuantArtifact(cached, "replay")).toThrow(/coverage/);
  });
  it("checks maximum drawdown before the recovery, not only final equity", () => {
    const artifact = replayReference();
    expect(() => verifyQuantArtifact(artifact, "replay")).not.toThrow();
    artifact.maxDrawdown = -artifact.totalReturn;
    expect(() => verifyQuantArtifact(artifact, "replay")).toThrow(/drawdown/);
  });
  it.each(["/work/prices.csv", "/work/backtest.mjs"])(
    "rejects self-mutation of %s",
    async (path) => {
      await expect(
        harness((files) => {
          regenerate(files);
          files.set(path, "altered");
        }).run(),
      ).rejects.toThrow(/changed/);
    },
  );
  it("stops before execution if stale output cannot be removed", async () => {
    const trial = harness(regenerate, "prepare");
    await expect(trial.run()).rejects.toThrow(/preparation/);
    expect(trial.executions()).toBe(0);
  });
  it("retains and rejects a timeout even if an output was written", async () => {
    const trial = harness(regenerate, "timeout");
    await expect(trial.run()).rejects.toThrow(/execution/);
    expect(trial.receipts).toHaveLength(2);
  });
});
