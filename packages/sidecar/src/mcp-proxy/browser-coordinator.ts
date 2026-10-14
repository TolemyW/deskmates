// Coordinates the actual selected MCP page immediately before execution. Approval and egress
// decisions remain in PreToolUse. Tab leases are correctness coordination, not permissions.
import { type BrowserOriginResponse, HUMAN_HOLDS_BROWSER_MESSAGE } from "@deskmates/contracts";
import {
  type BrowserCoordinationConfig,
  type BrowserState,
  type BrowserTab,
  parseBrowserState,
} from "../browser-state.js";
import type { GatewayClient } from "../gateway-client.js";
import { waitForBrowserOrigin } from "../origin-wait.js";
import { prepareBrowserCapture } from "./browser-capture-focus.js";
import { prepareBrowserFocus } from "./browser-focus.js";
import { desktopWindowCode } from "./desktop-window.js";
import type { TimingRecorder } from "./timing.js";

export interface BrowserCall {
  name: string;
  arguments: Record<string, unknown>;
}
export type BrowserRpc = (call: BrowserCall) => Promise<unknown>;
export interface BrowserCoordination {
  before(call: BrowserCall, rpc: BrowserRpc, parentSpanId?: string): Promise<BrowserCall>;
  after(call: BrowserCall, rpc: BrowserRpc, result?: unknown): Promise<void>;
  canCapture(rpc: BrowserRpc): Promise<boolean>;
  /** Prepare only the pre-screenshot fence; ordinary result/snapshot fences never move focus. */
  prepareCapture?(rpc: BrowserRpc): Promise<boolean>;
  tabId(): string | undefined;
  /** The page identity established by the most recent successful live capture fence. */
  verifiedPage?(): { tabId: string; url: string; epoch: number } | undefined;
  epoch(): number;
  contextKey?(): string;
  onError?(): Promise<void>;
  cancel?(): void;
}
export interface CoordinatorDeps {
  read(): Promise<string | undefined>;
  write(state: BrowserState): Promise<void>;
  client: Pick<GatewayClient, "browserLock" | "browserOrigin">;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timing?: TimingRecorder;
}

function originOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}
// The pinned image shim adds host-generated stable IDs to browser_tabs list. Unlike a
// page-code RPC, that handler can inspect the SAME MCP session while a chooser is pending.
// Unpatched/malformed responses fail closed; never infer identity from titles/URLs/indices.

/**
 * Tools MCP 0.0.82 runs only while their modal is pending (`clearsModalState`); every other tab
 * tool, including the browser_run_code_unsafe focus preparation, is rejected in that state. They
 * act on the modal, not the page, so they need no page focus.
 */
export const MODAL_CLEARING_TOOLS: ReadonlySet<string> = new Set([
  "browser_file_upload",
  "browser_handle_dialog",
]);

/**
 * Remove the image shim's stable-identity line from a browser_tabs result before it reaches the
 * model, so model context stays MCP's own output (a change there is a strategy change). Only a
 * line that parses as the shim's `{"tabs":[...]}` right after `### Result` is removed.
 */
export function stripTabIdentity(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return result;
  const content = record.content.map((item: unknown) => {
    const block = item as { type?: unknown; text?: unknown } | null;
    if (block?.type !== "text" || typeof block.text !== "string") return item;
    const text = block.text.replace(
      /^(### Result\n)(\{"tabs":\[[^\n]*\})\n/m,
      (line, head, json) => {
        try {
          probeTabs({ content: [{ type: "text", text: `### Result\n${json}` }] });
          return head;
        } catch {
          return line;
        }
      },
    );
    return text === block.text ? item : { ...block, text };
  });
  return { ...record, content };
}

export function probeTabs(result: unknown): BrowserTab[] {
  const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type !== "text" || !block.text) continue;
    const match = /^### Result\n([^\n]+)(?:\n|$)/m.exec(block.text);
    if (!match?.[1]) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const tabs = (parsed as { tabs?: BrowserTab[] })?.tabs;
    if (
      Array.isArray(tabs) &&
      tabs.length &&
      tabs.every(
        (t) =>
          t &&
          typeof t.id === "string" &&
          t.id.length > 0 &&
          typeof t.url === "string" &&
          typeof t.current === "boolean",
      ) &&
      new Set(tabs.map((t) => t.id)).size === tabs.length &&
      tabs.filter((t) => t.current).length === 1
    )
      return tabs;
  }
  throw new Error(
    "Browser tab identity unavailable. No recovery action was dispatched. Stop this run and request a fresh browser session; verify the workspace image has the pinned tab-identity shim. Do not blindly retry an upload: the previous action may have completed.",
  );
}

