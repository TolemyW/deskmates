// Pure oracle for the M2 shared-browser smoke. Keep the answer format independent from the
// runtime checks so one model-format miss does not hide tab, tool, screenshot or session facts.

export interface BrowserSmokeTask {
  label: string;
  expectedReply: string;
}

export interface BrowserSmokeRun {
  status: string;
  summary?: { reply: string };
}

export interface BrowserSmokeEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export interface BrowserSmokeCheck {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface BrowserSmokeOracle {
  passed: boolean;
  checks: BrowserSmokeCheck[];
  failures: BrowserSmokeCheck[];
  tabIds: unknown[];
}

function check(
  name: string,
  expected: unknown,
  actual: unknown,
  passed: boolean,
): BrowserSmokeCheck {
  return { name, passed, expected, actual };
}

/** Evaluate every independent fact before returning, including strict reply equality. */
export function browserSmokeOracle(
  tasks: readonly BrowserSmokeTask[],
  runs: readonly BrowserSmokeRun[],
  events: readonly (readonly BrowserSmokeEvent[])[],
  activeSessions: number,
): BrowserSmokeOracle {
  const tabIds = events.map(
    (list) => list.find((event) => event.payload.source === "browser_lock")?.payload.tabId,
  );
  const validTabIds = tabIds.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  const checks: BrowserSmokeCheck[] = [
    check(
      "runs succeeded",
      tasks.map(() => "succeeded"),
      runs.map((run) => run.status),
      runs.length === tasks.length && runs.every((run) => run.status === "succeeded"),
    ),
    check(
      "runs acquired attributed tabs",
      tasks.map(() => "string tab id"),
      tabIds,
      tabIds.length === tasks.length && validTabIds.length === tasks.length,
    ),
    check(
      "runs used distinct tabs",
      tasks.length,
      new Set(validTabIds).size,
      validTabIds.length === tasks.length && new Set(validTabIds).size === tasks.length,
    ),
  ];

  for (const [index, task] of tasks.entries()) {
    const run = runs[index];
    const runEvents = events[index] ?? [];
    const tabId = tabIds[index];
    const toolResults = runEvents.filter((event) => event.kind === "tool_result");
    const screenshotTabIds = runEvents
      .filter((event) => event.kind === "screenshot")
      .map((event) => event.payload.tabId);
    checks.push(
      check(
        `${task.label} exact reply`,
        task.expectedReply,
        run?.summary?.reply,
        run?.summary?.reply === task.expectedReply,
      ),
      check(
        `${task.label} tool results succeeded`,
        "no tool_result with isError=true",
        toolResults.map((event) => event.payload.isError),
        toolResults.length > 0 && toolResults.every((event) => event.payload.isError !== true),
      ),
      check(
        `${task.label} screenshot matched tab`,
        tabId,
        screenshotTabIds,
        typeof tabId === "string" &&
          tabId.trim().length > 0 &&
          screenshotTabIds.length > 0 &&
          screenshotTabIds.every((screenshotTabId) => screenshotTabId === tabId),
      ),
    );
  }

  checks.push(check("shared authenticated session", 1, activeSessions, activeSessions === 1));
  const failures = checks.filter((item) => !item.passed);
  return { passed: failures.length === 0, checks, failures, tabIds };
}

export function formatBrowserSmokeFailures(oracle: BrowserSmokeOracle): string {
  return oracle.failures
    .map(
      (failure) =>
        `${failure.name}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}`,
    )
    .join("\n");
}
