// Governed Playwright CLI batch execution (design v0.3 section 3.3). The model supplies only a
// bounded structured workflow. Host-authored code selects the run's exact CDP target and performs
// those operations; arbitrary JavaScript is never accepted as tool input.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DOCKER_HOST_ALIAS,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type RunId,
  egressAllows,
} from "@deskmates/contracts";
import { z } from "zod";
import type { BrowserCoordinationConfig, BrowserState } from "./browser-state.js";
import type { ToolFn } from "./deps.js";
import type { GatewayClient } from "./gateway-client.js";
import { waitForBrowserOrigin } from "./origin-wait.js";
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MIME } from "./screenshots.js";
import { wrapPageContent } from "./untrusted.js";

export const PLAYWRIGHT_CLI_COMMAND = "playwright-cli";
export const CLI_WORKFLOW_VERSION = 1;
const MAX_STEPS = 20;
const MAX_OUTPUT_BYTES = 512_000;
const DEFAULT_TIMEOUT_MS = 90_000;

export type BrowserCliStep =
  | { action: "goto"; url: string }
  | { action: "click"; locator: string; button?: "left" | "right" | "middle" }
  | { action: "fill"; locator: string; value: string; submit?: boolean }
  | { action: "press"; key: string }
  | { action: "select"; locator: string; value: string }
  | { action: "check"; locator: string; checked: boolean }
  | { action: "snapshot" };

export interface BrowserCliWorkflowInput {
  expectedOrigin: string;
  steps: BrowserCliStep[];
  /** Optional reviewed file identity. Full steps remain present in the approval-visible input. */
  savedScript?: { path: string; sha256: string };
}

export interface BrowserCliWorkflowManifest extends BrowserCliWorkflowInput {
  version: typeof CLI_WORKFLOW_VERSION;
}

export interface BrowserCliWorkflowContext {
  runId: RunId;
  cdpEndpoint: string;
  coordination: BrowserCoordinationConfig;
  /** Host-owned directory containing reviewed JSON manifests, normally /work/scripts. */
  scriptsDirectory?: string;
  command?: string;
  timeoutMs?: number;
}

export interface CliInvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BrowserCliWorkflowDeps {
  client: Pick<GatewayClient, "browserLock" | "browserOrigin" | "getEgressAllowlist">;
  readBrowserState(): Promise<BrowserState | undefined>;
  invoke?(
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CliInvocationResult>;
  onScreenshot?(capture: {
    tabId: string;
    browserEpoch: number;
    mimeType: string;
    base64: string;
    bytes: number;
    takenAt: string;
  }): void | Promise<void>;
}

export interface BrowserCliWorkflowResult {
  ok: boolean;
  mayHaveCompleted: boolean;
  text: string;
}

const workflowStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().min(1).max(8192) }),
  z.object({
    action: z.literal("click"),
    locator: z.string().min(1).max(4096),
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  z.object({
    action: z.literal("fill"),
    locator: z.string().min(1).max(4096),
    value: z.string().max(100_000),
    submit: z.boolean().optional(),
  }),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(128) }),
  z.object({
    action: z.literal("select"),
    locator: z.string().min(1).max(4096),
    value: z.string().min(1).max(4096),
  }),
  z.object({
    action: z.literal("check"),
    locator: z.string().min(1).max(4096),
    checked: z.boolean(),
  }),
  z.object({ action: z.literal("snapshot") }),
]);

export const browserCliWorkflowSchema = {
  expectedOrigin: z.string().min(1).max(2048),
  steps: z.array(workflowStepSchema).min(1).max(MAX_STEPS),
  savedScript: z
    .object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
};

