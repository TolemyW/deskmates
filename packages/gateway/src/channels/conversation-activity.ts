// Deterministic channel snapshots (ADR-0047 amendment 3), without a model call or wake.
import type { RunStatus, ThreadId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import type { EventBus } from "../events/bus.js";
import type { MessageStore } from "../threads/messages.js";

const NOTICES: Partial<Record<RunStatus, string>> = {
  failed:
    "The latest work failed. Your conversation is preserved; send a message to review or continue it.",
  cancelled: "The latest work was cancelled. Your conversation is preserved.",
  stopped: "The latest work stopped. Your conversation is preserved.",
  waiting_browser: "Work is waiting for the shared browser to become available.",
  waiting_platform:
    "Work is waiting for the platform to recover. It will continue automatically when available.",
  waiting_continuation:
    "Work needs a continuation decision. Review the pending request to continue.",
};

export function syncConversationActivity(
  db: GatewayDb,
  messages: MessageStore,
  bus: EventBus,
  threadId: ThreadId,
): { runId: string; status: RunStatus } | undefined {
  const run = db
    .prepare(
      "SELECT id, status FROM runs WHERE thread_id = ? AND trigger_kind != 'model_job' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId) as { id: string; status: RunStatus } | undefined;
  if (!run) return undefined;
  const prefix = `channel-activity:${run.id}:`;
  const previous = db
    .prepare(
      "SELECT 1 FROM thread_messages WHERE thread_id = ? AND author_kind = 'system' AND substr(external_id, 1, ?) = ? LIMIT 1",
    )
    .get(threadId, prefix.length, prefix);
  const body =
    NOTICES[run.status] ??
    (previous
      ? run.status === "running"
        ? "Work has resumed in this conversation."
        : run.status === "succeeded" || run.status === "silent"
          ? "Work has finished in this conversation."
          : undefined
      : undefined);
  const externalId = `${prefix}${run.status}`;
  if (body && !messages.findByExternalId(threadId, externalId)) {
    const message = messages.append({
      threadId,
      authorKind: "system",
      authorId: "",
      body,
      externalId,
    });
    bus.publish({ type: "thread_message", threadId, message });
  }
  return { runId: run.id, status: run.status };
}
