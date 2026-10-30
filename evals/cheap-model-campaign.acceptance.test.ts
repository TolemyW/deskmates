// T4 executor for comparison C of the 2026-10-17 protocol (ADR-0023 decision 2): one arm, one
// repetition block, every active task once (block 1 starts with the first batch, amendment 1),
// one observation file per job. It skips unless EVAL_CAMPAIGN=cheap-model-v1 is set together
// with EVAL_ARM, EVAL_REPEAT, EVAL_REPORT_DIR and Docker, and then either:
//
// - EVAL_DRY_RUN=scripted: the scripted dry run (amendment 1 A4) against a scripted upstream that
//   answers every job with its case's reference output, placeholder models priced at zero. No
//   owner ruling, no model.
// - otherwise the model variables of `.env` with EVAL_CHEAP_INCUMBENT and EVAL_CHEAP_CANDIDATE.
//   A campaign whose every model (both cheap models and DEFAULT_MODEL) is priced as known zero
//   needs no ceiling; one with a paid model needs EVAL_CEILING_USD, the one ceiling the owner
//   authorised for the whole comparison. None is authorised today. Neither mode has been run.
//
//   EVAL_CAMPAIGN=cheap-model-v1 EVAL_ARM=incumbent EVAL_REPEAT=1 EVAL_REPORT_DIR=<dir> \
//   [EVAL_DRY_RUN=scripted | EVAL_CHEAP_INCUMBENT=<id> EVAL_CHEAP_CANDIDATE=<id> \
//   [EVAL_CEILING_USD=<authorised>]] npx vitest run evals/cheap-model-campaign.acceptance.test.ts
//
// Then `npm run cheap-model-eval -- rows <dir> --arm <arm> --out <file.jsonl>` per arm and
// `npm run cheap-model-eval -- decide <incumbent.jsonl> <candidate.jsonl>`.

import { describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "../acceptance/support/docker.js";
import { missingModelEnv, modelEnv } from "../acceptance/support/env.js";
import {
  type FakeModelUpstream,
  startFakeModelUpstream,
} from "../acceptance/support/fake-model-upstream.js";
import { type Stack, startStack } from "../acceptance/support/start-stack.js";
import { stopStack } from "../acceptance/support/stop-stack.js";
import { CheapDryScript } from "./campaign/dry-run-script.js";
import { DRY_RUN_TOKEN, dryRunEnvironment, dryRunRequested } from "./campaign/dry-run.js";
import { authoriseCampaign, firstBatchFirst } from "./campaign/gate.js";
import { guard, taskOrder, writeObservation } from "./campaign/report-dir.js";
import { campaignConfig, campaignRequested, requirePrices } from "./campaign/stack.js";
import { seeded } from "./campaign/text.js";
import { cheapArm, cheapArmModel } from "./cheap-model/arms.js";
import { prepareDrivers, runCheapTask } from "./cheap-model/drivers.js";
import type { CheapObservation } from "./cheap-model/grade.js";
import { cheapTasks, loadCheapTaskSet } from "./cheap-model/task-set.js";
import { validateCheapTaskSet } from "./cheap-model/validate.js";

const enabled = campaignRequested("cheap-model-v1");
const dry = enabled && dryRunRequested(process.env);
// A dry run brings its own scripted upstream; only a model campaign needs the model variables.
const missing = dry ? [] : missingModelEnv();
const dockerUp = enabled ? await dockerAvailable() : false;

describe.skipIf(!enabled || missing.length > 0 || !dockerUp)(
  `cheap-model campaign (EVAL_CAMPAIGN=cheap-model-v1${missing.length > 0 ? `; set ${missing.join(", ")}` : ""})`,
  () => {
    it(
      "runs one arm's repetition block and records one observation per job",
      async () => {
        const set = loadCheapTaskSet();
        expect(validateCheapTaskSet(set)).toEqual([]);
        const script = new CheapDryScript();
        const tasks = cheapTasks(set);
        let upstream: FakeModelUpstream | undefined;
        let stack: Stack | undefined;
        try {
          let env: NodeJS.ProcessEnv = process.env;
          if (dry) {
            upstream = await startFakeModelUpstream({
              expectedToken: DRY_RUN_TOKEN,
              reply: "",
              script: (_turn, body) => script.turn(body),
            });
            env = { ...process.env, ...dryRunEnvironment({ modelBaseUrl: upstream.url }) };
          }
          const arm = cheapArm(env.EVAL_ARM).arm;
          const { CHEAP_MODEL } = cheapArmModel(arm, env);
          const settings = campaignConfig(env, { CHEAP_MODEL });
          const models = dry
            ? {
                modelBaseUrl: env.MODEL_BASE_URL ?? "",
                modelAuthToken: DRY_RUN_TOKEN,
                defaultModel: env.DEFAULT_MODEL ?? "",
                cheapModel: CHEAP_MODEL,
              }
            : modelEnv();
          // Amendment 1: both arms' cheap models and the main model decide whether the campaign
          // is known zero; one paid model makes the whole campaign need the one ceiling.
          const run = authoriseCampaign(env, {
            campaign: "cheap-model-v1",
            taskSet: `${set.name}@${set.version}`,
            mode: dry ? "scripted" : "model",
            models: [
              env.EVAL_CHEAP_INCUMBENT ?? "",
              env.EVAL_CHEAP_CANDIDATE ?? "",
              models.defaultModel,
            ],
            prices: settings.modelPrices,
          });
          requireWorkspaceImageId();
          stack = await startStack({
            ...models,
            // The one knob: CHEAP_MODEL. Everything else is the campaign's installation config.
            cheapModel: CHEAP_MODEL,
            label: `cheap-${arm}-r${run.repeat}${dry ? "-dry" : ""}`,
            botName: "cheap_eval",
            soul: "# cheap_eval\n\nYou help the warehouse team. Keep replies short.\n",
            // round_triage runs only under round-v1 (ADR-0005 amendment 6); no other kind posts to a group.
            groupRouting: "round-v1",
            modelPrices: settings.modelPrices,
            campaignConfig: settings.modelUpstreams
              ? { modelUpstreams: settings.modelUpstreams }
              : {},
          });
          const s = stack;
          requirePrices(s, [CHEAP_MODEL, s.config.defaultModel]);
          const drivers = await prepareDrivers(s, tasks);
          const cap = (taskId: string) => {
            const kind = tasks.find((t) => t.taskId === taskId)?.kind;
            return kind
              ? set.ceiling.per_run_usd[kind] +
                  (kind === "round_triage" ? set.ceiling.triage_leak_usd : 0)
              : 0.05;
          };
          const order = firstBatchFirst(
            taskOrder(tasks, seeded(2000 + run.repeat)),
            (t) => set.ceiling.smoke_cases.includes(t.caseId),
            run.repeat,
          );
          for (const task of order) {
            guard(run, cap, task.taskId);
            script.task = task;
            script.ids = {};
            const result = await runCheapTask(
              s,
              drivers,
              task,
              `${task.taskId}-r${run.repeat}`.replace(/[^A-Za-z0-9-]/g, "-").toLowerCase(),
              (ids) => {
                script.ids = ids;
              },
            );
            const obs: CheapObservation = {
              taskId: task.taskId,
              arm,
              repeat: run.repeat,
              ...result,
              config: {
                taskSet: `${set.name}@${set.version}`,
                variantsSha256: set.large.sha256,
                cheapModel: CHEAP_MODEL,
                defaultModel: s.config.defaultModel,
                ...(dry ? { dryRun: "scripted" } : {}),
              },
            };
            writeObservation(run, obs, [s.config.modelAuthToken, s.config.operatorToken]);
          }
        } finally {
          await stopStack(stack);
          await upstream?.close();
        }
      },
      24 * 3_600_000,
    );
  },
);