function nonEmpty(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function workflowOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.username ||
      url.password ||
      url.origin !== value ||
      isIP(host) !== 0 ||
      !host.includes(".") ||
      // ADR-0009 reserves this exact name for the managed host proxy. It still needs the
      // live allowlist below; this does not grant other internal names or IPs access.
      (url.hostname !== DOCKER_HOST_ALIAS &&
        [".localhost", ".local", ".internal", ".test", ".invalid", ".example"].some(
          (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
        ))
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function validateStep(step: unknown): step is BrowserCliStep {
  if (!step || typeof step !== "object" || Array.isArray(step)) return false;
  const s = step as Record<string, unknown>;
  switch (s.action) {
    case "goto":
      return nonEmpty(s.url, 8192);
    case "click":
      return (
        nonEmpty(s.locator) &&
        (s.button === undefined || ["left", "right", "middle"].includes(String(s.button)))
      );
    case "fill":
      return (
        nonEmpty(s.locator) &&
        typeof s.value === "string" &&
        s.value.length <= 100_000 &&
        (s.submit === undefined || typeof s.submit === "boolean")
      );
    case "press":
      return nonEmpty(s.key, 128);
    case "select":
      return nonEmpty(s.locator) && nonEmpty(s.value, 4096);
    case "check":
      return nonEmpty(s.locator) && typeof s.checked === "boolean";
    case "snapshot":
      return true;
    default:
      return false;
  }
}

export function validateBrowserCliWorkflow(input: unknown): BrowserCliWorkflowInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Browser CLI workflow must be an object");
  const value = input as Record<string, unknown>;
  if (!nonEmpty(value.expectedOrigin, 2048) || !workflowOrigin(value.expectedOrigin))
    throw new Error(
      "expectedOrigin must be a public or reserved host HTTP(S) origin without credentials or a path",
    );
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_STEPS)
    throw new Error(`Browser CLI workflow requires 1 to ${MAX_STEPS} steps`);
  if (!value.steps.every(validateStep)) throw new Error("Browser CLI workflow has an invalid step");
  if (value.savedScript !== undefined) {
    if (
      !value.savedScript ||
      typeof value.savedScript !== "object" ||
      Array.isArray(value.savedScript)
    )
      throw new Error("savedScript must include a path and SHA-256 hash");
    const saved = value.savedScript as Record<string, unknown>;
    if (
      !nonEmpty(saved.path, 4096) ||
      typeof saved.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(saved.sha256)
    )
      throw new Error("savedScript must include a path and lowercase SHA-256 hash");
  }
  return value as unknown as BrowserCliWorkflowInput;
}

function manifestFor(input: BrowserCliWorkflowInput): BrowserCliWorkflowManifest {
  return {
    version: CLI_WORKFLOW_VERSION,
    expectedOrigin: input.expectedOrigin,
    steps: input.steps,
  };
}

async function verifySavedScript(
  input: BrowserCliWorkflowInput,
  scriptsDirectory: string,
): Promise<void> {
  if (!input.savedScript) return;
  const root = await realpath(scriptsDirectory);
  const info = await lstat(input.savedScript.path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Saved workflow must be a regular file");
  const resolved = await realpath(input.savedScript.path);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error("Saved workflow is outside the governed scripts directory");
  const bytes = await readFile(resolved);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== input.savedScript.sha256) throw new Error("Saved workflow changed after review");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Saved workflow is not valid JSON");
  }
  if (JSON.stringify(parsed) !== JSON.stringify(manifestFor(input)))
    throw new Error("Saved workflow does not exactly match the reviewed workflow input");
}

/** Fixed host code. Only JSON data is interpolated, as a JSON string parsed at runtime. */
export function buildBrowserCliProgram(input: BrowserCliWorkflowInput, targetId: string): string {
  const manifestJson = JSON.stringify(JSON.stringify(manifestFor(input)));
  const targetJson = JSON.stringify(targetId);
  return `async (page) => {
  const workflow = JSON.parse(${manifestJson});
  const expectedTarget = ${targetJson};
  const context = page.context();
  async function identity(candidate) {
    const session = await context.newCDPSession(candidate);
    try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
  }
  let targetPage;
  for (const candidate of context.pages()) {
    if (await identity(candidate) === expectedTarget) { targetPage = candidate; break; }
  }
  if (!targetPage) throw new Error('Deskmates exact run target is unavailable');
  const assertFence = async () => {
    if (await identity(targetPage) !== expectedTarget) throw new Error('Deskmates run target changed');
    if (await targetPage.evaluate(() => location.origin) !== workflow.expectedOrigin)
      throw new Error('Deskmates origin fence changed');
  };
  await assertFence();
  const observations = [];
  for (const step of workflow.steps) {
    if (step.action === 'goto') await targetPage.goto(step.url);
    else if (step.action === 'click') await targetPage.locator(step.locator).click({ button: step.button || 'left' });
    else if (step.action === 'fill') {
      await targetPage.locator(step.locator).fill(step.value);
      if (step.submit) await targetPage.locator(step.locator).press('Enter');
    } else if (step.action === 'press') await targetPage.keyboard.press(step.key);
    else if (step.action === 'select') await targetPage.locator(step.locator).selectOption(step.value);
    else if (step.action === 'check') {
      if (step.checked) await targetPage.locator(step.locator).check();
      else await targetPage.locator(step.locator).uncheck();
    } else if (step.action === 'snapshot') {
      observations.push(await targetPage.locator('body').ariaSnapshot({ timeout: 5000 }));
    }
    await assertFence();
  }
  return { deskmatesWorkflow: 1, targetId: await identity(targetPage), url: targetPage.url(), observations };
}`;
}

