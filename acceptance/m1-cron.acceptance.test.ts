// T3: M1 acceptance `acceptance/m1-cron` (test strategy §7). A bot whose only trigger is a cron
// entry firing every minute, on the deployed model, through the real stack (Gateway, Docker
// workspace, sidecar, Agent SDK). Each round appends a line to /work/cron.log with the shell, so
// the workspace filesystem is the second witness: the ledger says the runs happened, the file
// says they did the work.
//
// What this file asserts is the part only a real model and a real container can show — that a
// cron entry fires once per minute, that each firing is its own `background` run naming its own
// minute in `triggerRef`, and that the side effect landed. The strategy note for this file also
// asks for the overlap rule (a round that starts while the previous run is still going is
// skipped and recorded as a `log` event with `{source: "cron", skipped: true}`). That is proven
// at T1 in the Gateway against a controlled clock, where a run can be stretched out on purpose;
// stretching a model run to straddle a minute boundary would buy a slow, flaky copy of a test
// that already exists, so it is deliberately not attempted here.
//
// Needs MODEL_BASE_URL, MODEL_AUTH_TOKEN, DEFAULT_MODEL and CHEAP_MODEL (environment or .env)
// and a reachable Docker daemon; otherwise the suite is skipped and its title says why.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { type RunView, runsForBot } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

/** Every minute, in the Gateway's timezone. */
const CRON_SCHEDULE = "* * * * *";
const CRON_LOG = "/work/cron.log";
const CRON_PROMPT = `Append one line with the current time to ${CRON_LOG} using the shell, then reply done.`;

/** Two firings a minute apart, plus the first partial minute and a slow model's margin. */
const WAIT_MS = 4 * 60_000;
const ROUNDS_EXPECTED = 2;

/** `cron:<entryIndex>:<minute ISO>`; the ISO part holds colons of its own, so it is not a split. */
const TRIGGER_REF = /^cron:(\d+):(.+)$/;

/** A shell bot, not a browser bot: the default SOUL.md is about the golden site. */
function cronSoul(botName: string): string {
  return [
    `# ${botName}`,
    "",
    `You are ${botName}, a maintenance bot. You work through the shell in /work.`,
    "",
    "## Rules",
    "- Do exactly what the scheduled task says, with one shell command where one is enough.",
    "- Never delete or truncate a file you were only asked to append to.",
    "- Keep replies to a single short line.",
  ].join("\n");
}

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
if (skip) {
  console.warn(`[m1-cron.acceptance.test]${skipReason(missing, dockerUp)}`);
}

/** The bot's cron runs, newest last. */
async function cronRuns(stack: Stack): Promise<RunView[]> {
  const runs = await runsForBot(stack);
  return runs
    .filter((r) => r.triggerKind === "cron")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** `cat` the log inside the workspace; an empty result is "not yet", not a failure. */
async function cronLogLines(stack: Stack): Promise<string[]> {
  const res = await stack.docker.exec(stack.handle, {
    cmd: ["cat", CRON_LOG],
    timeoutMs: 15_000,
  });
  if (res.exitCode !== 0) return [];
  return res.stdout.split("\n").filter((l) => l.trim() !== "");
}

describe.skipIf(skip)(
  `M1 cron (T3): a bot fires every minute on its own lane${skipReason(missing, dockerUp)}`,
  () => {
    let stack: Stack | undefined;
    let observed: RunView[] = [];

    beforeAll(async () => {
      const env = modelEnv();
      const botName = "cronbot";
      stack = await startStack({
        modelBaseUrl: env.modelBaseUrl,
        modelAuthToken: env.modelAuthToken,
        defaultModel: env.defaultModel,
        cheapModel: env.cheapModel,
        label: "cron",
        botName,
        soul: cronSoul(botName),
        cron: [{ schedule: CRON_SCHEDULE, prompt: CRON_PROMPT }],
        // This is the one suite that waits for the runner itself to fire.
        startCron: true,
      });
      console.log(
        `[m1-cron] bot ${stack.bot.id} created with cron "${CRON_SCHEDULE}"; waiting up to ` +
          `${WAIT_MS / 60_000} minutes for ${ROUNDS_EXPECTED} rounds`,
      );
    }, 25 * 60_000);

    afterAll(async () => {
      await stopStack(stack);
    }, 120_000);

    it(
      "the cron entry fires once a minute and each firing is its own background run",
      async () => {
        const s = stack as Stack;
        // The Gateway stores the entry it was created with; the runner reads it from there.
        expect(s.bot.cron.map((c) => c.schedule)).toEqual([CRON_SCHEDULE]);

        const started = Date.now();
        const deadline = started + WAIT_MS;
        let reported = "";
        for (;;) {
          observed = await cronRuns(s);
          const succeeded = observed.filter((r) => r.status === "succeeded");
          const line = `${observed.length} cron run(s), ${succeeded.length} succeeded`;
          if (line !== reported) {
            reported = line;
            console.log(`[m1-cron] ${line} (+${Math.round((Date.now() - started) / 1000)}s)`);
          }
          if (succeeded.length >= ROUNDS_EXPECTED) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 5000));
        }

        const failed = observed.filter((r) => r.status === "failed");
        for (const r of failed) console.error(`[m1-cron] run ${r.id} failed: ${r.error}`);

        expect(
          observed.length,
          `cron runs after ${Math.round((Date.now() - started) / 1000)}s`,
        ).toBeGreaterThanOrEqual(ROUNDS_EXPECTED);
        for (const r of observed) {
          expect(r.triggerKind).toBe("cron");
          // Cron is a background trigger, and it has no thread to reply into.
          expect(r.lane).toBe("background");
          expect(r.botId).toBe(s.bot.id);
        }

        const succeeded = observed.filter((r) => r.status === "succeeded");
        expect(
          succeeded.length,
          `succeeded cron runs (statuses: ${observed.map((r) => r.status).join(", ")})`,
        ).toBeGreaterThanOrEqual(ROUNDS_EXPECTED);

        // One run per matching minute: every triggerRef names entry 0 and a minute of its own.
        const minutes = succeeded.map((r) => {
          const m = TRIGGER_REF.exec(r.triggerRef);
          expect(
            m,
            `triggerRef "${r.triggerRef}" is cron:<entryIndex>:<minute ISO>`,
          ).not.toBeNull();
          expect(m?.[1], "the only cron entry is index 0").toBe("0");
          return m?.[2] ?? "";
        });
        console.log(`[m1-cron] minutes fired: ${minutes.join(", ")}`);
        expect(new Set(minutes).size, `distinct minutes in ${minutes.join(", ")}`).toBe(
          minutes.length,
        );
      },
      WAIT_MS + 2 * 60_000,
    );

    it("each round appended a line to /work/cron.log in the workspace", async () => {
      const s = stack as Stack;
      const lines = await cronLogLines(s);
      console.log(`[m1-cron] ${CRON_LOG} has ${lines.length} line(s): ${lines.join(" | ")}`);
      expect(lines.length, `lines in ${CRON_LOG}`).toBeGreaterThanOrEqual(ROUNDS_EXPECTED);
    }, 60_000);
  },
);
