// Run the paired two-workspace model A/B (acceptance/m2-model-ab.acceptance.test.ts) from an
// isolated worktree without copying credentials into it, modelled on spikes/m2-live/run.mjs.
//
//   node spikes/m2-model-ab/run.mjs --env /path/to/.env \
//     --image "$(docker image inspect --format '{{.Id}}' deskmates/workspace:<tag>)" \
//     --model-a <model id> --model-b <model id> [--rounds 5] [--output <dir>]
//
// Only MODEL_BASE_URL, MODEL_AUTH_TOKEN, DEFAULT_MODEL and CHEAP_MODEL are read from --env;
// exported values win. The arm models come from --model-a/--model-b or the exported
// M2_AB_MODEL_A/M2_AB_MODEL_B, never from DEFAULT_MODEL. manifest.json is written before the test
// starts; results.json and summary.json are written by the test as rows land. After the test
// exits, the per-arm summary is printed with the sample-size caveat: a 5-round campaign detects a
// model that cannot do the case at all, it does not rank two models that both mostly work.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { requireImageId } from "../../acceptance/support/image-id.mjs";
import { buildAbManifest } from "../../acceptance/support/m2-model-ab-manifest.mjs";
import {
  abSampleSizeCaveat,
  formatAbSummary,
  readAbConfig,
  summarizeAbRows,
} from "../../acceptance/support/m2-model-ab.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST = "acceptance/m2-model-ab.acceptance.test.ts";
// Every file that defines what a round is; a campaign is only comparable to one with equal hashes.
const FIXTURE_FILES = [
  TEST,
  "acceptance/support/m2-foundation.ts",
  "acceptance/support/m2-assessment.ts",
  "acceptance/support/m2-group.ts",
  "acceptance/support/m2-model-ab.mjs",
];

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    image: { type: "string" },
    output: { type: "string" },
    "model-a": { type: "string" },
    "model-b": { type: "string" },
    rounds: { type: "string" },
  },
});
const image = requireImageId(values.image, "--image");
const ab = readAbConfig({
  M2_AB_MODEL_A: values["model-a"] ?? process.env.M2_AB_MODEL_A,
  M2_AB_MODEL_B: values["model-b"] ?? process.env.M2_AB_MODEL_B,
  M2_AB_ROUNDS: values.rounds ?? process.env.M2_AB_ROUNDS,
});
const config = values.env ? parseEnv(readFileSync(resolve(values.env), "utf8")) : {};
const env = { ...process.env };
/** @param {string} name */
const required = (name) => {
  env[name] ||= config[name];
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const modelBaseUrl = required("MODEL_BASE_URL");
required("MODEL_AUTH_TOKEN");
const defaultModel = required("DEFAULT_MODEL");
required("CHEAP_MODEL");
const output = resolve(values.output ?? join(root, "spikes/m2-model-ab", `work-${Date.now()}`));
mkdirSync(output, { recursive: true });
const git = (/** @type {string[]} */ ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const imageIdOf = (/** @type {string} */ ref) =>
  execFileSync("docker", ["image", "inspect", ref, "--format", "{{.Id}}"], {
    encoding: "utf8",
  }).trim();
const egressImage = env.EGRESS_PROXY_IMAGE || "deskmates/egress-proxy:dev";
const manifest = buildAbManifest({
  revision: git("rev-parse", "HEAD"),
  workingTreeStatus: git("status", "--porcelain"),
  image,
  imageId: imageIdOf(image),
  egressImage,
  egressImageId: imageIdOf(egressImage),
  modelA: ab.modelA,
  modelB: ab.modelB,
  rounds: ab.rounds,
  defaultModel,
  endpointOrigin: new URL(modelBaseUrl).origin,
  fixtureSha256: Object.fromEntries(
    FIXTURE_FILES.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex"),
    ]),
  ),
  startedAt: new Date().toISOString(),
});
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));

function printSummary() {
  const results = join(output, "results.json");
  if (!existsSync(results)) {
    console.log(`No results.json in ${output}.\n\n${abSampleSizeCaveat(ab.rounds)}`);
    return;
  }
  const rows = JSON.parse(readFileSync(results, "utf8"));
  const summary = summarizeAbRows(rows, { A: ab.modelA, B: ab.modelB }, ab.rounds);
  console.log(`\nModel A/B summary\n${formatAbSummary(summary)}`);
}

const log = createWriteStream(join(output, "test.log"), { flags: "wx" });
const child = spawn(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", TEST, "--maxWorkers=1"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      WORKSPACE_IMAGE: image,
      M2_REPORT_DIR: output,
      M2_AB_MODEL_A: ab.modelA,
      M2_AB_MODEL_B: ab.modelB,
      M2_AB_ROUNDS: String(ab.rounds),
    },
  },
);
child.stdout.on("data", (data) => {
  process.stdout.write(data);
  log.write(data);
});
child.stderr.on("data", (data) => {
  process.stderr.write(data);
  log.write(data);
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  log.end(() => {
    process.exitCode = code ?? 1;
    printSummary();
    console.log(`Evidence: ${output}`);
  });
});