export function buildBrowserCliScreenshotProgram(targetId: string, expectedOrigin: string): string {
  return `async (page) => {
  const expectedTarget = ${JSON.stringify(targetId)};
  const expectedOrigin = ${JSON.stringify(expectedOrigin)};
  const context = page.context();
  async function identity(candidate) {
    const session = await context.newCDPSession(candidate);
    try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
  }
  let targetPage;
  for (const candidate of context.pages()) {
    if (await identity(candidate) === expectedTarget) { targetPage = candidate; break; }
  }
  if (!targetPage || await targetPage.evaluate(() => location.origin) !== expectedOrigin)
    throw new Error('Deskmates screenshot fence changed');
  const bytes = await targetPage.screenshot({ type: 'jpeg', quality: 90, fullPage: false, scale: 'css' });
  if (await identity(targetPage) !== expectedTarget || await targetPage.evaluate(() => location.origin) !== expectedOrigin)
    throw new Error('Deskmates screenshot fence changed');
  return { deskmatesScreenshot: 1, targetId: expectedTarget, url: targetPage.url(), mimeType: 'image/jpeg', base64: bytes.toString('base64') };
}`;
}

async function invokeCli(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CliInvocationResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: timedOut || bytes > MAX_OUTPUT_BYTES ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function workflowReceipt(stdout: string): { targetId: string; url: string } | undefined {
  const candidates = [stdout.trim()];
  const fenced = /### Result\s*\n([\s\S]*?)(?:\n### |$)/.exec(stdout)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  for (const candidate of candidates) {
    try {
      let parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      const receipt = parsed as { deskmatesWorkflow?: unknown; targetId?: unknown; url?: unknown };
      if (
        receipt.deskmatesWorkflow === 1 &&
        typeof receipt.targetId === "string" &&
        typeof receipt.url === "string"
      )
        return { targetId: receipt.targetId, url: receipt.url };
    } catch {}
  }
  return undefined;
}

function parseRawJson(stdout: string): unknown {
  let parsed: unknown = JSON.parse(stdout.trim());
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  return parsed;
}

function screenshotReceipt(
  stdout: string,
  targetId: string,
  origin: string,
): { base64: string; bytes: number } | undefined {
  try {
    const value = parseRawJson(stdout) as Record<string, unknown>;
    if (
      value.deskmatesScreenshot !== 1 ||
      value.targetId !== targetId ||
      value.mimeType !== SCREENSHOT_MIME ||
      typeof value.url !== "string" ||
      new URL(value.url).origin !== origin ||
      typeof value.base64 !== "string"
    )
      return undefined;
    const bytes = Buffer.from(value.base64, "base64").length;
    if (bytes === 0 || bytes > SCREENSHOT_MAX_BYTES) return undefined;
    return { base64: value.base64, bytes };
  } catch {
    return undefined;
  }
}

function combinedOutput(origin: string, result: CliInvocationResult): string {
  return wrapPageContent(
    origin,
    [result.stdout, result.stderr].filter((value) => value.trim() !== "").join("\n"),
  );
}

