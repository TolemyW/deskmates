// M3/M4 product-testing, data and quant flows. Domain oracles examine executable artifacts,
// replay them without a model, and retain usage/failures. This is not a paired strategy trial.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { OPS_ACCOUNT, PASSWORD } from "@deskmates/golden-site";
import { describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { DATA_TASK, startDataFixture } from "./support/m3-data-fixture.js";
import { startProductFixture } from "./support/m3-product-fixture.js";
import { changeProductOpenCount } from "./support/m3-product-oracle.js";
import {
  PRICES_CSV,
  QUANT_TASK,
  replayQuantArtifact,
  verifyQuantArtifact,
} from "./support/m3-quant.js";
import {
  dataConnectorObservationReceipt,
  observeDataConnector,
  requireSettledDataSubmissions,
} from "./support/m4-domain-connector-observer.js";
import { verifyDataReport, verifyDataSnapshot } from "./support/m4-domain-data-oracle.js";
import { domainErrorKind, finalizeDomainAttempt } from "./support/m4-domain-finalize.js";
import { getRun, postMessage, runEvents, threadMessages, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;

function outputDir(label: string): string {
  requireWorkspaceImageId();
  const root = process.env.M3_REPORT_DIR;
  if (!root || !isAbsolute(root))
    throw Error("M3_REPORT_DIR must be an absolute retained evidence directory");
  const directory = join(root, `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function save(directory: string, name: string, data: unknown): void {
  writeFileSync(join(directory, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

async function file(stack: Stack, path: string): Promise<string> {
  const result = await stack.provider.exec(stack.handle, {
    cmd: [
      "node",
      "-e",
      "const f=require('node:fs');const p=process.argv[1];if(f.statSync(p).size>262144)process.exit(2);process.stdout.write(f.readFileSync(p))",
      path,
    ],
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw Error(`missing or oversized artifact ${path}`);
  return result.stdout;
}

async function evidence(stack: Stack, runId: string, directory: string): Promise<void> {
  const result = await getRun(stack, runId);
  save(directory, "run.json", {
    ...result,
    usage: result.usage.length ? result.usage : null,
    images: {
      workspace: process.env.WORKSPACE_IMAGE,
      egress: process.env.EGRESS_PROXY_IMAGE,
      golden: process.env.GOLDEN_SITE_IMAGE,
    },
  });
  save(directory, "events.json", await runEvents(stack, runId));
  save(directory, "messages.json", await threadMessages(stack));
  const context = await stack.api("GET", `/api/runs/${runId}/context`);
  save(directory, "context.json", context);
  if (context.status !== 200) throw Error("run context evidence unavailable");
  save(directory, "model-requests.json", stack.app.deskmates.ctx.modelRequests.list(result.run.id));
}

async function finish(
  stack: Stack | undefined,
  runId: string | undefined,
  directory: string,
  oraclePassed: boolean,
  fixture?: { close(): Promise<void> },
  extraEvidence: { name: string; run(): Promise<void> }[] = [],
  afterCleanup: { name: string; run(): Promise<void> }[] = [],
): Promise<void> {
  await finalizeDomainAttempt({
    oraclePassed,
    evidence: [
      ...(stack && runId ? [{ name: "run", run: () => evidence(stack, runId, directory) }] : []),
      ...extraEvidence,
    ],
    cleanup: [
      { name: "stack", run: () => stopStack(stack) },
      {
        name: "fixture",
        run: async () => {
          await fixture?.close();
        },
      },
    ],
    afterCleanup,
    save: (name, data) => save(directory, name, data),
  });
}

describe.skipIf(skip)(`M3 minimal domain flows${skipReason(missing, dockerUp)}`, () => {
  it("queries seeded data through the production connector and binds the report to its receipt", async () => {
    const directory = outputDir("data-platform");
    let stack: Stack | undefined;
    let fixture: Awaited<ReturnType<typeof startDataFixture>> | undefined;
    let runId: string | undefined;
    let passed = false;
    let before: ReturnType<typeof verifyDataSnapshot> | undefined;
    let observer: ReturnType<typeof observeDataConnector> | undefined;
    try {
      fixture = await startDataFixture();
      const snapshot = fixture.snapshot();
      save(directory, "data-state-before.json", snapshot);
      before = verifyDataSnapshot(snapshot);
      save(directory, "data-invariant.json", { before });
      stack = await startStack({
        ...modelEnv(),
        label: "m3-data",
        botName: "m3data",
        botConnectors: ["database"],
        secretsKey: randomBytes(32).toString("base64"),
        soul: "You are a data platform engineer. Use production connector receipts as the authority for SQL results. Report only observed results. Use preinstalled tools only and never bypass a denied action.",
      });
      stack.config.maxTurns = 20;
      const registered = await stack.api<{ connector: { id: string } }>("POST", "/api/connectors", {
        workspaceId: stack.workspace.id,
        name: "database",
        kind: "postgres",
        url: fixture.url,
        credential: fixture.credential,
      });
      expect(registered.status).toBe(201);
      observer = observeDataConnector(stack.app.deskmates.ctx.connectorProxy, {
        botId: stack.bot.id,
        connectorId: registered.json.connector.id,
        connectorName: "database",
      });
      save(directory, "task.json", {
        prompt: DATA_TASK,
        images: {
          postgres: process.env.M3_POSTGRES_IMAGE,
          connector: process.env.CONNECTOR_POSTGRES_IMAGE,
        },
      });
      const { run } = await postMessage(stack, DATA_TASK);
      runId = run.id;
      const terminal = await waitForRun(stack, run.id, 900_000);
      observer.seal();
      expect(terminal.status).toBe("succeeded");
      const report = JSON.parse(await file(stack, "/work/data-report.json")) as {
        receiptId: string;
        rows: unknown;
      };
      const receipts = stack.app.deskmates.ctx.connectorReceipts.listForRun(run.id);
      save(directory, "artifacts.json", { report, receipts });
      const events = await runEvents(stack, run.id);
      verifyDataReport(report, receipts, observer.trace, {
        runId: run.id,
        botId: stack.bot.id,
        workspaceId: stack.workspace.id,
        connectorId: registered.json.connector.id,
      });
      if (JSON.stringify({ report, receipts, events }).includes(fixture.credential))
        throw Error("connector credential leaked into domain evidence");
      passed = true;
    } catch (error) {
      save(directory, "failure.json", { error: domainErrorKind(error) });
      // Assertion diffs and child-process argv can contain credentials; retain only safe labels.
      throw Error(`domain scenario failed (${domainErrorKind(error)}); inspect retained artifacts`);
    } finally {
      observer?.seal();
      const captureObserver = async () => {
        if (!observer) throw Error("host connector observer unavailable");
        save(
          directory,
          "connector-observations.json",
          dataConnectorObservationReceipt(observer.trace),
        );
        requireSettledDataSubmissions(observer.trace);
      };
      await finish(
        stack,
        runId,
        directory,
        passed,
        fixture,
        [
          {
            name: "host-connector-observations",
            run: async () => {
              await captureObserver();
            },
          },
          {
            name: "independent-data-state",
            run: async () => {
              if (!fixture) throw Error("independent data fixture unavailable");
              const snapshot = fixture.snapshot();
              save(directory, "data-state-after.json", snapshot);
              const after = verifyDataSnapshot(snapshot);
              save(directory, "data-invariant.json", { before, after });
              expect(before, "independent seed observation is required").toBeDefined();
              expect(after).toEqual(before);
            },
          },
        ],
        [{ name: "final-sealed-connector-observations", run: captureObserver }],
      );
      // The dedicated stack is never reused. Keep the guard sealed even if best-effort
      // stopStack swallowed a close failure; restoring methods would re-enable its routes.
    }
  }, 1_200_000);

  it("generates and runs a real app test which also catches a dashboard regression", async () => {
    const directory = outputDir("product-testing");
    let stack: Stack | undefined;
    let fixture: Awaited<ReturnType<typeof startProductFixture>> | undefined;
    let runId: string | undefined;
    let passed = false;
    try {
      fixture = await startProductFixture();
      stack = await startStack({
        ...modelEnv(),
        label: "m3-product",
        botName: "m3tester",
        soul: "You are a product test engineer. Build executable browser tests from the requested requirements. Use preinstalled tools only and report actual results. Never bypass a denied action.",
      });
      stack.config.maxTurns = 20;
      const prompt = `Create /work/product-test.mjs using Node and the preinstalled Playwright at
/opt/deskmates/node_modules/playwright. Target the app at ${fixture.origin}; the script MUST read
the target from process.env.BASE_URL and accept a different origin on replay. Use its own
Playwright browser context attached to http://127.0.0.1:9222 and close that context, not Chromium.
Requirements: an invalid password cannot log in; valid login (${OPS_ACCOUNT} / ${PASSWORD})
lands on dashboard; the dashboard Open tickets value equals the number of rows after filtering
the Tickets UI to open status. Do not use /api/state or other test-only APIs.
Assertions must cause a nonzero process exit on mismatch. Run the script against this app with
BASE_URL set and save actual stdout/stderr/exit code in /work/product-result.json.
Do not modify the app, install packages, or hardcode the expected count. Keep the test read-only
apart from login. Include the artifact paths in your reply.`;
      save(directory, "task.json", { prompt, fixtureImage: process.env.GOLDEN_SITE_IMAGE });
      const { run } = await postMessage(stack, prompt);
      runId = run.id;
      expect((await waitForRun(stack, run.id, 900_000)).status).toBe("succeeded");
      const source = await file(stack, "/work/product-test.mjs");
      const result = await file(stack, "/work/product-result.json");
      save(directory, "artifacts.json", {
        source,
        result,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      });
      expect(source).not.toContain("/api/state");
      const replay = async (origin: string) =>
        stack?.provider.exec(stack.handle, {
          cmd: ["env", `BASE_URL=${origin}`, "node", "/work/product-test.mjs"],
          timeoutMs: 60_000,
        });
      const log = async () => {
        const response = await fetch(`${fixture?.hostOrigin}/api/state/log`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { seq: number; op: string }[];
      };
      const before = await log();
      const original = await replay(fixture.origin);
      const originalOperations = (await log()).filter(
        (item) => item.seq > (before.at(-1)?.seq ?? 0),
      );
      const mutant = await replay(fixture.mutantOrigin);
      save(directory, "replay.json", {
        original,
        mutant,
        originalOperations,
        mutationHits: fixture.mutationHits(),
      });
      // A constant matching the initial seed can pass the original/mutant pair. Prove that
      // this same artifact also accepts a legitimate new count, without another model call.
      const changedCount = await changeProductOpenCount(fixture.hostOrigin);
      save(directory, "positive-control.json", changedCount);
      const beforeChangedReplay = await log();
      const changed = await replay(fixture.origin);
      const changedOperations = (await log()).filter(
        (item) => item.seq > (beforeChangedReplay.at(-1)?.seq ?? 0),
      );
      save(directory, "replay.json", {
        original,
        mutant,
        originalOperations,
        changedCount,
        changed,
        changedOperations,
        mutationHits: fixture.mutationHits(),
      });
      expect(original?.exitCode).toBe(0);
      expect(originalOperations.some((item) => item.op === "login_failed")).toBe(true);
      expect(originalOperations.some((item) => item.op === "login")).toBe(true);
      expect(
        originalOperations.every((item) => ["login_failed", "login", "logout"].includes(item.op)),
      ).toBe(true);
      expect(mutant?.exitCode).toBeGreaterThan(0);
      expect(fixture.mutationHits()).toBeGreaterThan(0);
      expect(changed?.exitCode).toBe(0);
      expect(changedOperations.some((item) => item.op === "login_failed")).toBe(true);
      expect(changedOperations.some((item) => item.op === "login")).toBe(true);
      expect(
        changedOperations.every((item) => ["login_failed", "login", "logout"].includes(item.op)),
      ).toBe(true);
      passed = true;
    } catch (error) {
      save(directory, "failure.json", { error: domainErrorKind(error) });
      // Assertion diffs and child-process argv can contain credentials; retain only safe labels.
      throw Error(`domain scenario failed (${domainErrorKind(error)}); inspect retained artifacts`);
    } finally {
      await finish(stack, runId, directory, passed, fixture);
    }
  }, 1_200_000);

  it("reproduces a frozen lagged momentum backtest with cost and provenance", async () => {
    const directory = outputDir("quant-research");
    let stack: Stack | undefined;
    let runId: string | undefined;
    let passed = false;
    try {
      stack = await startStack({
        ...modelEnv(),
        label: "m3-quant",
        botName: "m3quant",
        soul: "You are a quant research engineer. Implement the requested numerical experiment, preserve data provenance, and report actual computed results. Use preinstalled tools only. Never bypass a denied action.",
      });
      stack.config.maxTurns = 20;
      const wrote = await stack.provider.exec(stack.handle, {
        cmd: ["tee", "/work/prices.csv"],
        stdin: PRICES_CSV,
        timeoutMs: 10_000,
      });
      expect(wrote.exitCode).toBe(0);
      save(directory, "task.json", { prompt: QUANT_TASK, prices: PRICES_CSV });
      const { run } = await postMessage(stack, QUANT_TASK);
      runId = run.id;
      expect((await waitForRun(stack, run.id, 900_000)).status).toBe("succeeded");
      const source = await file(stack, "/work/backtest.mjs");
      const artifact = JSON.parse(await file(stack, "/work/backtest.json")) as unknown;
      save(directory, "artifacts.json", {
        source,
        artifact,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      });
      verifyQuantArtifact(artifact);
      expect(await file(stack, "/work/prices.csv")).toBe(PRICES_CSV);
      const activeStack = stack;
      const replays: unknown[] = [];
      await replayQuantArtifact(
        (request) => activeStack.provider.exec(activeStack.handle, request),
        (path) => file(activeStack, path),
        source,
        (fixture, entry) => {
          replays.push({ fixture, entry });
          save(directory, "replay.json", replays);
        },
      );
      passed = true;
    } catch (error) {
      save(directory, "failure.json", { error: domainErrorKind(error) });
      // Assertion diffs and child-process argv can contain credentials; retain only safe labels.
      throw Error(`domain scenario failed (${domainErrorKind(error)}); inspect retained artifacts`);
    } finally {
      await finish(stack, runId, directory, passed);
    }
  }, 1_200_000);
});
