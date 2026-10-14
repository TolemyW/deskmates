// Task state ends as an episode (ADR-0011 decision 11). Closing a thread's task distils its open
// task notes into one searchable episode entry and marks them, so no later run's index carries
// them. The distillation is deterministic text assembly: the Gateway never calls a model. The
// episode keeps the minimum trust of its sources and is the input of consolidation.

import type { MemoryTrust, ThreadId, WorkspaceId } from "@deskmates/contracts";
import type { MemoryEntryStore, StoredEntry } from "./entries.js";

/** Upper bound on an episode body; later notes are counted, not copied, past it. */
export const EPISODE_MAX_CHARS = 4000;

export interface ClosedTask {
  episode?: StoredEntry;
  distilled: string[];
}

export function closeThreadTask(
  store: MemoryEntryStore,
  thread: { id: ThreadId; workspaceId: WorkspaceId; title: string },
  by: string,
  now: Date = new Date(),
): ClosedTask {
  const notes = store.openTaskNotes(thread.id);
  if (notes.length === 0) return { distilled: [] };
  const first = notes[0]?.observedAt.slice(0, 10) ?? "";
  const last = notes.at(-1)?.observedAt.slice(0, 10) ?? "";
  const lines = [`Episode: ${thread.title} (${first} to ${last}), ${notes.length} task notes`];
  let used = lines[0]?.length ?? 0;
  let omitted = 0;
  for (const note of notes) {
    const line = `- ${note.body.replace(/\s+/g, " ")}`;
    if (used + line.length + 1 > EPISODE_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) lines.push(`(${omitted} more notes not copied)`);
  const trust: MemoryTrust = notes.every((note) => note.trust === "trusted")
    ? "trusted"
    : "untrusted";
  const episode = store.db.transaction(() => {
    const created = store.insert({
      workspaceId: thread.workspaceId,
      scope: "task",
      kind: "episode",
      threadId: thread.id,
      body: lines.join("\n"),
      authority: "fact",
      trust,
      sourceKind: trust === "trusted" ? "bot_self" : "tool",
      derivedFrom: notes.map((note) => note.id),
      observedAt: now.toISOString(),
      by,
    });
    store.setEpisode(
      notes.map((note) => note.id),
      created.id,
    );
    return created;
  })();
  return { episode, distilled: notes.map((note) => note.id) };
}
