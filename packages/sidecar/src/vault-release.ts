// The hand-over between the PreToolUse hook and the vault tool handlers (ADR-0045 decision 4).
// The hook allowed a credential release under one approval; the handler runs next with the same
// input but is not told its tool-use id by the SDK. The hook therefore queues `{approvalId,
// toolUseId, tabId}` under the call's canonical input and the handler takes it. The Gateway
// checks the approval again before it decrypts, so a missing or wrong hand-over is a refusal
// (`no_grant`), never a release.

export interface VaultRelease {
  approvalId: string;
  toolUseId: string;
  /** `vault_fill` only: the run's tab the hook saw, and its URL (for capture suppression). */
  tabId?: string;
  tabUrl?: string;
  /** The entry's exact origin, the label of an untrusted response body. */
  origin?: string;
}

/** Released uses waiting for their handler, by canonical input. Process memory only. */
export type VaultReleases = Map<string, VaultRelease[]>;

/** Key order and absent values do not change the key; the values are references only. */
export function vaultCallKey(toolName: string, input: Record<string, unknown>): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sorted(v)]),
      );
    return value;
  };
  return `${toolName}:${JSON.stringify(sorted(input))}`;
}

export function rememberVaultRelease(
  releases: VaultReleases,
  key: string,
  release: VaultRelease,
): void {
  const queue = releases.get(key) ?? [];
  queue.push(release);
  releases.set(key, queue);
}

export function takeVaultRelease(releases: VaultReleases, key: string): VaultRelease | undefined {
  const queue = releases.get(key);
  const release = queue?.shift();
  if (queue && queue.length === 0) releases.delete(key);
  return release;
}
