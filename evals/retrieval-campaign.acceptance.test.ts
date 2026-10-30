// T4 executor for comparison R of the 2026-10-17 protocol (ADR-0041 decision 10): one arm, one
// repetition block, every active task once (block 1 starts with the first batch, amendment 1),
// one observation file per run. It skips unless EVAL_CAMPAIGN=retrieval-v1 is set together with
// EVAL_ARM, EVAL_REPEAT, EVAL_REPORT_DIR and Docker, and then either:
//
// - EVAL_DRY_RUN=scripted: the scripted dry run (amendment 1 A4) against a scripted upstream and
//   scripted retrieval services, placeholder models priced at zero. No owner ruling, no model.
// - otherwise the model variables of `.env`. A campaign whose every model (DEFAULT_MODEL,
//   CHEAP_MODEL) is priced as known zero needs no ceiling; one with a paid model needs
//   EVAL_CEILING_USD, the one ceiling the owner authorised for the whole comparison. None is
//   authorised today. Neither mode has been run.
//
//   EVAL_CAMPAIGN=retrieval-v1 EVAL_ARM=fts5 EVAL_REPEAT=1 EVAL_REPORT_DIR=<dir> \
//   [EVAL_DRY_RUN=scripted | EVAL_CEILING_USD=<authorised>] \
//   npx vitest run evals/retrieval-campaign.acceptance.test.ts
//
// Then `npm run retrieval-eval -- rows <dir> --arm <arm> --out <file.jsonl>` per arm, and
// `npm run retrieval-eval -- decide <baseline.jsonl> <candidate.jsonl>` per comparison.

import { describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "../acceptance/support/docker.js";
import { missingModelEnv, modelEnv } from "../acceptance/support/env.js";
import {
  type FakeModelUpstream,
  startFakeModelUpstream,
} from "../acceptance/support/fake-model-upstream.js";
import { POLL_MS, newThread, postMessage, waitForRun } from "../acceptance/support/runs.js";
import { type Stack, startStack } from "../acceptance/support/start-stack.js";
import { stopStack } from "../acceptance/support/stop-stack.js";
import { RetrievalDryScript } from "./campaign/dry-run-script.js";
import { type DryRunServices, startDryRunServices } from "./campaign/dry-run-services.js";
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
import { retrievalArm, retrievalArmEnvironment } from "./retrieval/arms.js";
import type { RetrievalObservation } from "./retrieval/grade.js";
import { observeRetrievalRun, seedRetrieval, vectorsReady } from "./retrieval/seed.js";
import {
  activeItems,
  loadRetrievalTaskSet,
  retrievalInstruction,
  validateRetrievalTaskSet,
} from "./retrieval/task-set.js";

const enabled = campaignRequested("retrieval-v1");
const dry = enabled && dryRunRequested(process.env);
// A dry run brings its own scripted upstream; only a model campaign needs the model variables.
const missing = dry ? [] : missingModelEnv();
const dockerUp = enabled ? await dockerAvailable() : false;

/** The bot under test: no domain rules beyond the answer format, so retrieval is the variable. */
const SOUL = [
  "# retrieval_eval",
  "",
  "You answer questions about this team's work from its approved knowledge and learned memory.",
  "Use knowledge_search, knowledge_read and memory_search as the question says. Do not browse,",
  "do not propose knowledge and do not guess: if what you find does not say, answer not found.",
  "Give the answer on the last line of your reply as `answer: <value>`.",
].join("\n");

describe.skipIf(!enabled || missing.length > 0 || !dockerUp)(
  `retrieval campaign (EVAL_CAMPAIGN=retrieval-v1${missing.length > 0 ? `; set ${missing.join(", ")}` : ""})`,
  () => {
    it(
      "runs one arm's repetition block and records one observation per task",
      async () => {
        const set = loadRetrievalTaskSet();
        expect(validateRetrievalTaskSet(set)).toEqual([]);
        const script = new RetrievalDryScript();
        let upstream: FakeModelUpstream | undefined;
        let services: DryRunServices | undefined;
        let stack: Stack | undefined;
        try {
          let env: NodeJS.ProcessEnv = process.env;
          if (dry) {
            upstream = await startFakeModelUpstream({
              expectedToken: DRY_RUN_TOKEN,
              reply: "",
              script: (_turn, body) => script.turn(body),
            });
            services = await startDryRunServices();
            env = {
              ...process.env,
              ...dryRunEnvironment({
                modelBaseUrl: upstream.url,
                embeddingUrl: services.embeddingUrl,
                rerankUrl: services.rerankUrl,
              }),
            };
          }
          const arm = retrievalArm(env.EVAL_ARM).arm;
          const settings = campaignConfig(env, retrievalArmEnvironment(arm, env));
          const models = dry
            ? {
                modelBaseUrl: env.MODEL_BASE_URL ?? "",
                modelAuthToken: DRY_RUN_TOKEN,
                defaultModel: env.DEFAULT_MODEL ?? "",
                cheapModel: env.CHEAP_MODEL ?? "",
              }
            : modelEnv();
          // Amendment 1: known zero starts without a ceiling; a paid model needs the one ceiling.
          const run = authoriseCampaign(env, {
            campaign: "retrieval-v1",
            taskSet: `${set.name}@${set.version}`,
            mode: dry ? "scripted" : "model",
            models: [models.defaultModel, models.cheapModel],
            prices: settings.modelPrices,
          });
          requireWorkspaceImageId();
          stack = await startStack({
            ...models,
            label: `retrieval-${arm}-r${run.repeat}${dry ? "-dry" : ""}`,
            botName: "retrieval_eval",
            soul: SOUL,
            modelPrices: settings.modelPrices,
            campaignConfig: {
              ...(settings.retrieval ? { retrieval: settings.retrieval } : {}),
              ...(settings.modelUpstreams ? { modelUpstreams: settings.modelUpstreams } : {}),
            },
          });
          const s = stack;
          s.config.maxTurns = 30;
          s.config.runTimeoutSeconds = 600;
          requirePrices(s, [s.config.defaultModel, s.config.cheapModel]);
          const map = await seedRetrieval(s, set);
          if (s.config.retrieval?.embedding) {
            s.app.deskmates.ctx.retrieval.kick();
            const deadline = Date.now() + 20 * 60_000;
            while (!vectorsReady(s, set)) {
              if (Date.now() > deadline)
                throw new Error("harness: the index did not cover the corpus in 20 minutes");
              s.app.deskmates.ctx.retrieval.kick();
              await new Promise((resolve) => setTimeout(resolve, 5 * POLL_MS));
            }
          }
          const cap = (taskId: string) =>
            set.ceiling.per_run_usd[set.items.find((i) => i.id === taskId)?.bucket ?? "medium"];
          const order = firstBatchFirst(
            taskOrder(activeItems(set), seeded(1000 + run.repeat)),
            (i) => set.ceiling.smoke_tasks.includes(i.id),
            run.repeat,
          );
          for (const item of order) {
            guard(run, cap, item.id);
            script.current = item;
            const thread = await newThread(s, `retrieval eval ${item.id}`);
            const started = await postMessage(s, retrievalInstruction(set, item), thread.id);
            await waitForRun(s, started.run.id, 660_000);
            const seen = await observeRetrievalRun(s, set, map, started.run.id);
            const usage = await accounting(s, started.run.id);
            const obs: RetrievalObservation = {
              taskId: item.id,
              arm,
              repeat: run.repeat,
              runId: started.run.id,
              ...seen,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsd: usage.costUsd,
              leakUsd: await followUpCost(s, started.run.id),
              wallMs: usage.wallMs,
              servedModels: usage.servedModels,
              config: {
                taskSet: `${set.name}@${set.version}`,
                fillerSha256: set.filler.sha256,
                retrieval: s.config.retrieval ?? null,
                defaultModel: s.config.defaultModel,
                ...(dry ? { dryRun: "scripted" } : {}),
              },
            };
            writeObservation(run, obs, [s.config.modelAuthToken, s.config.operatorToken]);
          }
        } finally {
          await stopStack(stack);
          await upstream?.close();
          await services?.close();
        }
      },
      24 * 3_600_000,
    );
  },
);
