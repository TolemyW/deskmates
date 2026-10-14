// T2: a real SDK run parks on an L2 browser action, resumes in its leased Chromium target after
// a human decision, commits the action once, and does not move a peer run's target.
import { readFileSync } from "node:fs";
import type { Approval, BotDefinition, RunEvent, Thread } from "@deskmates/contracts";
import { OPS_ACCOUNT, PASSWORD } from "@deskmates/golden-site";
import type { StateView } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideApproval, pendingApprovals, waitForRunEnd } from "./support/approvals.js";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type RecordedUpstreamRequest,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { postMessage, runEvents, waitForRun } from "./support/runs.js";
import { siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const PEER_PROMPT = "B2_PEER_SENTINEL: open the peer page.";
const APPROVAL_PROMPT = "B2_APPROVAL_RESUME: place one SKU-8 order for customer C-0008.";
const PEER_QUERY = "b2-peer=stable";
const CUSTOMER = "C-0008";
const SKU = "SKU-8";
const RUN_TIMEOUT_MS = 120_000;

function requestedSnapshotMode(): "explicit-v1" | "inline-v2" {
  const value = process.env.M2_BROWSER_SNAPSHOT_MODE ?? "explicit-v1";
  if (value !== "explicit-v1" && value !== "inline-v2") {
    throw new Error("M2_BROWSER_SNAPSHOT_MODE must be explicit-v1 or inline-v2");
  }
  return value;
}

const snapshotMode = requestedSnapshotMode();

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
}

function visit(value: unknown, fn: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fn);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  fn(record);
  for (const child of Object.values(record)) visit(child, fn);
}

function toolUseCount(body: RecordedUpstreamRequest["body"], name: string): number {
  let count = 0;
  visit(body?.messages, (record) => {
    if (record.type === "tool_use" && record.name === name) count += 1;
  });
  return count;
}

function messageText(body: RecordedUpstreamRequest["body"]): string {
  const text: string[] = [];
  visit(body?.messages, (record) => {
    for (const key of ["text", "content", "code"]) {
      const value = record[key];
      if (typeof value === "string") text.push(value);
    }
  });
  return text.join("\n");
}

function submitOrderRef(body: RecordedUpstreamRequest["body"]): string {
  const text = messageText(body);
  const matches = [...text.matchAll(/button\s+"Submit order"[^\n]*\[ref=([^\]]+)\]/gi)];
  const ref = matches.at(-1)?.[1];
  if (!ref) throw new Error(`scripted upstream found no Submit order ref in: ${text}`);
  return ref;
}

function orderIds(state: StateView): string[] {
  return Object.values(state.orders)
    .filter((order) => order.customerId === CUSTOMER && order.sku === SKU)
    .map((order) => order.id)
    .sort();
}

function acquiredTabIds(events: readonly RunEvent[], attempt: number): string[] {
  return events
    .filter(
      (event) =>
        event.attempt === attempt &&
        event.kind === "log" &&
        event.payload.source === "browser_lock" &&
        event.payload.op === "tab_acquired" &&
        typeof event.payload.tabId === "string",
    )
    .map((event) => event.payload.tabId as string);
}

