// Composer state is scoped to the authenticated client. Only bounded unsent text has a tab-local
// reload aid; pending/failed submissions remain memory-only and are never replayed.

import type { ThreadId } from "@deskmates/contracts";
import type { ApiClient } from "../api/client.js";
import {
  type DraftScope,
  clearStoredDrafts,
  prepareStoredDrafts,
  rescopeStoredDrafts,
  restoreStoredDraft,
  scheduleDraft,
  storeDraft,
} from "./draft-storage.js";
interface Persistence {
  api: ApiClient;
  scope: DraftScope;
  workspaces: Map<ThreadId, string>;
}
const persistence = new WeakMap<ApiClient, Persistence>();
let activePersistence: Persistence | undefined;
/**
 * Called only after authentication. A new identity never inherits the preceding identity's text;
 * the same person on the same client after a session rotation (for example a password change)
 * keeps their composer state, authorizations and reload copy.
 */
export function configureConversationDrafts(api: ApiClient, scope: DraftScope): () => void {
  const previous = activePersistence;
  const carried =
    previous?.api === api &&
    previous.scope.userId === scope.userId &&
    previous.scope.tenantId === scope.tenantId;
  if (previous && carried) rescopeStoredDrafts(previous.scope, scope);
  else {
    if (previous) {
      persistence.delete(previous.api);
      statesByClient.delete(previous.api);
    }
    prepareStoredDrafts(scope);
  }
  const binding: Persistence = {
    api,
    scope,
    workspaces: previous && carried ? previous.workspaces : new Map<ThreadId, string>(),
  };
  persistence.set(api, binding);
  activePersistence = binding;
  return () => {
    if (persistence.get(api) !== binding) return;
    persistence.delete(api);
    // StrictMode and a session rotation immediately reattach; a real sign-out/unmount leaves this
    // binding retired, and only then is the composer state dropped.
    queueMicrotask(() => {
      if (activePersistence === binding) {
        activePersistence = undefined;
        statesByClient.delete(api);
        clearStoredDrafts();
      }
    });
  };
}
/** Restore only after the Gateway authorized this thread and supplied its actual workspace. */
export function authorizeConversationDraft(
  api: ApiClient,
  threadId: ThreadId,
  workspaceId: string,
): void {
  const binding = persistence.get(api);
  if (!binding || binding.workspaces.has(threadId)) return;
  binding.workspaces.set(threadId, workspaceId);
  const current = readConversationComposer(api, threadId);
  if (current.draft.revision || current.pending || current.failed) {
    // Text edited before the thread was authorized replaces (or, if empty, removes) the old copy.
    storeDraft(binding.scope, workspaceId, threadId, current.draft.body);
    return;
  }
  const body = restoreStoredDraft(binding.scope, workspaceId, threadId);
  if (body) {
    statesFor(api).set(threadId, { ...current, draft: { body, revision: 1 } });
    for (const listener of listenersByClient.get(api)?.get(threadId) ?? []) listener();
  }
}

export interface ConversationDraft {
  body: string;
  /** Monotonic per-thread edit order, used to keep an old request from clearing newer text. */
  revision: number;
}

export interface ConversationSubmission {
  id: number;
  body: string;
}

export interface FailedConversationSubmission extends ConversationSubmission {
  error: string;
}

export interface ConversationComposerState {
  draft: ConversationDraft;
  nextSubmissionId: number;
  pending?: ConversationSubmission;
  failed?: FailedConversationSubmission;
}

type Listener = () => void;

const statesByClient = new WeakMap<ApiClient, Map<ThreadId, ConversationComposerState>>();
const listenersByClient = new WeakMap<ApiClient, Map<ThreadId, Set<Listener>>>();
const EMPTY_STATE: ConversationComposerState = {
  draft: { body: "", revision: 0 },
  nextSubmissionId: 1,
};

function statesFor(api: ApiClient): Map<ThreadId, ConversationComposerState> {
  let states = statesByClient.get(api);
  if (!states) {
    states = new Map();
    statesByClient.set(api, states);
  }
  return states;
}

