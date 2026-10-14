// A bounded, tab-local reload aid, never a message queue or a credential store.
export const DRAFT_STORAGE_KEY = "deskmates.chat-drafts.v1";
export const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY = 32_768;
const MAX_ENTRIES = 20;
const MAX_TOTAL = 131_072;
export interface DraftScope {
  userId: string;
  tenantId: string;
  authenticatedAt: string;
}
interface Entry {
  workspaceId: string;
  threadId: string;
  body: string;
  at: number;
}
interface Saved {
  scope: DraftScope;
  entries: Entry[];
}
function sameScope(a: DraftScope, b: DraftScope): boolean {
  return (
    a.userId === b.userId && a.tenantId === b.tenantId && a.authenticatedAt === b.authenticatedAt
  );
}
export function clearStoredDrafts(): void {
  cancelScheduledDrafts();
  try {
    sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* Memory remains available. */
  }
}
function read(scope: DraftScope): Entry[] {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return [];
    if (raw.length > MAX_TOTAL * 2) throw new Error("oversized draft store");
    const saved = JSON.parse(raw) as Saved;
    if (!saved.scope || !sameScope(saved.scope, scope) || !Array.isArray(saved.entries))
      throw new Error("different or invalid scope");
    const now = Date.now();
    return saved.entries
      .filter(
        (e) =>
          e &&
          typeof e.workspaceId === "string" &&
          typeof e.threadId === "string" &&
          typeof e.body === "string" &&
          e.body.length <= MAX_BODY &&
          Number.isFinite(e.at) &&
          e.at <= now &&
          now - e.at < DRAFT_TTL_MS,
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    clearStoredDrafts();
    return [];
  }
}
function save(scope: DraftScope, entries: Entry[]): void {
  try {
    if (!entries.length) clearStoredDrafts();
    else sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ scope, entries }));
  } catch {
    clearStoredDrafts(); /* Never leave an older draft after a failed write. */
  }
}
export function prepareStoredDrafts(scope: DraftScope): void {
  flushStoredDrafts();
  save(scope, read(scope));
}
/** Same person and tenant after a session rotation: keep the unsent text under the new lifetime. */
export function rescopeStoredDrafts(from: DraftScope, to: DraftScope): void {
  flushStoredDrafts();
  if (from.userId !== to.userId || from.tenantId !== to.tenantId) {
    prepareStoredDrafts(to);
    return;
  }
  save(to, read(from));
}
export function restoreStoredDraft(
  scope: DraftScope,
  workspaceId: string,
  threadId: string,
): string | undefined {
  flushStoredDrafts();
  const entries = read(scope);
  save(scope, entries);
  return entries.find((e) => e.workspaceId === workspaceId && e.threadId === threadId)?.body;
}
export function storeDraft(
  scope: DraftScope,
  workspaceId: string,
  threadId: string,
  body: string,
): void {
  scheduled.delete(key(workspaceId, threadId));
  write(scope, [{ workspaceId, threadId, body }]);
}
/** Keystrokes coalesce; pagehide/beforeunload and every immediate read or write flush first. */
export const DRAFT_WRITE_DELAY_MS = 300;
interface Scheduled {
  scope: DraftScope;
  workspaceId: string;
  threadId: string;
  body: string;
}
const scheduled = new Map<string, Scheduled>();
let timer: ReturnType<typeof setTimeout> | undefined;
let unloadHooked = false;
function key(workspaceId: string, threadId: string): string {
  return JSON.stringify([workspaceId, threadId]);
}
export function scheduleDraft(
  scope: DraftScope,
  workspaceId: string,
  threadId: string,
  body: string,
): void {
  const pendingScope = scheduled.values().next().value?.scope;
  if (pendingScope && !sameScope(pendingScope, scope)) flushStoredDrafts();
  scheduled.set(key(workspaceId, threadId), { scope, workspaceId, threadId, body });
  if (!unloadHooked && typeof window !== "undefined") {
    unloadHooked = true;
    window.addEventListener("pagehide", flushStoredDrafts);
    window.addEventListener("beforeunload", flushStoredDrafts);
  }
  if (timer === undefined) timer = setTimeout(flushStoredDrafts, DRAFT_WRITE_DELAY_MS);
}
export function flushStoredDrafts(): void {
  const items = [...scheduled.values()];
  cancelScheduledDrafts();
  const first = items[0];
  if (first) write(first.scope, items);
}
function cancelScheduledDrafts(): void {
  scheduled.clear();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
function write(
  scope: DraftScope,
  changes: { workspaceId: string; threadId: string; body: string }[],
): void {
  let entries = read(scope);
  for (const { workspaceId, threadId, body } of changes) {
    entries = entries.filter((e) => e.threadId !== threadId || e.workspaceId !== workspaceId);
    if (body && body.length <= MAX_BODY)
      entries.unshift({ workspaceId, threadId, body, at: Date.now() });
  }
  entries = entries.slice(0, MAX_ENTRIES);
  // Size each entry once: envelope + entries joined by commas, as JSON.stringify lays them out.
  const sizes = entries.map((e) => JSON.stringify(e).length);
  let total =
    JSON.stringify({ scope, entries: [] }).length +
    sizes.reduce((sum, size) => sum + size, 0) +
    Math.max(0, entries.length - 1);
  while (entries.length && total > MAX_TOTAL) {
    entries.pop();
    total -= (sizes.pop() ?? 0) + (entries.length ? 1 : 0);
  }
  save(scope, entries);
}