async function cdpTargets(stack: Stack): Promise<CdpTarget[]> {
  const script = readFileSync(
    new URL("../spikes/m2-browser-approval/inspect-targets.mjs", import.meta.url),
    "utf8",
  );
  const result = await stack.provider.exec(stack.handle, {
    cmd: ["node", "--input-type=module", "-e", script],
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout) as CdpTarget[];
}

const available = await dockerAvailable();
describe.skipIf(!available)(
  "M2 browser approval resume (real Docker/MCP/SDK, scripted upstream)",
  () => {
    let stack: Stack | undefined;
    let upstream: FakeModelUpstream | undefined;

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        expectedToken: "m2-browser-approval-fake",
        reply: "done",
        script: (_turn, body) => {
          const text = messageText(body);
          const tools = JSON.stringify(body?.tools ?? []);
          // The CLI can make ancillary requests without the browser tools. They are outside this
          // scripted browser conversation and receive an ordinary completed assistant turn.
          if (!tools.includes("mcp__browser__browser_navigate")) {
            return { kind: "text", text: assistantText("done") };
          }

          if (text.includes(PEER_PROMPT)) {
            if (toolUseCount(body, "mcp__browser__browser_navigate") === 0) {
              return {
                kind: "tool_use",
                name: "mcp__browser__browser_navigate",
                input: { url: `${stack?.siteOriginForBot}/login?${PEER_QUERY}` },
              };
            }
            return { kind: "text", text: assistantText("peer ready") };
          }

          if (!text.includes(APPROVAL_PROMPT)) {
            return { kind: "text", text: assistantText("unexpected prompt") };
          }
          const navigations = toolUseCount(body, "mcp__browser__browser_navigate");
          if (navigations === 0) {
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_navigate",
              input: { url: `${stack?.siteOriginForBot}/login` },
            };
          }
          if (!text.includes("B2_LOGIN_READY")) {
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_run_code_unsafe",
              input: {
                code: `async (page) => { await page.locator('#email').fill(${JSON.stringify(OPS_ACCOUNT)}); await page.locator('#password').fill(${JSON.stringify(PASSWORD)}); await page.locator('#login-submit').click(); await page.waitForURL('**/dashboard'); return 'B2_LOGIN_READY'; }`,
              },
            };
          }
          if (navigations < 2) {
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_navigate",
              input: { url: `${stack?.siteOriginForBot}/checkout` },
            };
          }
          if (!text.includes("B2_ORDER_READY")) {
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_run_code_unsafe",
              input: {
                code: `async (page) => { await page.locator('#customer-id').fill('${CUSTOMER}'); await page.locator('#sku').selectOption('${SKU}'); await page.locator('#quantity').fill('1'); return 'B2_ORDER_READY'; }`,
              },
            };
          }
          if (
            /Order\s+O-[^\s]+\s+placed for\s+C-0008/i.test(text) ||
            text.includes("/checkout?placed=")
          ) {
            return { kind: "text", text: assistantText("order placed once") };
          }

          const snapshots = toolUseCount(body, "mcp__browser__browser_snapshot");
          const clicks = toolUseCount(body, "mcp__browser__browser_click");
          if (snapshots === 0 || (clicks === 1 && snapshots === 1)) {
            return { kind: "tool_use", name: "mcp__browser__browser_snapshot", input: {} };
          }
          return {
            kind: "tool_use",
            name: "mcp__browser__browser_click",
            input: { element: "Submit order", target: submitOrderRef(body) },
          };
        },
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: "m2-browser-approval-fake",
        defaultModel: "fake-model",
        cheapModel: "fake-cheap",
        label: "m2-browser-approval",
        shortWaitSeconds: 1,
      });
      stack.config.browserSnapshotMode = snapshotMode;
    }, 120_000);

    afterAll(async () => {
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it("resumes the approved action in the same target exactly once and leaves the peer target untouched", async () => {
      const s = stack as Stack;
      const peerBot = await s.api<{
        bot: BotDefinition;
        privateChat: Thread;
        welcomeRun: { id: string };
      }>("POST", "/api/bots", {
        name: "b2-peer",
        role: "peer tab sentinel",
        workspaceId: s.workspace.id,
      });
      expect(peerBot.status).toBe(201);
      s.app.deskmates.scheduler.cancel(
        peerBot.json.welcomeRun.id as import("@deskmates/contracts").RunId,
        "test",
      );
      await s.app.deskmates.scheduler.drain();
      const peerStarted = await postMessage(s, PEER_PROMPT, peerBot.json.privateChat.id);
      const peerFinal = await waitForRun(s, peerStarted.run.id, RUN_TIMEOUT_MS);
      expect(peerFinal.status, peerFinal.error).toBe("succeeded");
      const peerEvents = await runEvents(s, peerStarted.run.id);
      const peerTabId = acquiredTabIds(peerEvents, 1)[0];
      expect(peerTabId).toBeTruthy();

      const before = await siteState(s);
      const { run } = await postMessage(s, APPROVAL_PROMPT);
      const parked = await waitForRun(s, run.id, RUN_TIMEOUT_MS);
      expect(parked.status, parked.error).toBe("waiting_approval");
      expect(parked.attempt).toBe(1);
      const pending = (await pendingApprovals(s)).find((approval) => approval.runId === run.id);
      expect(pending, "the parked browser action has a pending approval").toBeDefined();
      const approval = pending as Approval;
      expect(approval.waitMode).toBe("deferred");
      expect(approval.action.toolName).toMatch(/browser_click$/);
      expect(approval.action.argumentPattern).toBe("*submit*");

      const parkedEvents = await runEvents(s, run.id);
      const parkedTabId = acquiredTabIds(parkedEvents, 1)[0];
      expect(parkedTabId).toBeTruthy();
      expect(parkedTabId).not.toBe(peerTabId);
      const targetsWhileParked = await cdpTargets(s);
      const peerWhileParked = targetsWhileParked.find((target) => target.id === peerTabId);
      const runWhileParked = targetsWhileParked.find((target) => target.id === parkedTabId);
      expect(peerWhileParked?.url).toContain(PEER_QUERY);
      expect(runWhileParked?.url).toContain("/checkout");

      await decideApproval(s, approval.id, "allow_once");
      const final = await waitForRunEnd(s, run.id, RUN_TIMEOUT_MS).catch(async (error) => {
        const diagnosticEvents = await runEvents(s, run.id);
        const approvals = await pendingApprovals(s);
        console.error(
          JSON.stringify(
            {
              error: String(error),
              approvals: approvals.filter((item) => item.runId === run.id),
              events: diagnosticEvents.filter(
                (event) =>
                  event.kind === "approval" ||
                  event.kind === "tool_call" ||
                  event.kind === "tool_result" ||
                  (event.kind === "log" && event.payload.source === "browser_lock"),
              ),
            },
            null,
            2,
          ),
        );
        throw error;
      });
      expect(final.status, final.error).toBe("succeeded");
      expect(final.attempt).toBe(2);

      const after = await siteState(s);
      expect(orderIds(after)).toEqual([...orderIds(before), expect.any(String)]);
      expect(Object.keys(after.orders)).toHaveLength(Object.keys(before.orders).length + 1);

      const events = await runEvents(s, run.id);
      const resumedTabIds = acquiredTabIds(events, 2);
      expect(resumedTabIds).toContain(parkedTabId);
      expect(new Set([...acquiredTabIds(events, 1), ...resumedTabIds])).toEqual(
        new Set([parkedTabId]),
      );
      const retried = events.filter(
        (event) =>
          event.kind === "approval" &&
          event.payload.phase === "resumed" &&
          event.payload.consumedBy === "retry",
      );
      expect(retried).toHaveLength(1);
      expect((await pendingApprovals(s)).filter((item) => item.runId === run.id)).toEqual([]);

      const targetsAfter = await cdpTargets(s);
      const peerAfter = targetsAfter.find((target) => target.id === peerTabId);
      expect(peerAfter).toEqual(peerWhileParked);
      expect(targetsAfter.find((target) => target.id === parkedTabId)?.url).toContain(
        "/checkout?placed=",
      );
    }, 180_000);
  },
);
