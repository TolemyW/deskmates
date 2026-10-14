import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { THREAD_ID } from "../test-support/fixtures.js";
import {
  beginConversationSubmission,
  completeConversationSubmission,
  dismissFailedConversationSubmission,
  failConversationSubmission,
  readConversationComposer,
  restoreFailedConversationSubmission,
  subscribeConversationComposer,
  writeConversationDraft,
} from "./conversation-drafts.js";

describe("conversation drafts", () => {
  it("scopes drafts by API client and publishes changes", () => {
    const first = {} as ApiClient;
    const second = {} as ApiClient;
    const listener = vi.fn();
    subscribeConversationComposer(first, THREAD_ID, listener);

    writeConversationDraft(first, THREAD_ID, "A");
    expect(readConversationComposer(first, THREAD_ID).draft.body).toBe("A");
    expect(readConversationComposer(second, THREAD_ID).draft.body).toBe("");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps a failed submission separate from a newer draft until explicit restore", () => {
    const api = {} as ApiClient;
    const written = writeConversationDraft(api, THREAD_ID, "A");
    const started = beginConversationSubmission(api, THREAD_ID, written.draft.revision);
    const submissionId = started.pending?.id ?? -1;
    expect(started.draft.body).toBe("");

    writeConversationDraft(api, THREAD_ID, "B");
    const failed = failConversationSubmission(api, THREAD_ID, submissionId, "offline");
    expect(failed.draft.body).toBe("B");
    expect(failed.failed).toMatchObject({ body: "A", error: "offline" });

    const restored = restoreFailedConversationSubmission(api, THREAD_ID, submissionId);
    expect(restored.draft.body).toBe("A");
    expect(restored.failed).toBeUndefined();
  });

  it("dismisses only the matching retained failure", () => {
    const api = {} as ApiClient;
    const written = writeConversationDraft(api, THREAD_ID, "A");
    const started = beginConversationSubmission(api, THREAD_ID, written.draft.revision);
    const submissionId = started.pending?.id ?? -1;
    failConversationSubmission(api, THREAD_ID, submissionId, "offline");

    expect(
      dismissFailedConversationSubmission(api, THREAD_ID, submissionId + 1).failed,
    ).toBeDefined();
    expect(
      dismissFailedConversationSubmission(api, THREAD_ID, submissionId).failed,
    ).toBeUndefined();
  });

  it("settles only the matching pending submission", () => {
    const api = {} as ApiClient;
    const written = writeConversationDraft(api, THREAD_ID, "A");
    const started = beginConversationSubmission(api, THREAD_ID, written.draft.revision);
    const submissionId = started.pending?.id ?? -1;

    expect(completeConversationSubmission(api, THREAD_ID, submissionId + 1).pending?.id).toBe(
      submissionId,
    );
    expect(completeConversationSubmission(api, THREAD_ID, submissionId).pending).toBeUndefined();
  });
});