function publish(
  api: ApiClient,
  threadId: ThreadId,
  state: ConversationComposerState,
  keystroke = false,
): void {
  statesFor(api).set(threadId, state);
  const binding = persistence.get(api);
  const workspaceId = binding?.workspaces.get(threadId);
  if (binding && workspaceId)
    (keystroke ? scheduleDraft : storeDraft)(
      binding.scope,
      workspaceId,
      threadId,
      state.draft.body,
    );
  for (const listener of listenersByClient.get(api)?.get(threadId) ?? []) listener();
}

export function readConversationComposer(
  api: ApiClient,
  threadId: ThreadId,
): ConversationComposerState {
  return statesFor(api).get(threadId) ?? EMPTY_STATE;
}

export function subscribeConversationComposer(
  api: ApiClient,
  threadId: ThreadId,
  listener: Listener,
): () => void {
  let byThread = listenersByClient.get(api);
  if (!byThread) {
    byThread = new Map();
    listenersByClient.set(api, byThread);
  }
  let listeners = byThread.get(threadId);
  if (!listeners) {
    listeners = new Set();
    byThread.set(threadId, listeners);
  }
  listeners.add(listener);
  return () => listeners?.delete(listener);
}

export function writeConversationDraft(
  api: ApiClient,
  threadId: ThreadId,
  body: string,
): ConversationComposerState {
  const current = readConversationComposer(api, threadId);
  const next = {
    ...current,
    draft: { body, revision: current.draft.revision + 1 },
  };
  publish(api, threadId, next, true);
  return next;
}

/** Move the submitted text out of the composer while retaining it until the request settles. */
export function beginConversationSubmission(
  api: ApiClient,
  threadId: ThreadId,
  expectedRevision: number,
): ConversationComposerState {
  const current = readConversationComposer(api, threadId);
  if (current.pending || current.draft.revision !== expectedRevision) return current;
  const next: ConversationComposerState = {
    ...current,
    draft: { body: "", revision: current.draft.revision + 1 },
    nextSubmissionId: current.nextSubmissionId + 1,
    pending: { id: current.nextSubmissionId, body: current.draft.body },
  };
  publish(api, threadId, next);
  return next;
}

export function completeConversationSubmission(
  api: ApiClient,
  threadId: ThreadId,
  submissionId: number,
): ConversationComposerState {
  const current = readConversationComposer(api, threadId);
  if (current.pending?.id !== submissionId) return current;
  const { pending: _pending, ...next } = current;
  publish(api, threadId, next);
  return next;
}

/** Keep a failed body separate so a newer draft is never overwritten by an old request. */
export function failConversationSubmission(
  api: ApiClient,
  threadId: ThreadId,
  submissionId: number,
  error: string,
): ConversationComposerState {
  const current = readConversationComposer(api, threadId);
  if (current.pending?.id !== submissionId) return current;
  const failed = { ...current.pending, error };
  const { pending: _pending, ...withoutPending } = current;
  const next = { ...withoutPending, failed };
  publish(api, threadId, next);
  return next;
}

/** Explicitly replace the composer with the retained failed body. */
export function restoreFailedConversationSubmission(
  api: ApiClient,
  threadId: ThreadId,
  submissionId: number,
): ConversationComposerState {
  const current = readConversationComposer(api, threadId);
  if (current.failed?.id !== submissionId) return current;
  const { failed, ...withoutFailed } = current;
  const next = {
    ...withoutFailed,
    draft: { body: failed.body, revision: current.draft.revision + 1 },
  };
  publish(api, threadId, next);
  return next;
}

/** Explicitly discard a retained failed body so a newer draft can be sent. */
export function dismissFailedConversationSubmission(
  api: ApiClient,
  threadId: ThreadId,
  submissionId: number,
): ConversationComposerState {
  const current = readConversationComposer(api, threadId);
  if (current.failed?.id !== submissionId) return current;
  const { failed: _failed, ...next } = current;
  publish(api, threadId, next);
  return next;
}