export class BrowserCoordinator implements BrowserCoordination {
  private state: BrowserState;
  private loaded = false;
  private initialized = false;
  private closedCurrent = false;
  private selectedTarget: string | undefined;
  private knownTargets = new Set<string>();
  private controlEpoch = 0;
  private leasedOrigin: string | undefined;
  private lastVerifiedPage: { tabId: string; url: string; epoch: number } | undefined;
  /** Sticky until a fresh `before` admission succeeds; later capture checks must fail closed. */
  private originFenceLost = false;
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  constructor(
    private readonly config: BrowserCoordinationConfig,
    private readonly deps: CoordinatorDeps,
  ) {
    this.state = { version: 1, runId: config.runId, tabs: [] };
    this.signal = deps.signal
      ? AbortSignal.any([deps.signal, this.abort.signal])
      : this.abort.signal;
  }
  cancel(): void {
    this.abort.abort();
    void this.releaseOrigin().catch(() => undefined);
  }
  tabId(): string | undefined {
    return this.state.tabId;
  }
  verifiedPage(): { tabId: string; url: string; epoch: number } | undefined {
    return this.lastVerifiedPage;
  }
  epoch(): number {
    return this.controlEpoch;
  }
  contextKey(): string {
    const url = this.state.tabs.find((tab) => tab.id === this.state.tabId)?.url;
    let origin: string | undefined;
    try {
      origin = url ? new URL(url).origin : undefined;
    } catch {}
    return JSON.stringify([this.state.tabId, origin]);
  }
  private async lock(tabId?: string): Promise<void> {
    const result = await this.deps.client.browserLock({
      type: "browser_lock",
      runId: this.config.runId,
      op: "acquire",
      ...(tabId ? { tabId } : {}),
    });
    this.controlEpoch = result.epoch ?? 0;
    if (!result.granted) throw new Error(result.waitMessage ?? HUMAN_HOLDS_BROWSER_MESSAGE);
  }
  private originV2(): boolean {
    return this.config.mode === "origin-v2" && typeof this.config.deadlineAt === "string";
  }
  async onError(): Promise<void> {
    await this.releaseOrigin();
  }
  private async releaseOrigin(): Promise<void> {
    const origin = this.leasedOrigin;
    if (!origin || !this.originV2()) return;
    this.leasedOrigin = undefined;
    const response = await this.deps.client.browserOrigin(
      { type: "browser_origin", runId: this.config.runId, op: "release", origin },
      this.signal.aborted ? undefined : this.signal,
    );
    if (!response.granted)
      throw new Error("Browser origin lease could not be released; no action was dispatched.");
  }
  private async acquireOrigin(origin: string | undefined, parentSpanId?: string): Promise<void> {
    if (!this.originV2()) return;
    if (!origin) {
      await this.releaseOrigin();
      return;
    }
    if (this.leasedOrigin === origin) {
      const renewed = await this.deps.client.browserOrigin(
        { type: "browser_origin", runId: this.config.runId, op: "renew", origin },
        this.signal,
      );
      if (renewed.granted) {
        this.originFenceLost = false;
        return;
      }
      this.leasedOrigin = undefined;
      this.originFenceLost = true;
      if (renewed.waitReason === "human") throw new Error(HUMAN_HOLDS_BROWSER_MESSAGE);
      if (renewed.waitReason !== "lease_lost")
        throw new Error("Browser origin renewal failed; inspect the page before retrying.");
    } else if (this.leasedOrigin) {
      // Never hold one origin while queueing for another.
      await this.releaseOrigin();
    }
    let waitSpan: ReturnType<TimingRecorder["start"]> | undefined;
    try {
      waitSpan = this.deps.timing?.start("origin_wait", {
        ...(parentSpanId ? { parentSpanId } : {}),
      });
    } catch {}
    const endWait = (outcome: "ok" | "error" | "cancelled") => {
      try {
        waitSpan?.end(outcome);
      } catch {}
    };
    let response: BrowserOriginResponse;
    try {
      response = await waitForBrowserOrigin(origin, {
        client: this.deps.client,
        runId: this.config.runId,
        deadlineAt: this.config.deadlineAt as string,
        signal: this.signal,
        ...(this.deps.now ? { now: this.deps.now } : {}),
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      });
      endWait(response.granted ? "ok" : "error");
    } catch (error) {
      endWait(this.signal.aborted ? "cancelled" : "error");
      throw error;
    }
    if (!response.granted) {
      if (response.waitReason === "human") throw new Error(HUMAN_HOLDS_BROWSER_MESSAGE);
      throw new Error(
        response.waitReason === "lease_lost"
          ? "Browser origin lease was lost; inspect the page before retrying."
          : "Browser origin admission failed; no action was dispatched.",
      );
    }
    this.leasedOrigin = response.origin ?? origin;
    this.originFenceLost = false;
  }
  private async originStillGranted(): Promise<boolean> {
    if (!this.originV2()) return true;
    if (this.originFenceLost) return false;
    if (!this.leasedOrigin) return true;
    try {
      const response = await this.deps.client.browserOrigin(
        {
          type: "browser_origin",
          runId: this.config.runId,
          op: "renew",
          origin: this.leasedOrigin,
        },
        this.signal,
      );
      if (response.granted) return true;
      this.leasedOrigin = undefined;
      this.originFenceLost = true;
      return false;
    } catch {
      this.originFenceLost = true;
      return false;
    }
  }
  async canCapture(rpc: BrowserRpc): Promise<boolean> {
    this.lastVerifiedPage = undefined;
    if (!this.state.tabId) return false;
    try {
      if (!(await this.originStillGranted())) return false;
      await this.lock(this.state.tabId);
      // MCP silently selects a fallback page if the run tab closes during an action/capture.
      // A lease alone cannot prove which page the screenshot RPC actually read.
      const tabs = await this.probe(rpc);
      const current = tabs.find((tab) => tab.current);
      if (current?.id !== this.state.tabId) return false;
      if (!this.originV2()) {
        if (this.config.snapshotMode === "inline-v2") await this.lock(this.state.tabId);
        this.lastVerifiedPage = {
          tabId: current.id,
          url: current.url,
          epoch: this.controlEpoch,
        };
        return true;
      }
      if (this.leasedOrigin && originOf(current.url) !== this.leasedOrigin) {
        await this.releaseOrigin().catch(() => undefined);
        this.originFenceLost = true;
        return false;
      }
      // The identity probe itself can run for up to 90 s. Revalidate before capture dispatch.
      if (!(await this.originStillGranted())) return false;
      await this.lock(this.state.tabId);
      this.lastVerifiedPage = {
        tabId: current.id,
        url: current.url,
        epoch: this.controlEpoch,
      };
      return true;
    } catch {
      return false;
    }
  }
  async prepareCapture(rpc: BrowserRpc): Promise<boolean> {
    try {
      if (!(await this.canCapture(rpc))) return false;
      const expected = this.lastVerifiedPage;
      if (!expected) return false;
      // The identity probe can outlive a take/handback cycle. Recheck before changing
      // physical foreground, then fence again before the screenshot is dispatched.
      if (!(await this.originStillGranted())) {
        this.lastVerifiedPage = undefined;
        return false;
      }
      await this.lock(expected.tabId);
      if (this.controlEpoch !== expected.epoch) {
        this.lastVerifiedPage = undefined;
        return false;
      }
      await prepareBrowserCapture(rpc, expected);
      if (!(await this.canCapture(rpc))) return false;
      if (!(await this.originStillGranted())) {
        this.lastVerifiedPage = undefined;
        return false;
      }
      await this.lock(expected.tabId);
      const actual = this.lastVerifiedPage;
      if (
        actual?.tabId !== expected.tabId ||
        actual.url !== expected.url ||
        actual.epoch !== expected.epoch ||
        this.controlEpoch !== expected.epoch
      ) {
        this.lastVerifiedPage = undefined;
        return false;
      }
      return true;
    } catch {
      this.lastVerifiedPage = undefined;
      return false;
    }
  }
  private async probe(rpc: BrowserRpc): Promise<BrowserTab[]> {
    return probeTabs(await rpc({ name: "browser_tabs", arguments: { action: "list" } }));
  }
  private async save(tabs: BrowserTab[]): Promise<void> {
    const tabId = tabs.find((t) => t.current)?.id;
    this.state = { version: 1, runId: this.config.runId, tabs, ...(tabId ? { tabId } : {}) };
    await this.deps.write(this.state);
  }
  private async fresh(rpc: BrowserRpc): Promise<BrowserTab[]> {
    await this.lock();
    const previous = new Set((await this.probe(rpc)).map((tab) => tab.id));
    let created: unknown;
    if (this.config.screenSlot !== undefined) {
      // Host-authored CDP setup: new top-level window, same browser context/profile.
      created = await rpc({
        name: "browser_run_code_unsafe",
        arguments: {
          code: desktopWindowCode(this.config.screenSlot),
        },
      });
      if (!(created as { isError?: boolean })?.isError) {
        const blocks = (created as { content?: { text?: string }[] }).content ?? [];
        const match = blocks
          .map((block) => block.text ?? "")
          .map((text) => /^### Result\n([^\n]+)/m.exec(text))
          .find(Boolean);
        const targetId: unknown = match?.[1]
          ? (JSON.parse(match[1]) as { targetId?: unknown }).targetId
          : undefined;
        if (typeof targetId !== "string") throw new Error("Desktop target identity missing");
        let found: BrowserTab | undefined;
        let all: BrowserTab[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          all = await this.probe(rpc);
          found = all.find((tab) => tab.id === targetId && !previous.has(tab.id));
          if (found) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!found) throw new Error("Desktop window did not become available");
        created = await rpc({
          name: "browser_tabs",
          arguments: { action: "select", index: all.findIndex((tab) => tab.id === found?.id) },
        });
      }
    } else {
      created = await rpc({ name: "browser_tabs", arguments: { action: "new" } });
    }
    if ((created as { isError?: boolean })?.isError)
      throw new Error("Could not create this run’s browser tab; no action was dispatched.");
    const tabs = await this.probe(rpc);
    const current = tabs.find((t) => t.current);
    if (!current || previous.has(current.id))
      throw new Error("A new browser target could not be verified; no action was dispatched.");
    await this.lock(current.id);
    await this.save(tabs);
    return tabs;
  }
  async before(call: BrowserCall, rpc: BrowserRpc, parentSpanId?: string): Promise<BrowserCall> {
    // No internal page probe, creation or selection while a human already holds the browser.
    await this.lock();
    if (!this.loaded) {
      const saved = await this.deps.read();
      this.state = (saved && parseBrowserState(saved, this.config.runId)) || this.state;
      this.loaded = true;
    }
    let tabs: BrowserTab[];
    if (!this.state.tabId) tabs = await this.fresh(rpc);
    else {
      tabs = await this.probe(rpc);
      const index = tabs.findIndex((t) => t.id === this.state.tabId);
      if (index < 0) {
        await this.fresh(rpc);
        this.initialized = true;
        throw new Error(
          "This run's tab was closed. A fresh tab was opened; navigate or inspect it before retrying the action.",
        );
      }
      const previous = this.state.tabs.find((t) => t.id === this.state.tabId);
      const live = tabs[index];
      const origin = (url: string) => {
        try {
          return new URL(url).origin;
        } catch {
          return undefined;
        }
      };
      if (previous && live && origin(previous.url) !== origin(live.url)) {
        // A redirect that escaped the previous call's post-check must not retain the old
        // origin while this run asks the model to inspect the new page.
        await this.releaseOrigin();
        // Refresh metadata for the next PreToolUse approval decision without dispatching this call.
        this.state.tabs = tabs.map((tab) => ({ ...tab, current: tab.id === this.state.tabId }));
        await this.deps.write(this.state);
        throw new Error(
          "The page origin changed outside this run. Inspect the page before retrying; approvals must use its current origin.",
        );
      }
      if (!this.initialized || !tabs[index]?.current) {
        await this.lock(this.state.tabId);
        const selected = await rpc({
          name: "browser_tabs",
          arguments: { action: "select", index },
        });
        if ((selected as { isError?: boolean })?.isError)
          throw new Error("Could not restore this run’s browser tab; no action was dispatched.");
        tabs = await this.probe(rpc);
        if (tabs.find((tab) => tab.current)?.id !== this.state.tabId)
          throw new Error(
            "Browser selection changed while restoring this run’s tab; no action was dispatched.",
          );
      }
    }
    this.initialized = true;
    this.knownTargets = new Set(tabs.map((tab) => tab.id));
    this.closedCurrent = false;
    this.selectedTarget = undefined;
    let target = this.state.tabId;
    let dispatched = call;
    if (
      call.name === "browser_tabs" &&
      call.arguments.action === "new" &&
      this.config.screenSlot !== undefined
    ) {
      // MCP's context.newPage() may use another bot's foreground window. Create an explicit
      // window in our screen, then dispatch a selection so MCP still returns its normal snapshot.
      await this.releaseOrigin();
      tabs = await this.fresh(rpc);
      target = this.state.tabId;
      dispatched = {
        name: "browser_tabs",
        arguments: { action: "select", index: tabs.findIndex((tab) => tab.id === target) },
      };
    } else if (call.name === "browser_close") {
      dispatched = { name: "browser_tabs", arguments: { action: "close" } };
      this.closedCurrent = true;
    } else if (
      call.name === "browser_tabs" &&
      (call.arguments.action === "select" || call.arguments.action === "close")
    ) {
      const index = call.arguments.index;
      if (index !== undefined) {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
          throw new Error("Invalid browser tab index");
        // Resolve against the last view delivered to the model, then reindex in the live view.
        const requested = this.state.tabs[index];
        const liveIndex = tabs.findIndex((t) => t.id === requested?.id);
        if (!requested || liveIndex < 0)
          throw new Error("Selected tab no longer exists; list tabs again before retrying.");
        target = requested.id;
        dispatched = { ...call, arguments: { ...call.arguments, index: liveIndex } };
      }
      this.closedCurrent = call.arguments.action === "close" && target === this.state.tabId;
      if (call.arguments.action === "select") this.selectedTarget = target;
    }
    await this.lock(target);
    const explicitOrigin = originOf(call.arguments.url);
    const targetOrigin = originOf(tabs.find((tab) => tab.id === target)?.url);
    await this.acquireOrigin(explicitOrigin ?? targetOrigin, parentSpanId);
    if (!this.originV2()) {
      if (target && MODAL_CLEARING_TOOLS.has(call.name)) {
        // Focus preparation carried v1's last identity check, but MCP rejects its page-code RPC
        // while a modal is pending. Re-probe through browser_tabs, which the modal does not gate.
        const live = await this.probe(rpc);
        if (live.find((tab) => tab.current)?.id !== target)
          throw new Error(
            "The selected browser tab changed before the modal action; no action was dispatched.",
          );
        await this.lock(target);
      } else if (target && call.name !== "browser_tabs" && call.name !== "browser_close")
        await prepareBrowserFocus(rpc, target);
      return dispatched;
    }
    try {
      await this.lock(target);
      // Origin admission can queue long enough for another run or a human to close/reorder tabs.
      // Re-probe identity and remap the index from the stable target before using it.
      const admittedTabs = await this.probe(rpc);
      const admittedTarget = admittedTabs.find((tab) => tab.id === target);
      if (!admittedTarget)
        throw new Error(
          "The browser target changed while waiting for origin access; no action was dispatched.",
        );
      const tabAction = call.name === "browser_tabs" ? call.arguments.action : undefined;
      if (tabAction !== "select" && tabAction !== "close" && !admittedTarget.current)
        throw new Error(
          "The selected browser tab changed while waiting for origin access; no action was dispatched.",
        );
      if (
        !explicitOrigin &&
        this.leasedOrigin &&
        originOf(admittedTarget.url) !== this.leasedOrigin
      )
        throw new Error(
          "The page origin changed while waiting for origin access; no action was dispatched.",
        );
      if (tabAction && call.arguments.index !== undefined) {
        const admittedIndex = admittedTabs.findIndex((tab) => tab.id === target);
        dispatched = {
          ...dispatched,
          arguments: { ...dispatched.arguments, index: admittedIndex },
        };
      }
      if (!(await this.originStillGranted()))
        throw new Error(
          "Browser origin lease was lost before focus preparation; no action was dispatched.",
        );
      await this.lock(target);
      // Tab management does not perform a page action and can select/close a different target.
      // Prepare only the verified current page, never a fallback after closure or takeover.
      if (
        target &&
        call.name !== "browser_tabs" &&
        call.name !== "browser_close" &&
        !MODAL_CLEARING_TOOLS.has(call.name)
      ) {
        await prepareBrowserFocus(rpc, target);
      }
      // Focus preparation can itself run for up to 90 s. Renew both fences immediately before
      // dispatch so neither lease expiry nor takeover can race a previously granted response.
      if (!(await this.originStillGranted()))
        throw new Error(
          "Browser origin lease was lost before dispatch; inspect the page before retrying.",
        );
      await this.lock(target);
    } catch (error) {
      await this.releaseOrigin().catch(() => undefined);
      throw error;
    }
    return dispatched;
  }
  async after(call: BrowserCall, rpc: BrowserRpc, result?: unknown): Promise<void> {
    const failed = (result as { isError?: boolean })?.isError === true;
    // The browser RPC can consume most of the 120 s lease TTL (the proxy bounds it at 90 s).
    // Never interpret or capture a result once ownership has expired; the action may have run.
    if (!(await this.originStillGranted()))
      throw new Error(
        "Browser origin lease was lost during the call. The action may have completed; inspect the page before retrying.",
      );
    if (this.closedCurrent && !failed) {
      await this.releaseOrigin();
      await this.lock();
      const tabs = await this.probe(rpc);
      if (tabs.some((tab) => tab.id === this.state.tabId))
        throw new Error("The run tab is still present after close; inspect it before retrying.");
      this.state = {
        version: 1,
        runId: this.config.runId,
        tabs: tabs.map((tab) => ({ ...tab, current: false })),
      };
      await this.deps.write(this.state);
      return;
    }
    await this.lock();
    const tabs = await this.probe(rpc);
    const current = tabs.find((t) => t.current);
    if (!current) throw new Error("Browser tab disappeared during execution");
    // Only a successful explicit new/select may intentionally change the selected target.
    // A failed close must remain an error; closing another tab must not adopt a fallback page.
    const creates = call.name === "browser_tabs" && call.arguments.action === "new" && !failed;
    if (creates && this.knownTargets.has(current.id))
      throw new Error(
        "A new browser target could not be verified; inspect the selected page before retrying.",
      );
    const expected = !failed && this.selectedTarget ? this.selectedTarget : this.state.tabId;
    if (creates || current.id === expected) {
      await this.lock(current.id);
      await this.save(tabs);
    } else
      throw new Error(
        "The selected browser tab changed during execution; inspect it before continuing.",
      );
    const liveOrigin = originOf(current.url);
    if (this.originV2() && this.leasedOrigin && liveOrigin !== this.leasedOrigin) {
      await this.releaseOrigin();
      this.originFenceLost = true;
      throw new Error(
        "The page redirected to a different origin. The action may have completed; inspect the page before retrying.",
      );
    }
    if (!(await this.originStillGranted()))
      throw new Error(
        "Browser origin lease was lost while verifying the result. The action may have completed; inspect the page before retrying.",
      );
    if (failed) await this.releaseOrigin();
  }
}
