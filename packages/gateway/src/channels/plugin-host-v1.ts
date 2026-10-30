// The ABI-1 plugin-wide host (ADR-0017 amendment 1), kept for ABI-1 plugins until they move. Its
// calls behave as before for the plugin's own work. ADR-0047 decision 9 narrows it to what the old
// contract can express: workspaces where this plugin has a connection, and never an ABI-2
// connection's thread or approval.

import {
  type ApprovalId,
  type ChannelPluginHost,
  DeskmatesError,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { ApprovalStore } from "../approvals/approvals.js";
import type { ApprovalBroker } from "../approvals/broker.js";
import type { BotStore } from "../bots/bots.js";
import type { EventBus } from "../events/bus.js";
import type { Ownership } from "../tenancy/ownership.js";
import type { TenantQuotas } from "../tenancy/quotas.js";
import type { MessageStore } from "../threads/messages.js";
import type { ThreadRouter } from "../threads/router.js";
import type { ThreadStore } from "../threads/threads.js";
import type { ChannelStore } from "./channel-store.js";

export interface PluginHostV1Deps {
  store: ChannelStore;
  threads: ThreadStore;
  messages: MessageStore;
  router: ThreadRouter;
  approvals: ApprovalStore;
  broker: ApprovalBroker;
  bots: BotStore;
  ownership: Ownership;
  quotas: TenantQuotas;
  bus: EventBus;
  kick(): void;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

function outside(): DeskmatesError {
  return new DeskmatesError("not_found", "not reachable from this channel plugin");
}

export function createPluginHostV1(pluginId: string, deps: PluginHostV1Deps): ChannelPluginHost {
  const reaches = (workspaceId: string): boolean =>
    deps.store.workspacesOf(pluginId).has(workspaceId);
  const reachable = (thread: Thread | undefined): thread is Thread =>
    thread !== undefined && thread.bindingGeneration === undefined && reaches(thread.workspaceId);
  const thread = (id: string): Thread => {
    const found = deps.threads.get(id as ThreadId);
    if (!reachable(found)) throw outside();
    return found;
  };
  const workspace = (workspaceId: WorkspaceId): WorkspaceId => {
    if (!reaches(workspaceId)) throw outside();
    return workspaceId;
  };
  const approvalReachable = (id: string) => {
    const approval = deps.approvals.get(id as ApprovalId);
    if (!approval) return undefined;
    if (approval.threadId)
      return reachable(deps.threads.get(approval.threadId)) ? approval : undefined;
    const bot = deps.bots.get(approval.botId);
    return bot && reaches(bot.workspaceId) ? approval : undefined;
  };
  return {
    findThread: async (workspaceId, channel, externalKey) =>
      deps.threads.findByExternalKey(workspace(workspaceId), channel, externalKey),
    createThread: async (input) => {
      const existing = deps.threads.findByExternalKey(
        workspace(input.workspaceId),
        input.channel,
        input.externalKey,
      );
      if (existing) return existing;
      const created = deps.threads.create({
        workspaceId: input.workspaceId,
        botIds: [input.botId],
        channel: input.channel,
        externalKey: input.externalKey,
        title: input.title,
      });
      deps.bus.publish({ type: "thread_members", threadId: created.id });
      return created;
    },
    getThread: async (id) => {
      const found = thread(id);
      return { thread: found, members: deps.threads.members(found.id) };
    },
    postHumanMessage: async (input) => {
      const threadId = thread(input.threadId).id;
      const target = deps.threads.mustGet(threadId);
      const tenantId = deps.ownership.tenantOf("workspace", target.workspaceId);
      if (tenantId) deps.quotas.assertQueueRoom(tenantId);
      const result = deps.router.postHuman({
        threadId,
        body: input.body,
        authorId: input.authorId,
        externalId: input.externalId,
      });
      if (!result.duplicate) {
        deps.bus.publish({ type: "thread_message", threadId, message: result.message });
        for (const run of result.runs) deps.bus.publish({ type: "run_status", threadId, run });
        deps.kick();
      }
      return result;
    },
    listMessages: async (threadId, afterSeq) => deps.messages.list(thread(threadId).id, afterSeq),
    getApproval: async (id) => approvalReachable(id),
    decideApproval: async (input) => {
      if (!approvalReachable(input.id)) throw outside();
      const result = deps.broker.decide(
        input.id as ApprovalId,
        input.decision,
        decidedByHuman(input.authorId),
        input.reason,
      );
      deps.kick();
      return result.approval;
    },
    subscribe: async (handlers, signal) => {
      await handlers.onOpen();
      const seen = new Map<string, boolean>();
      const unsubscribe = deps.bus.subscribe((event) => {
        const threadId = (event as { threadId?: unknown }).threadId;
        if (typeof threadId !== "string") return;
        let mine = seen.get(threadId);
        if (mine === undefined) {
          mine = reachable(deps.threads.get(threadId as ThreadId));
          // Only a positive answer is final: a workspace may connect this plugin later.
          if (mine) seen.set(threadId, mine);
        }
        if (mine) void handlers.onFrame(event);
      });
      if (signal.aborted) unsubscribe();
      else
        await new Promise<void>((done) =>
          signal.addEventListener(
            "abort",
            () => {
              unsubscribe();
              done();
            },
            { once: true },
          ),
        );
    },
    log: deps.log,
  };
}