export async function executeBrowserCliWorkflow(
  rawInput: unknown,
  context: BrowserCliWorkflowContext,
  deps: BrowserCliWorkflowDeps,
): Promise<BrowserCliWorkflowResult> {
  const input = validateBrowserCliWorkflow(rawInput);
  await verifySavedScript(input, context.scriptsDirectory ?? "/work/scripts");
  const origin = workflowOrigin(input.expectedOrigin) as string;
  const urls = input.steps.flatMap((step) => (step.action === "goto" ? [step.url] : []));
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Workflow navigation URL is invalid");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin)
      throw new Error("Every workflow navigation must stay on the reviewed HTTP(S) origin");
  }
  const allowlist = (await deps.client.getEgressAllowlist()).egressAllowlist;
  const hosts = [origin, ...urls].map((url) => new URL(url).hostname);
  if (hosts.some((host) => !egressAllows(host, allowlist)))
    throw new Error("Browser CLI workflow was denied by the live egress allowlist");

  const initialState = await deps.readBrowserState();
  if (!initialState || initialState.runId !== context.runId || !initialState.tabId)
    throw new Error("Browser CLI workflow has no run tab yet; use a browser tool first");
  const tabId = initialState.tabId;
  const initialTab = initialState.tabs.find((tab) => tab.id === tabId);
  if (!initialTab || new URL(initialTab.url).origin !== origin)
    throw new Error("Browser CLI workflow target does not match the reviewed origin");
  const lock = await deps.client.browserLock({
    type: "browser_lock",
    runId: context.runId,
    op: "acquire",
    tabId,
  });
  if (!lock.granted) throw new Error(lock.waitMessage ?? HUMAN_HOLDS_BROWSER_MESSAGE);
  const epoch = lock.epoch ?? 0;

  let leasedOrigin = false;
  if (context.coordination.mode === "origin-v2" && context.coordination.deadlineAt) {
    const lease = await waitForBrowserOrigin(origin, {
      client: deps.client,
      runId: context.runId,
      deadlineAt: context.coordination.deadlineAt,
    });
    if (!lease.granted)
      throw new Error(
        lease.waitReason === "human"
          ? HUMAN_HOLDS_BROWSER_MESSAGE
          : "Browser origin is busy; no workflow action was dispatched.",
      );
    leasedOrigin = true;
  }

  const invoke = deps.invoke ?? invokeCli;
  const session = `deskmates-${String(context.runId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const command = context.command ?? PLAYWRIGHT_CLI_COMMAND;
  const timeout = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scratch = await mkdtemp(path.join(tmpdir(), "deskmates-browser-cli-"));
  const programPath = path.join(scratch, "workflow.js");
  let attachedToBrowser = false;
  let actionDispatched = false;
  let currentStep = 0;
  try {
    const attached = await invoke(
      command,
      [`-s=${session}`, "attach", `--cdp=${context.cdpEndpoint}`],
      timeout,
    );
    if (attached.exitCode !== 0)
      return { ok: false, mayHaveCompleted: false, text: combinedOutput(origin, attached) };
    attachedToBrowser = true;
    const outputs: string[] = [];
    let completedSteps = 0;
    for (const step of input.steps) {
      currentStep = completedSteps + 1;
      const liveAllowlist = (await deps.client.getEgressAllowlist()).egressAllowlist;
      if (hosts.some((host) => !egressAllows(host, liveAllowlist))) {
        return {
          ok: false,
          mayHaveCompleted: false,
          text: `Egress permission changed before step ${currentStep}. ${completedSteps} earlier step(s) completed. The next step was not dispatched; return to MCP exploration only after the policy permits it.`,
        };
      }
      // Attach starts an independent CLI session. Recheck the human-takeover epoch immediately
      // before every individual step, then again after it. A lost fence stops the batch.
      const beforeLock = await deps.client.browserLock({
        type: "browser_lock",
        runId: context.runId,
        op: "acquire",
        tabId,
      });
      if (!beforeLock.granted || (beforeLock.epoch ?? 0) !== epoch) {
        return {
          ok: false,
          mayHaveCompleted: false,
          text: `Browser control changed before step ${completedSteps + 1}. ${completedSteps} earlier step(s) completed with intact fences. Return to MCP exploration after handback; the next step was not dispatched.`,
        };
      }
      if (leasedOrigin) {
        const renewed = await deps.client.browserOrigin({
          type: "browser_origin",
          runId: context.runId,
          op: "renew",
          origin,
        });
        if (!renewed.granted) {
          return {
            ok: false,
            mayHaveCompleted: false,
            text: `The origin lease changed before step ${completedSteps + 1}. ${completedSteps} earlier step(s) completed with intact fences. Return to MCP exploration; the next step was not dispatched.`,
          };
        }
      }

      await writeFile(
        programPath,
        buildBrowserCliProgram({ expectedOrigin: origin, steps: [step] }, tabId),
        { mode: 0o600 },
      );
      actionDispatched = true;
      const executed = await invoke(
        command,
        [`-s=${session}`, "--raw", "run-code", `--filename=${programPath}`],
        timeout,
      );
      const afterLock = await deps.client.browserLock({
        type: "browser_lock",
        runId: context.runId,
        op: "acquire",
        tabId,
      });
      const renewed = leasedOrigin
        ? await deps.client.browserOrigin({
            type: "browser_origin",
            runId: context.runId,
            op: "renew",
            origin,
          })
        : undefined;
      const receipt = workflowReceipt(executed.stdout);
      let receiptOrigin: string | undefined;
      try {
        receiptOrigin = receipt ? new URL(receipt.url).origin : undefined;
      } catch {}
      const safe =
        executed.exitCode === 0 &&
        afterLock.granted &&
        (afterLock.epoch ?? 0) === epoch &&
        (!renewed || renewed.granted) &&
        receipt?.targetId === tabId &&
        receiptOrigin === origin;
      if (!safe) {
        return {
          ok: false,
          mayHaveCompleted: true,
          text: `The governed browser workflow lost its completion fence during step ${completedSteps + 1}. That step may have completed; do not retry it. Return to MCP exploration and inspect the run tab after handback.`,
        };
      }
      completedSteps += 1;
      outputs.push(executed.stdout, executed.stderr);
    }
    // One final viewport capture represents the approved batch in the run ledger. It is read-only
    // and separately fenced; a takeover or capture failure suppresses it without changing the
    // already-confirmed workflow result. The base64 receipt is never appended to model text.
    if (deps.onScreenshot) {
      try {
        const beforeCapture = await deps.client.browserLock({
          type: "browser_lock",
          runId: context.runId,
          op: "acquire",
          tabId,
        });
        const originBeforeCapture = leasedOrigin
          ? await deps.client.browserOrigin({
              type: "browser_origin",
              runId: context.runId,
              op: "renew",
              origin,
            })
          : undefined;
        if (
          beforeCapture.granted &&
          (beforeCapture.epoch ?? 0) === epoch &&
          (!originBeforeCapture || originBeforeCapture.granted)
        ) {
          await writeFile(programPath, buildBrowserCliScreenshotProgram(tabId, origin), {
            mode: 0o600,
          });
          const captured = await invoke(
            command,
            [`-s=${session}`, "--raw", "run-code", `--filename=${programPath}`],
            timeout,
          );
          const afterCapture = await deps.client.browserLock({
            type: "browser_lock",
            runId: context.runId,
            op: "acquire",
            tabId,
          });
          const originAfterCapture = leasedOrigin
            ? await deps.client.browserOrigin({
                type: "browser_origin",
                runId: context.runId,
                op: "renew",
                origin,
              })
            : undefined;
          const receipt = screenshotReceipt(captured.stdout, tabId, origin);
          if (
            captured.exitCode === 0 &&
            afterCapture.granted &&
            (afterCapture.epoch ?? 0) === epoch &&
            (!originAfterCapture || originAfterCapture.granted) &&
            receipt
          ) {
            await deps.onScreenshot({
              tabId,
              browserEpoch: epoch,
              mimeType: SCREENSHOT_MIME,
              base64: receipt.base64,
              bytes: receipt.bytes,
              takenAt: new Date().toISOString(),
            });
          }
        }
      } catch {
        // Ledger capture is bounded observability and never changes the confirmed action result.
      }
    }
    return {
      ok: true,
      mayHaveCompleted: false,
      text: wrapPageContent(origin, outputs.filter((value) => value.trim() !== "").join("\n")),
    };
  } catch (error) {
    if (!actionDispatched) throw error;
    return {
      ok: false,
      mayHaveCompleted: true,
      text: `The governed browser workflow lost its completion fence during step ${currentStep}. That step may have completed; do not retry it. Return to MCP exploration and inspect the run tab after handback. Host detail: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (attachedToBrowser)
      await invoke(command, [`-s=${session}`, "detach"], 5_000).catch(() => undefined);
    if (leasedOrigin) {
      await deps.client
        .browserOrigin({
          type: "browser_origin",
          runId: context.runId,
          op: "release",
          origin,
        })
        .catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** In-process MCP tool definition; callers own registration and the L2 PreToolUse hook. */
export function browserCliWorkflowTool(
  tool: ToolFn,
  context: BrowserCliWorkflowContext,
  deps: BrowserCliWorkflowDeps,
) {
  return tool(
    "browser_cli_workflow",
    "Run a bounded, reviewed Playwright CLI workflow against this run's exact browser tab. The whole workflow requires approval. Use CSS locators only. A failed completion fence means actions may have completed and must not be retried without inspection.",
    browserCliWorkflowSchema,
    async (args) => {
      try {
        const result = await executeBrowserCliWorkflow(args, context, deps);
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.ok ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `The governed browser workflow was not dispatched: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
