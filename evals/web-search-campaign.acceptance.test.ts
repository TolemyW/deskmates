// T4 executor for the web search comparison (ADR-0049 decision 13; protocol
// `docs/design/web-search-evaluation-protocol-2026-10-18.md`): one arm, one repetition block,
// every active task once (block 1 starts with the first batch), one observation file per run. It
// skips unless EVAL_CAMPAIGN=web-search-v1 is set together with EVAL_ARM, EVAL_REPEAT,
// EVAL_REPORT_DIR and Docker, and then either:
//
// - EVAL_DRY_RUN=scripted: the scripted dry run against a scripted upstream, placeholder models
//   priced at zero. No owner ruling, no model.
// - otherwise the model variables of `.env`. A campaign whose every model (DEFAULT_MODEL,
//   CHEAP_MODEL) is priced as known zero needs no ceiling; one with a paid model needs
//   EVAL_CEILING_USD, the one ceiling the owner authorised for the whole comparison. None is
//   authorised today. Neither mode has been run.
//
// Both arms search the executor's own fixture: it is the web (its pages) and its search engine
// (an HTML search page for the browser, SearXNG's JSON for the Gateway's proxy). The campaign
// workspace's egress allowlist is the host the container reaches it on, so nothing else is
// reachable; an ask to leave it is declined at once and counted.
//
//   EVAL_CAMPAIGN=web-search-v1 EVAL_ARM=browser EVAL_REPEAT=1 EVAL_REPORT_DIR=<dir> \
//   [EVAL_DRY_RUN=scripted | EVAL_CEILING_USD=<authorised>] \
//   npx vitest run evals/web-search-campaign.acceptance.test.ts
//
// Then `npm run web-search-eval -- rows <dir> --arm <arm> --out <file.jsonl>` per arm, and
// `npm run web-search-eval -- decide browser.jsonl browser-search.jsonl`.

import { randomBytes } from "node:crypto";
import type { RunId } from "@deskmates/contracts";
import { gatewayUrlForContainer } from "@deskmates/sandbox-docker";
import { describe, expect, it } from "vitest";
import { waitForRunEnd } from "../acceptance/support/approvals.js";
import { dockerAvailable, requireWorkspaceImageId } from "../acceptance/support/docker.js";
import { missingModelEnv, modelEnv } from "../acceptance/support/env.js";
import {
  type FakeModelUpstream,
  startFakeModelUpstream,
} from "../acceptance/support/fake-model-upstream.js";
import { newThread, postMessage } from "../acceptance/support/runs.js";
import { type Stack, startStack } from "../acceptance/support/start-stack.js";
import { stopStack } from "../acceptance/support/stop-stack.js";
import { DRY_RUN_TOKEN, dryRunEnvironment, dryRunRequested } from "./campaign/dry-run.js";
import { authoriseCampaign, firstBatchFirst } from "./campaign/gate.js";
import { guard, taskOrder, writeObservation } from "./campaign/report-dir.js";
import {
  accounting,
  campaignConfig,
  campaignRequested,
  followUpCost,
  requirePrices,
} from "./campaign/stack.js";
import { seeded } from "./campaign/text.js";
import { webSearchArm, webSearchArmEnvironment } from "./web-search/arms.js";
import { WebSearchDryScript } from "./web-search/dry-run-script.js";
import { type SearchFixture, startSearchFixture } from "./web-search/fixture-server.js";
import type { WebSearchObservation } from "./web-search/grade.js";
import {
  declineApprovalsWhile,
  observeWebSearchRun,
  setWebSearchSwitch,
} from "./web-search/stack.js";
import {
  activeItems,
  loadWebSearchTaskSet,
  validateWebSearchTaskSet,
  webSearchInstruction,
} from "./web-search/task-set.js";

const enabled = campaignRequested("web-search-v1");
const dry = enabled && dryRunRequested(process.env);
const missing = dry ? [] : missingModelEnv();
const dockerUp = enabled ? await dockerAvailable() : false;

/** The bot under test, the same text in both arms; it names no tool. */
function soul(origin: string): string {
  return [
    "# web_search_eval",
    "",
    "You answer questions about coastal workshops from what you find on the web.",
    `The web you can reach is ${origin}; its search engine is ${origin}/search, and you may use any`,
    "search tool you have. Do not guess and do not answer from memory: if what you find does not",
    "say, answer not found. Give the answer on the last line of your reply as `answer: <value>`.",
  ].join("\n");
}

