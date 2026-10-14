// The pinned index a run receives in its first user turn (ADR-0011 decision 9): this workspace's
// facts, this bot's experience and this thread's task state, within the line budgets. The
// assembly itself is the pure contracts function, so trace replay rebuilds the same index from the
// version set recorded in `runs.config_json` (decision 12).

import {
  type BotId,
  DEFAULT_MEMORY_INDEX_BUDGETS,
  type MemoryIndexBudgets,
  type PinnedMemoryIndex,
  type ThreadId,
  type WorkspaceId,
  assemblePinnedIndex,
} from "@deskmates/contracts";
import type { MemoryEntryStore } from "./entries.js";

export interface IndexScope {
  workspaceId: WorkspaceId;
  botId: BotId;
  threadId?: ThreadId;
}

export function pinnedIndexFor(
  store: MemoryEntryStore,
  scope: IndexScope,
  now: Date = new Date(),
  budgets: MemoryIndexBudgets = DEFAULT_MEMORY_INDEX_BUDGETS,
): PinnedMemoryIndex {
  return assemblePinnedIndex(
    store.pinCandidates(scope.workspaceId, scope.botId, scope.threadId),
    now,
    budgets,
  );
}

/** What `runs.config_json` records of the index (decision 12): enough to rebuild it exactly. */
export function indexConfig(index: PinnedMemoryIndex): Record<string, unknown> {
  return {
    indexVersion: index.version,
    assembledAt: index.assembledAt,
    budgets: { ...index.budgets },
    versionSet: index.versionSet.map((ref) => ({ ...ref })),
    lines: index.lines,
    counts: { ...index.counts },
  };
}
