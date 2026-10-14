// ADR-0004/0005 empirical calibration, deliberately separate from tool-quality diagnostics.
export interface CheckResult {
  name: string;
  passed: boolean;
}
export interface TicketArm {
  indices: number[];
  checks?: CheckResult[];
  runs?: { status: string }[];
  waitErrors?: string[];
}
export interface TicketPair {
  id: string;
  /** Outer candidate-series repetition. Required for aggregate K>=5 calibration. */
  repetition?: number;
  arms: TicketArm[];
}

const TICKET_SCENARIOS = ["X02", "X03"] as const;

/** ADR-0005: silent is completed with no final reply; failures/cancellations are not success. */
export function completedTicketStatus(status: string): boolean {
  return status === "succeeded" || status === "silent";
}

/** Re-score original traces without mutating their checks or erasing the old harness verdict. */
export function rescoreRecordedTicketPair(pair: TicketPair): TicketPair {
  return {
    ...pair,
    arms: pair.arms.map((arm) => {
      const known = Array.isArray(arm.runs) && Array.isArray(arm.waitErrors);
      const runtime =
        known &&
        arm.runs?.length === arm.indices.length &&
        arm.waitErrors?.length === 0 &&
        arm.runs.every((run) => completedTicketStatus(run.status));
      return {
        ...arm,
        checks:
          arm.checks?.flatMap((check) =>
            check.name !== "runtime"
              ? [check]
              : known
                ? [{ name: "runtime", passed: runtime === true }]
                : [],
          ) ?? [],
      };
    }),
  };
}

export function ticketOracle(arm: TicketArm): boolean | undefined {
  const required = [
    "runtime",
    "requested writes",
    "unchanged unrelated state",
    "distinct stable targets",
    ...arm.indices.flatMap((_, index) => [
      `run ${index}: screenshot attribution`,
      `run ${index}: no own-tab lock wait`,
    ]),
    ...(arm.indices.length === 2 ? ["runs overlap"] : []),
  ];
  if (!arm.checks || required.some((name) => !arm.checks?.some((check) => check.name === name)))
    return undefined;
  return required.every((name) => arm.checks?.find((check) => check.name === name)?.passed);
}

/** Two solo controls must pass; an incomplete concurrent arm is unknown, never a success. */
export function classifyInterference(
  pair: TicketPair,
): "clean" | "interference" | "unclassifiable" {
  const soloA = pair.arms.find((arm) => arm.indices.join(",") === "0");
  const soloB = pair.arms.find((arm) => arm.indices.join(",") === "1");
  const concurrent = pair.arms.find((arm) => arm.indices.join(",") === "0,1");
  if (
    !soloA ||
    !soloB ||
    !concurrent ||
    ticketOracle(soloA) !== true ||
    ticketOracle(soloB) !== true
  )
    return "unclassifiable";
  const result = ticketOracle(concurrent);
  return result === undefined ? "unclassifiable" : result ? "clean" : "interference";
}

/** Wilson 95% interval: a zero observed rate in ten pairs is not a population <=5% claim. */
export function rateInterval(hits: number, samples: number): [number, number] | undefined {
  if (
    !Number.isInteger(hits) ||
    !Number.isInteger(samples) ||
    hits < 0 ||
    hits > samples ||
    samples < 1
  )
    return undefined;
  const z = 1.959963984540054;
  const p = hits / samples;
  const divisor = 1 + (z * z) / samples;
  const centre = (p + (z * z) / (2 * samples)) / divisor;
  const half =
    (z * Math.sqrt((p * (1 - p)) / samples + (z * z) / (4 * samples * samples))) / divisor;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function interferenceCalibration(pairs: TicketPair[]) {
  const byRepetition = new Map<number, Map<string, TicketPair[]>>();
  for (const pair of pairs) {
    if (
      !TICKET_SCENARIOS.includes(pair.id as (typeof TICKET_SCENARIOS)[number]) ||
      !Number.isInteger(pair.repetition) ||
      (pair.repetition ?? 0) < 1
    )
      continue;
    const scenarios = byRepetition.get(pair.repetition ?? 0) ?? new Map<string, TicketPair[]>();
    const samples = scenarios.get(pair.id) ?? [];
    samples.push(pair);
    scenarios.set(pair.id, samples);
    byRepetition.set(pair.repetition ?? 0, scenarios);
  }
  // A repetition is one paired observation only when both scenarios occur exactly once.
  // Excluding the whole malformed repetition prevents copied evidence from filling K=5.
  const completeRepetitions = [...byRepetition.entries()]
    .filter(([, scenarios]) => TICKET_SCENARIOS.every((id) => scenarios.get(id)?.length === 1))
    .sort(([left], [right]) => left - right);
  const calibratedPairs = completeRepetitions.flatMap(([, scenarios]) =>
    TICKET_SCENARIOS.map((id) => scenarios.get(id)?.[0]).filter(
      (pair): pair is TicketPair => pair !== undefined,
    ),
  );
  const counts = { clean: 0, interference: 0, unclassifiable: 0 };
  for (const pair of calibratedPairs) counts[classifyInterference(pair)] += 1;
  const completeK5 = completeRepetitions.length >= 5 && counts.unclassifiable === 0;
  const classified = counts.clean + counts.interference;
  const rate = classified ? counts.interference / classified : undefined;
  return {
    ...counts,
    repetitions: completeRepetitions.length,
    scenarioSamples: Object.fromEntries(
      TICKET_SCENARIOS.map((id) => [id, calibratedPairs.filter((pair) => pair.id === id).length]),
    ),
    excluded: pairs.length - calibratedPairs.length,
    classified,
    rate,
    confidence95: rateInterval(counts.interference, classified),
    verdict: !completeK5
      ? "incomplete"
      : (rate ?? 1) > 0.05
        ? "new-lock-ADR-required"
        : "retain-lock-v1",
    note: "Empirical ADR rule only; Wilson interval assumes independent pairs and does not prove a population bound.",
  };
}

export function turnBudgetCalibration(
  exchanges: { successful: boolean; botMessages: number; paused: boolean }[],
) {
  const successes = exchanges.filter((item) => item.successful);
  const eligible = successes
    .filter((item) => !item.paused)
    .map((item) => item.botMessages)
    .sort((a, b) => a - b);
  // Reaching the budget pauses, so the smallest safe budget is strictly greater than this quantile.
  const rank = Math.ceil(successes.length * 0.95) - 1;
  return {
    attempted: exchanges.length,
    successful: successes.length,
    paused: exchanges.filter((item) => item.paused).length,
    observedMinimumBudget:
      rank >= 0 && rank < eligible.length ? (eligible[rank] ?? 0) + 1 : undefined,
    note: "Empirical 95% quantile among successful exchanges; no default change or population reliability claim.",
  };
}
