// A workspace is one container: one Chromium, one profile, one filesystem, one shell (ADR-0004).
// Bots in it share everything by default. There is no per-bot grant and no per-bot origin list.

import type { BotId, IsoTimestamp, RunId, WorkspaceId } from "./ids.js";
import type { SandboxRestorationRequirement } from "./sandbox.js";

export type SandboxProviderKind = "docker" | "desktop-vm";

export type WorkspaceStatus = "ready" | "needs_login" | "disabled";

/**
 * Optional probe that tells the Gateway whether the shared browser session is still logged in.
 * When the probe fails the workspace goes to `needs_login` and its runs park in `waiting_browser`.
 */
export interface LoginProbe {
  url: string;
  /** Substring that must appear in the page body for the session to count as logged in. */
  expectText: string;
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  sandboxProvider: SandboxProviderKind;
  status: WorkspaceStatus;
  probe?: LoginProbe;
  /** Human-maintained egress allowlist; deny by default. Bots cannot edit it. */
  egressAllowlist: readonly string[];
  /**
   * When an operator last replaced the allowlist (the creation time until one does). A sidecar
   * hook that refreshes the list mid-run compares it with what the run started from; absent only
   * on rows written before the column existed.
   */
  egressUpdatedAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  /**
   * The bot a person talks to first and a new chat channel connection is bound to by default
   * (ADR-0051). Absent while the workspace has none, or its default bot is in Trash.
   */
  defaultBotId?: BotId;
  /** Informational lifecycle evidence. This never grants trust or restores filesystem state. */
  restorationRequirements?: readonly SandboxRestorationRequirement[];
  /** Present only in Trash views. Archived workspaces reject every trigger and stay stopped. */
  archivedAt?: IsoTimestamp;
  archivedBy?: string;
}

/**
 * Whether the workspace container exists on the sandbox host now, as `GET /api/workspaces/:id`
 * reports it (issue #15). `never_created`: no run here has had a container yet. `removed`: an
 * earlier run had one and it is gone (removed on the host, or stopped by the Gateway). Either way
 * the next run of an active workspace creates it; `status` (`ready`) never says this. An archived
 * workspace is not served by that route: archiving removed its container and it refuses runs.
 */
export type WorkspaceContainerState = "present" | "never_created" | "removed";

export type BrowserLockHolderKind = "run" | "human";

/**
 * The workspace-level browser lock (design v0.3 §3.3, ADR-0004 "Browser lock, version 1").
 * A human holder is exclusive for the whole workspace; a run holder guards one tab.
 */
export interface BrowserLock {
  workspaceId: WorkspaceId;
  holderKind: BrowserLockHolderKind;
  holderRunId?: RunId;
  /** Stable CDP tab identity guarded by a run holder; absent for humans and legacy sidecars. */
  tabId?: string;
  acquiredAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
}

/**
 * Egress rule row. `domainPattern` is an exact host, a `*.example.com` suffix pattern, or the
 * lone `*`: any public hostname (ADR-0010).
 */
export interface EgressRule {
  workspaceId: WorkspaceId;
  domainPattern: string;
  createdBy: string;
  createdAt: IsoTimestamp;
}

/** The allowlist entry that means "any public hostname" (ADR-0010). Only valid on its own. */
export const EGRESS_OPEN_INTERNET = "*";

/** One label of a hostname: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/**
 * Whether a string is a usable allowlist pattern: an exact hostname, `*.` followed by one, or
 * the lone `*`. A URL, a path, a port or a space is not one — `egressAllows` would silently
 * never match it, and the container's Chromium resolver rules would be built from nonsense.
 */
export function isEgressPattern(pattern: string): boolean {
  if (pattern === EGRESS_OPEN_INTERNET) return true;
  return isHostname(pattern.startsWith("*.") ? pattern.slice(2) : pattern);
}

/**
 * Why an allowlist cannot be stored, or undefined when it can. Every entry must be a pattern,
 * and `*` must be the only entry: a list that mixes it with named hosts reads as restricted to
 * whoever edits it later while it allows everything.
 */
export function egressAllowlistProblem(patterns: readonly string[]): string | undefined {
  const bad = patterns.find((pattern) => !isEgressPattern(pattern));
  if (bad !== undefined) {
    return `egress pattern ${JSON.stringify(bad)} must be a hostname, *.hostname or a lone *`;
  }
  if (patterns.includes(EGRESS_OPEN_INTERNET) && new Set(patterns).size > 1) {
    return "egress pattern * (open internet) must be the only entry in the allowlist";
  }
  return undefined;
}

/** Whether an allowlist is the open-internet list `["*"]` (ADR-0010). */
export function isOpenInternetAllowlist(patterns: readonly string[]): boolean {
  return patterns.length > 0 && patterns.every((pattern) => pattern === EGRESS_OPEN_INTERNET);
}

/**
 * Pure matcher for the egress allowlist. A pattern is an exact hostname; `*.suffix`, which
 * matches `suffix` itself and any subdomain of it; or `*`, which matches any public hostname
 * (`isPublicHostname`). Case-insensitive.
 */
export function egressAllows(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of patterns) {
    const p = raw.toLowerCase();
    if (p === EGRESS_OPEN_INTERNET) {
      if (isPublicHostname(h)) return true;
    } else if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/**
 * What `*` admits: a well-formed hostname that is not an IP literal and not a name that means
 * loopback or the host by definition. An IP literal is anything with a colon or brackets (IPv6),
 * or whose last label is numeric, which the URL standard and curl both read as IPv4 (`127.1`,
 * `2130706433`, `0x7f000001`). `localhost` bypasses the egress proxy in Chromium, and the
 * reserved `host.docker.internal` reaches the host on any port (ADR-0009); neither is public.
 * The proxy still checks every resolved address: this is the name-level half of ADR-0010
 * decision 2. `images/egress/egress-policy.mjs` repeats it and the shared verdict table in
 * `@deskmates/testkit` holds the two together.
 */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!isHostname(h)) return false;
  const last = h.slice(h.lastIndexOf(".") + 1);
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(last)) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  return h !== "host.docker.internal";
}

function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split(".").every((label) => HOST_LABEL.test(label));
}
