// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { THREAD_ID } from "../test-support/fixtures.js";
import {
  authorizeConversationDraft,
  beginConversationSubmission,
  completeConversationSubmission,
  configureConversationDrafts,
  failConversationSubmission,
  readConversationComposer,
  writeConversationDraft,
} from "./conversation-drafts.js";
import {
  DRAFT_STORAGE_KEY,
  DRAFT_TTL_MS,
  DRAFT_WRITE_DELAY_MS,
  flushStoredDrafts,
  prepareStoredDrafts,
  restoreStoredDraft,
  storeDraft,
} from "./draft-storage.js";
const scope = { userId: "alice", tenantId: "team-a", authenticatedAt: "2026-10-12T08:00:00Z" };
afterEach(() => {
  flushStoredDrafts();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("restores after reload only after an authorized thread/workspace match", () => {
  const first = {} as ApiClient;
  configureConversationDrafts(first, scope);
  authorizeConversationDraft(first, THREAD_ID, "workspace-a");
  writeConversationDraft(first, THREAD_ID, "private draft");
  const reloaded = {} as ApiClient;
  configureConversationDrafts(reloaded, scope);
  expect(readConversationComposer(reloaded, THREAD_ID).draft.body).toBe("");
  authorizeConversationDraft(reloaded, THREAD_ID, "workspace-a");
  expect(readConversationComposer(reloaded, THREAD_ID).draft.body).toBe("private draft");
  expect(restoreStoredDraft(scope, "workspace-b", THREAD_ID)).toBeUndefined();
  expect(restoreStoredDraft(scope, "workspace-a", "other-chat")).toBeUndefined();
});
it.each([
  { ...scope, userId: "bob" },
  { ...scope, tenantId: "team-b" },
  { ...scope, authenticatedAt: "new-session" },
])("discards another user, tenant or authentication lifetime before restoring: %j", (other) => {
  storeDraft(scope, "ws", "chat", "Alice text");
  prepareStoredDrafts(other);
  expect(restoreStoredDraft(other, "ws", "chat")).toBeUndefined();
  expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
});
it("clears on real teardown and prevents an old callback from rewriting a signed-out draft", async () => {
  const api = {} as ApiClient;
  const leave = configureConversationDrafts(api, scope);
  authorizeConversationDraft(api, THREAD_ID, "ws");
  writeConversationDraft(api, THREAD_ID, "secret");
  leave();
  await Promise.resolve();
  writeConversationDraft(api, THREAD_ID, "late callback");
  expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
});
it("does not purge reload recovery during StrictMode's immediate effect replay", async () => {
  storeDraft(scope, "ws", THREAD_ID, "survives");
  const api = {} as ApiClient;
  const detach = configureConversationDrafts(api, scope);
  detach();
  configureConversationDrafts(api, scope);
  await Promise.resolve();
  authorizeConversationDraft(api, THREAD_ID, "ws");
  expect(readConversationComposer(api, THREAD_ID).draft.body).toBe("survives");
});
it("removes submitted text before a reload and never clears text typed during an earlier send", () => {
  const api = {} as ApiClient;
  configureConversationDrafts(api, scope);
  authorizeConversationDraft(api, THREAD_ID, "ws");
  const draft = writeConversationDraft(api, THREAD_ID, "sent");
  const pending = beginConversationSubmission(api, THREAD_ID, draft.draft.revision);
  expect(restoreStoredDraft(scope, "ws", THREAD_ID)).toBeUndefined();
  writeConversationDraft(api, THREAD_ID, "newer unsent text");
  completeConversationSubmission(api, THREAD_ID, pending.pending?.id ?? -1);
  expect(restoreStoredDraft(scope, "ws", THREAD_ID)).toBe("newer unsent text");
});
it("expires, bounds and rejects malformed/legacy storage without truncating a live draft", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T08:00:00Z"));
  storeDraft(scope, "ws", "chat", "expired");
  vi.advanceTimersByTime(DRAFT_TTL_MS);
  expect(restoreStoredDraft(scope, "ws", "chat")).toBeUndefined();
  storeDraft(scope, "ws", "chat", "x".repeat(32769));
  expect(restoreStoredDraft(scope, "ws", "chat")).toBeUndefined();
  for (let i = 0; i < 25; i++) storeDraft(scope, "ws", String(i), "x".repeat(16000));
  expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)?.length).toBeLessThanOrEqual(131072);
  expect(restoreStoredDraft(scope, "ws", "0")).toBeUndefined();
  for (const raw of ["{invalid", JSON.stringify({ draft: "unscoped legacy" })]) {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, raw);
    prepareStoredDrafts(scope);
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  }
});
it("continues in memory if storage reads and writes throw", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const api = {} as ApiClient;
  configureConversationDrafts(api, scope);
  authorizeConversationDraft(api, THREAD_ID, "ws");
  writeConversationDraft(api, THREAD_ID, "still editable");
  expect(readConversationComposer(api, THREAD_ID).draft.body).toBe("still editable");
});
it("keeps composer state, authorization and the reload copy across a session rotation", async () => {
  const api = {} as ApiClient;
  const leave = configureConversationDrafts(api, scope);
  authorizeConversationDraft(api, THREAD_ID, "ws");
  const sent = writeConversationDraft(api, THREAD_ID, "failed body");
  const started = beginConversationSubmission(api, THREAD_ID, sent.draft.revision);
  failConversationSubmission(api, THREAD_ID, started.pending?.id ?? -1, "offline");
  writeConversationDraft(api, THREAD_ID, "unsent");
  // Password change: same client and person, new authentication lifetime.
  const rotated = { ...scope, authenticatedAt: "2026-10-12T09:00:00Z" };
  leave();
  configureConversationDrafts(api, rotated);
  await Promise.resolve();
  const state = readConversationComposer(api, THREAD_ID);
  expect(state.draft.body).toBe("unsent");
  expect(state.failed?.body).toBe("failed body");
  // The open chat keeps persisting without a fresh thread-detail authorization.
  writeConversationDraft(api, THREAD_ID, "after rotation");
  expect(restoreStoredDraft(rotated, "ws", THREAD_ID)).toBe("after rotation");
});
it("a different person on the same client never inherits composer state", async () => {
  const api = {} as ApiClient;
  const leave = configureConversationDrafts(api, scope);
  authorizeConversationDraft(api, THREAD_ID, "ws");
  writeConversationDraft(api, THREAD_ID, "alice");
  leave();
  configureConversationDrafts(api, { ...scope, userId: "bob" });
  await Promise.resolve();
  expect(readConversationComposer(api, THREAD_ID).draft.body).toBe("");
});
it("replaces or removes a stale stored copy when text was edited before authorization", () => {
  storeDraft(scope, "ws", THREAD_ID, "stale");
  storeDraft(scope, "ws", "other-chat", "stale too");
  const api = {} as ApiClient;
  configureConversationDrafts(api, scope);
  writeConversationDraft(api, THREAD_ID, "replacement");
  writeConversationDraft(api, "other-chat" as typeof THREAD_ID, "x");
  writeConversationDraft(api, "other-chat" as typeof THREAD_ID, "");
  authorizeConversationDraft(api, THREAD_ID, "ws");
  authorizeConversationDraft(api, "other-chat" as typeof THREAD_ID, "ws");
  expect(readConversationComposer(api, THREAD_ID).draft.body).toBe("replacement");
  expect(restoreStoredDraft(scope, "ws", THREAD_ID)).toBe("replacement");
  expect(restoreStoredDraft(scope, "ws", "other-chat")).toBeUndefined();
});
it("coalesces keystroke writes and flushes them on pagehide", () => {
  vi.useFakeTimers();
  const api = {} as ApiClient;
  configureConversationDrafts(api, scope);
  authorizeConversationDraft(api, THREAD_ID, "ws");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  for (const body of ["h", "he", "hel", "hell", "hello"])
    writeConversationDraft(api, THREAD_ID, body);
  expect(setItem).not.toHaveBeenCalled();
  vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
  expect(setItem).toHaveBeenCalledOnce();
  writeConversationDraft(api, THREAD_ID, "hello!");
  window.dispatchEvent(new Event("pagehide"));
  expect(setItem).toHaveBeenCalledTimes(2);
  expect(JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}").entries[0].body).toBe(
    "hello!",
  );
});
it("trims to the byte budget with exactly the serialized size", () => {
  for (let i = 0; i < 20; i++) storeDraft(scope, "ws", String(i), "x".repeat(7000));
  const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "";
  expect(raw.length).toBeLessThanOrEqual(131072);
  // One more 7000-char entry must not have fitted, so trimming stopped at the first fit.
  expect(raw.length + 7100).toBeGreaterThan(131072);
});
