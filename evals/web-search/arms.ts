// The arms of the web search comparison (ADR-0049 decision 13, protocol of 2026-10-18): one build,
// one Gateway configuration, two settings of one workspace switch. Both arms configure the same
// search fixture as `SEARCH_URL`, both can search it through the browser, and only `browser-search`
// has the switch on, so its runs freeze `webSearch: on` and are offered the `web_search` tool and
// its prompt line. One knob: the tool. Configuration only; nothing here has been run.

export type WebSearchArm = "browser" | "browser-search";

export interface WebSearchArmConfig {
  arm: WebSearchArm;
  /** The workspace switch of ADR-0049 decision 4 for this arm. */
  switchOn: boolean;
}

export const WEB_SEARCH_ARMS: readonly WebSearchArmConfig[] = [
  { arm: "browser", switchOn: false },
  { arm: "browser-search", switchOn: true },
];

/** The one comparison: the tool against the browser alone. */
export const WEB_SEARCH_COMPARISON = {
  id: "W1",
  knob: "web_search",
  baseline: "browser",
  candidate: "browser-search",
} as const;

/**
 * Variables an arm must not set: they would change the Gateway between arms or reach a real
 * search service. The executor sets `SEARCH_URL` and `SEARCH_AUTH_TOKEN` itself, to the fixture.
 */
export const WEB_SEARCH_FIXED_KEYS = ["SEARCH_URL", "SEARCH_AUTH_TOKEN"] as const;

export function webSearchArm(name: string | undefined): WebSearchArmConfig {
  const found = WEB_SEARCH_ARMS.find((a) => a.arm === name?.trim());
  if (!found)
    throw new Error(
      `EVAL_ARM must be ${WEB_SEARCH_ARMS.map((a) => a.arm).join(" or ")}, got ${name ?? "nothing"}`,
    );
  return found;
}

/**
 * The executor's own search configuration, the same in both arms: the fixture's JSON endpoint and
 * a per-invocation token that marks the Gateway's searches in the fixture's log. Refuses a campaign
 * environment that names another search service, so no arm can search the real web.
 */
export function webSearchArmEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  fixture: { url: string; token: string },
): Record<(typeof WEB_SEARCH_FIXED_KEYS)[number], string> {
  for (const key of WEB_SEARCH_FIXED_KEYS)
    if ((env[key] ?? "").trim() !== "")
      throw new Error(
        `${key} is set; the campaign searches its own fixture, never another service`,
      );
  return { SEARCH_URL: fixture.url, SEARCH_AUTH_TOKEN: fixture.token };
}

/** Arm order per repetition block: a rotation, so no arm always runs first. */
export function webSearchArmOrder(repetitions: number): WebSearchArm[][] {
  if (!Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("repetitions must be a positive integer");
  const arms = WEB_SEARCH_ARMS.map((a) => a.arm);
  return Array.from({ length: repetitions }, (_, rep) =>
    arms.map((_, i) => arms[(i + rep) % arms.length] as WebSearchArm),
  );
}
