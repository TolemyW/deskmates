// The learned-memory services one Gateway process owns (ADR-0011): entry and confirmation stores,
// the consolidation scheduler hook, and the human rule text the classifier checks against.

import type { BotId, RunId, ThreadId, WorkspaceId } from "@deskmates/contracts";
import type { ApprovalRuleStore } from "../approvals/rules.js";
import type { BotStore } from "../bots/bots.js";
import type { GatewayDb } from "../db/open.js";
import type { RunStore } from "../ledger/runs.js";
import type { WorkspaceStore } from "../workspaces/workspaces.js";
import { ConfirmationStore } from "./confirmations.js";
import { ConsolidationService } from "./consolidation.js";
import { MemoryEntryStore } from "./entries.js";
import { MemoryFreshness } from "./freshness.js";
import { type IndexScope, pinnedIndexFor } from "./index.js";
import type { MemoryStores } from "./learned-writes.js";
import { backfillFactKeys } from "./recency.js";
import { RunMemorySupply } from "./supplied.js";

export interface LearnedMemoryDeps {
  db: GatewayDb;
  runs: RunStore;
  bots: BotStore;
  rules: ApprovalRuleStore;
  workspaces: WorkspaceStore;
  runConfig: () => Record<string, unknown>;
  /** `CHEAP_MODEL`, read when a consolidation is created (ADR-0023 decision 2). */
  cheapModel: () => string;
}

export class LearnedMemory {
  readonly entries: MemoryEntryStore;
  readonly confirmations: ConfirmationStore;
  readonly consolidation: ConsolidationService;
  readonly supplied: RunMemorySupply;
  /** "Needs revalidation" (amendment 4, A26 and A27). */
  readonly freshness: MemoryFreshness;

  constructor(private readonly deps: LearnedMemoryDeps) {
    this.entries = new MemoryEntryStore(deps.db);
    this.confirmations = new ConfirmationStore(deps.db);
    this.supplied = new RunMemorySupply(deps.db);
    this.freshness = new MemoryFreshness(deps.db, this.entries);
    this.consolidation = new ConsolidationService({
      db: deps.db,
      runs: deps.runs,
      stores: this.stores,
      workspaceOf: (botId) => deps.bots.mustGet(botId).workspaceId,
      runConfig: deps.runConfig,
      cheapModelOf: (botId) => deps.bots.mustGet(botId).cheapModel ?? deps.cheapModel(),
    });
  }

  get stores(): MemoryStores {
    return { entries: this.entries, confirmations: this.confirmations };
  }

  /**
   * Human rule text a learned item must not contradict: canonical SOUL lines, approval rules and
   * the workspace's egress entries. This checks text consistency; it does not grant bot-level ACLs.
   */
  rulesFor(botId: BotId): string[] {
    const bot = this.deps.bots.mustGet(botId);
    const soul =
      this.deps.bots
        .canonicalSoul(botId)
        ?.body.split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*#]+|\d+[.)])\s*/, "").trim())
        .filter(Boolean) ?? [];
    const approval = this.deps.rules.list(botId).map((rule) => {
      const m = rule.matcher;
      return [
        rule.decision === "deny" ? "Never" : "Always allow",
        m.toolName ?? "",
        m.targetOrigin ?? "",
        m.argumentPattern ?? "",
      ]
        .join(" ")
        .trim();
    });
    const egress = this.deps.workspaces
      .mustGet(bot.workspaceId)
      .egressAllowlist.map((host) => `Egress allowlist entry ${host}`);
    return [...soul, ...approval, ...egress];
  }

  indexFor(workspaceId: WorkspaceId, botId: BotId, threadId?: ThreadId, now?: Date) {
    const scope: IndexScope = { workspaceId, botId, ...(threadId ? { threadId } : {}) };
    // Notes written before amendment 2 get their fact key first, so no fact pins two values.
    backfillFactKeys(this.entries, workspaceId, now);
    return pinnedIndexFor(this.entries, scope, now);
  }

  /** The pinned index a run starts with, recorded as supplied to it (A13). */
  indexForRun(runId: RunId, workspaceId: WorkspaceId, botId: BotId, threadId?: ThreadId) {
    const index = this.indexFor(workspaceId, botId, threadId);
    this.supplied.record(workspaceId, runId, index.versionSet, "pinned", index.assembledAt);
    return index;
  }
}
