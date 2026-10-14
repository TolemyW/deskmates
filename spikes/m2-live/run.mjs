// Run the focused T3 probe from an isolated worktree without copying credentials into it.
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { selectSnapshotMode } from "./run-config.mjs";
import { requireImageId } from "../../acceptance/support/image-id.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({ options: {
  env: { type: "string" }, image: { type: "string" }, output: { type: "string" }, repetitions: { type: "string", default: "2" },
  "snapshot-mode": { type: "string", default: "explicit-v1" },
} });
requireImageId(values.image, "--image");
const repetitions = Number(values.repetitions);
const snapshotMode = selectSnapshotMode(values["snapshot-mode"]);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("--repetitions must be between 1 and 5");
const config = values.env ? parseEnv(readFileSync(resolve(values.env), "utf8")) : {};
const env = { ...process.env };
for (const name of ["MODEL_BASE_URL", "MODEL_AUTH_TOKEN", "DEFAULT_MODEL", "CHEAP_MODEL"]) {
  env[name] ||= config[name];
  if (!env[name]) throw new Error(`Missing ${name}`);
}
const output = resolve(values.output ?? join(root, "spikes/m2-live", `work-${Date.now()}`));
mkdirSync(output, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const workingTreeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
const imageId = execFileSync("docker", ["image", "inspect", values.image, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
const egressImage = env.EGRESS_PROXY_IMAGE ?? "deskmates/egress-proxy:dev";
const egressImageId = execFileSync("docker", ["image", "inspect", egressImage, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
writeFileSync(join(output, "manifest.json"), JSON.stringify({ revision, workingTreeStatus, image: values.image, imageId,
  egressImage, egressImageId,
  model: env.DEFAULT_MODEL, cheapModel: env.CHEAP_MODEL, endpointOrigin: new URL(env.MODEL_BASE_URL).origin,
  testSha256: createHash("sha256").update(readFileSync(join(root, "acceptance/m2-group-foundation.acceptance.test.ts"))).digest("hex"),
  // The SOUL, fixture and settle loop moved to support/m2-foundation.ts; hash it too so the
  // manifest still fingerprints the whole fixture, not just the test file.
  fixtureSha256: createHash("sha256").update(readFileSync(join(root, "acceptance/support/m2-foundation.ts"))).digest("hex"),
  startedAt: new Date().toISOString(), repetitions, maxTurns: 8, runTimeoutSeconds: 180,
  browserSnapshotMode: snapshotMode,
}, null, 2));
const log = createWriteStream(join(output, "test.log"), { flags: "wx" });
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
  "acceptance/m2-group-foundation.acceptance.test.ts", "--maxWorkers=1"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...env, WORKSPACE_IMAGE: values.image, M2_REPORT_DIR: output, M2_REPETITIONS: String(repetitions), M2_BROWSER_SNAPSHOT_MODE: snapshotMode },
});
child.stdout.on("data", (data) => { process.stdout.write(data); log.write(data); });
child.stderr.on("data", (data) => { process.stderr.write(data); log.write(data); });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code) => { log.end(() => { process.exitCode = code ?? 1; console.log(`Evidence: ${output}`); }); });
