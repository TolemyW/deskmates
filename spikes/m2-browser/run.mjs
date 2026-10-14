// Run the focused T3 probe from an isolated worktree without copying credentials into it.
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { requireImageId } from "../../acceptance/support/image-id.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({ options: {
  env: { type: "string" }, image: { type: "string" }, output: { type: "string" }, repetitions: { type: "string", default: "2" },
} });
requireImageId(values.image, "--image");
const repetitions = Number(values.repetitions);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("--repetitions must be between 1 and 5");
const config = values.env ? parseEnv(readFileSync(resolve(values.env), "utf8")) : {};
const env = { ...process.env };
for (const name of ["MODEL_BASE_URL", "MODEL_AUTH_TOKEN", "DEFAULT_MODEL", "CHEAP_MODEL"]) {
  env[name] ||= config[name];
  if (!env[name]) throw new Error(`Missing ${name}`);
}
const output = resolve(values.output ?? join(root, "spikes/m2-browser", `work-${Date.now()}`));
mkdirSync(output, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const imageId = execFileSync("docker", ["image", "inspect", values.image, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
writeFileSync(join(output, "manifest.json"), JSON.stringify({ revision, image: values.image, imageId,
  model: env.DEFAULT_MODEL, cheapModel: env.CHEAP_MODEL, endpointOrigin: new URL(env.MODEL_BASE_URL).origin,
  testSha256: createHash("sha256").update(readFileSync(join(root, "acceptance/m2-browser.acceptance.test.ts"))).digest("hex"),
  startedAt: new Date().toISOString(), repetitions, maxTurns: 6, runTimeoutSeconds: 180,
}, null, 2));
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
  "acceptance/m2-browser.acceptance.test.ts", "--maxWorkers=1"], {
  cwd: root, stdio: "inherit", env: { ...env, WORKSPACE_IMAGE: values.image, M2_REPORT_DIR: output, M2_REPETITIONS: String(repetitions) },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; console.log(`Evidence: ${output}`); });
