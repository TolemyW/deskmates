import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createApi } from "./client.js";
import {
  type ConnectorBinding,
  type ImportReceipt,
  exportScenario,
  importScenario,
  runScenario,
} from "./operations.js";
import { check, fingerprint, parseScenario, record } from "./schema.js";

const usage = `Usage:
  npm run scenario -- validate <scenario.json>
  npm run scenario -- export <workspace-id> --out <scenario.json>
  npm run scenario -- import <scenario.json> --receipt <import.json> [--bindings <bindings.json>]
  npm run scenario -- run <scenario.json> --receipt <import.json> --out <results.json>

Network commands use SCENARIO_GATEWAY_URL and SCENARIO_OPERATOR_TOKEN.
Import creates a new workspace, leaves cron disabled, and sends no task messages.
Run is explicit, one-shot per receipt, and may incur model usage. No write retries.
See scripts/scenarios/README.md for limitations and Testbox examples.`;

async function json(path: string): Promise<unknown> {
  const body = await readFile(path, "utf8");
  check(Buffer.byteLength(body) <= 8 * 1024 * 1024, "Input JSON exceeds 8 MiB");
  return JSON.parse(body);
}
async function reserve(path: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  await file.close();
}
async function save(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
async function bindings(path: string | undefined): Promise<Record<string, ConnectorBinding>> {
  if (!path) return {};
  const input = record(await json(path));
  check(
    Object.keys(input).every((k) => k === "connectors"),
    "Bindings only support connectors",
  );
  const output: Record<string, ConnectorBinding> = Object.create(null);
  for (const [name, raw] of Object.entries(record(input.connectors))) {
    const value = record(raw);
    check(
      Object.keys(value).every((k) => ["urlEnv", "credentialEnv", "kind", "publicUrl"].includes(k)),
      "Unknown connector binding field",
    );
    check(typeof value.urlEnv === "string", "Connector binding needs urlEnv");
    const url = process.env[value.urlEnv];
    check(url, `Missing environment variable ${value.urlEnv}`);
    let credential: string | undefined;
    if (value.credentialEnv !== undefined) {
      check(typeof value.credentialEnv === "string", "Invalid credentialEnv");
      credential = process.env[value.credentialEnv];
      check(credential, `Missing environment variable ${value.credentialEnv}`);
    }
    check(value.kind === undefined || typeof value.kind === "string", "Invalid connector kind");
    check(
      value.publicUrl === undefined || typeof value.publicUrl === "boolean",
      "Invalid connector publicUrl",
    );
    output[name] = {
      url,
      ...(credential ? { credential } : {}),
      ...(value.kind === undefined ? {} : { kind: value.kind }),
      ...(value.publicUrl === undefined ? {} : { publicUrl: value.publicUrl }),
    };
  }
  return output;
}

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(usage);
    return;
  }
  check(target && ["validate", "export", "import", "run"].includes(command), usage);
  const allowed =
    command === "import"
      ? ["--receipt", "--bindings"]
      : command === "run"
        ? ["--receipt", "--out"]
        : command === "export"
          ? ["--out"]
          : [];
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    check(key && allowed.includes(key) && value && !args.has(key), "Invalid or duplicate option");
    args.set(key, value);
  }
  const scenario = command === "export" ? undefined : parseScenario(await json(target));
  if (command === "validate") {
    console.log(
      JSON.stringify({
        valid: true,
        hash: fingerprint(scenario),
        bots: scenario?.bots.length,
        tasks: scenario?.tasks.length,
      }),
    );
    return;
  }
  const api = createApi(
    process.env.SCENARIO_GATEWAY_URL ?? "",
    process.env.SCENARIO_OPERATOR_TOKEN ?? "",
  );
  if (command === "export") {
    const out = args.get("--out");
    check(out, "--out is required");
    await reserve(out);
    await save(out, await exportScenario(api, target));
    console.log(
      `Exported ${out}. Tasks are empty. Review text for secrets before sharing. Histories, learned memory, rules, integrations and browser state are not exported.`,
    );
    return;
  }
  check(scenario, "Missing scenario");
  const path = args.get("--receipt");
  check(path, "--receipt is required");
  const lock = `${path}.lock`;
  await reserve(lock);
  try {
    if (command === "import") {
      const localBindings = await bindings(args.get("--bindings"));
      await reserve(path);
      const receipt = await importScenario(api, scenario, (r) => save(path, r), localBindings);
      console.log(
        JSON.stringify({
          workspaceId: receipt.workspaceId,
          receipt: path,
          schedulesEnabled: false,
        }),
      );
    } else {
      const out = args.get("--out");
      check(out && out !== path, "A distinct --out is required");
      const receipt = (await json(path)) as ImportReceipt;
      check(
        receipt.schemaVersion === 1 && receipt.bots && receipt.threads,
        "Invalid import receipt",
      );
      await reserve(out);
      const report = await runScenario(
        api,
        scenario,
        receipt,
        (r) => save(path, r),
        (r) => save(out, r),
      );
      console.log(
        JSON.stringify({
          results: out,
          tasks: report.tasks.map(({ name, status }) => ({ name, status })),
        }),
      );
      if (report.tasks.some((t) => !["passed", "completed-unchecked"].includes(t.status)))
        process.exitCode = 1;
    }
  } finally {
    await unlink(lock);
  }
}

main().catch((error: unknown) => {
  // Do not print response bodies, headers or environment values.
  let message = error instanceof Error ? error.message : "Scenario command failed";
  for (const [key, value] of Object.entries(process.env))
    if (value && /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/i.test(key))
      message = message.replaceAll(value, "<redacted>");
  console.error(message);
  process.exitCode = 1;
});