describe.skipIf(!enabled || missing.length > 0 || !dockerUp)(
  `web search campaign (EVAL_CAMPAIGN=web-search-v1${missing.length > 0 ? `; set ${missing.join(", ")}` : ""})`,
  () => {
    it(
      "runs one arm's repetition block and records one observation per task",
      async () => {
        const set = loadWebSearchTaskSet();
        expect(validateWebSearchTaskSet(set)).toEqual([]);
        const script = new WebSearchDryScript();
        const searchToken = randomBytes(24).toString("hex");
        let fixture: SearchFixture | undefined;
        let upstream: FakeModelUpstream | undefined;
        let stack: Stack | undefined;
        try {
          fixture = await startSearchFixture(set, {
            host: "0.0.0.0",
            searchToken,
            publicOrigin: (port) => gatewayUrlForContainer(`http://127.0.0.1:${port}`),
          });
          const origin = gatewayUrlForContainer(fixture.url);
          script.origin = origin;
          let env: NodeJS.ProcessEnv = process.env;
          if (dry) {
            upstream = await startFakeModelUpstream({
              expectedToken: DRY_RUN_TOKEN,
              reply: "",
              script: (_turn, body) => script.turn(body),
            });
            env = { ...process.env, ...dryRunEnvironment({ modelBaseUrl: upstream.url }) };
          }
          const arm = webSearchArm(env.EVAL_ARM);
          const settings = campaignConfig(
            env,
            webSearchArmEnvironment(env, { url: fixture.url, token: searchToken }),
          );
          if (!settings.search) throw new Error("harness: the search fixture is not configured");
          const models = dry
            ? {
                modelBaseUrl: env.MODEL_BASE_URL ?? "",
                modelAuthToken: DRY_RUN_TOKEN,
                defaultModel: env.DEFAULT_MODEL ?? "",
                cheapModel: env.CHEAP_MODEL ?? "",
              }
            : modelEnv();
          // Protocol amendment 1: known zero starts without a ceiling; a paid model needs the one.
          const run = authoriseCampaign(env, {
            campaign: "web-search-v1",
            taskSet: `${set.name}@${set.version}`,
            mode: dry ? "scripted" : "model",
            models: [models.defaultModel, models.cheapModel],
            prices: settings.modelPrices,
          });
          requireWorkspaceImageId();
          stack = await startStack({
            ...models,
            label: `ws-${arm.arm}-r${run.repeat}${dry ? "-dry" : ""}`,
            botName: "web_search_eval",
            soul: soul(origin),
            modelPrices: settings.modelPrices,
            campaignConfig: {
              search: settings.search,
              ...(settings.modelUpstreams ? { modelUpstreams: settings.modelUpstreams } : {}),
            },
          });
          const s = stack;
          s.config.maxTurns = 40;
          s.config.runTimeoutSeconds = 900;
          requirePrices(s, [s.config.defaultModel, s.config.cheapModel]);
          // The workspace reaches only the fixture's host (start-stack locks it to that host).
          if (!s.workspace.egressAllowlist.includes(new URL(origin).hostname))
            throw new Error("harness: the campaign workspace cannot reach the fixture");
          await setWebSearchSwitch(s, arm.switchOn);
          const cap = (taskId: string) =>
            set.ceiling.per_run_usd[set.items.find((i) => i.id === taskId)?.bucket ?? "long"];
          const order = firstBatchFirst(
            taskOrder(activeItems(set), seeded(2000 + run.repeat)),
            (i) => set.ceiling.smoke_tasks.includes(i.id),
            run.repeat,
          );
          for (const item of order) {
            guard(run, cap, item.id);
            script.current = item;
            fixture.drain();
            const thread = await newThread(s, `web search eval ${item.id}`);
            let runId: string | undefined;
            const finished = (async () => {
              const started = await postMessage(s, webSearchInstruction(set, item), thread.id);
              runId = started.run.id;
              // A declined ask may park the run once; it resumes on the decision, so wait for its end.
              return waitForRunEnd(s, started.run.id as RunId, 960_000, {
                failIfParkedAgain: false,
              });
            })();
            await declineApprovalsWhile(s, () => runId, finished);
            const ended = await finished;
            const seen = await observeWebSearchRun(s, ended.id, fixture.drain());
            const usage = await accounting(s, ended.id);
            const obs: WebSearchObservation = {
              taskId: item.id,
              arm: arm.arm,
              repeat: run.repeat,
              runId: ended.id,
              ...seen,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsd: usage.costUsd,
              leakUsd: await followUpCost(s, ended.id),
              wallMs: usage.wallMs,
              servedModels: usage.servedModels,
              config: {
                taskSet: `${set.name}@${set.version}`,
                fillerSha256: set.filler.sha256,
                webSearch:
                  s.app.deskmates.ctx.runs.mustGet(ended.id as RunId).config.webSearch ?? null,
                defaultModel: s.config.defaultModel,
                ...(dry ? { dryRun: "scripted" } : {}),
              },
            };
            writeObservation(run, obs, [
              s.config.modelAuthToken,
              s.config.operatorToken,
              searchToken,
            ]);
          }
        } finally {
          await stopStack(stack);
          await upstream?.close();
          await fixture?.close();
        }
      },
      30 * 3_600_000,
    );
  },
);
