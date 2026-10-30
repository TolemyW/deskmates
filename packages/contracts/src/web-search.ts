// `web_search` (ADR-0049): a sidecar tool whose query the Gateway forwards once to the
// installation's self-hosted SearXNG. The shapes, the bounds both sides check, and the result
// filter both sides apply. Search results are page- and engine-authored text: untrusted data.

import { EGRESS_OPEN_INTERNET, isPublicHostname } from "./workspace.js";

/** Decision 5: query length after trimming. */
export const WEB_SEARCH_QUERY_MAX_CHARS = 400;
/** Decision 5: results one call may return, and how many it returns when it does not say. */
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
/** Decision 5: searches one run may forward; later calls are refused as `rate_limited`. */
export const WEB_SEARCH_MAX_PER_RUN = 50;
/** Decision 7: what one result keeps of the engine's text. */
export const WEB_SEARCH_TITLE_MAX_CHARS = 300;
export const WEB_SEARCH_SNIPPET_MAX_CHARS = 600;
export const WEB_SEARCH_URL_MAX_CHARS = 2048;
/** Decision 3: the one upstream call's timeout. */
export const WEB_SEARCH_TIMEOUT_MS = 15_000;
/** Decision 5: `en`, `zh`, `zh-CN`, `pt-BR`, `zh-Hans`. */
export const WEB_SEARCH_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/** Sidecar → Gateway: one search. The Gateway binds run, workspace and endpoint itself. */
export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  language?: string;
  /** Decision 6: the sidecar's redaction replaced something in the query before it was sent. */
  redacted?: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** The SearXNG engine that found it (`duckduckgo`, `wikipedia`); empty when it named none. */
  engine: string;
}

export interface WebSearchResponse {
  searchId: string;
  results: WebSearchResult[];
  /** Results the filter of decision 7 left out (private hosts, IP literals, duplicates, bad URLs). */
  dropped: number;
}

/** What `runs.config_json.webSearch` holds once a run on a configured installation started. */
export type WebSearchStamp = "on" | "off";

/** The workspace switch (decision 4): stored `true`/`false`, or no row (on when configured). */
export interface WebSearchView {
  workspaceId: string;
  /** Whether the installation configures `SEARCH_URL`; without it the switch cannot be on. */
  configured: boolean;
  /** The stored choice; `null` is the default. */
  enabled: boolean | null;
  /** What a run that starts now gets. */
  effective: boolean;
  /** The configured default when nothing is stored (owner amendment 2026-10-22). */
  defaultEnabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** `PUT /api/workspaces/:id/web-search`: `null` returns to the default. */
export interface WebSearchInput {
  enabled: boolean | null;
}

/** The bounds of decision 5; the first problem, or undefined when the request is acceptable. */
export function webSearchRequestProblem(input: {
  query?: unknown;
  maxResults?: unknown;
  language?: unknown;
}): string | undefined {
  if (typeof input.query !== "string") return "query must be text";
  const query = input.query.trim();
  if (query === "") return "query must not be empty";
  if (query.length > WEB_SEARCH_QUERY_MAX_CHARS)
    return `query must be at most ${WEB_SEARCH_QUERY_MAX_CHARS} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(query)) return "query must not contain control characters";
  if (
    input.maxResults !== undefined &&
    (typeof input.maxResults !== "number" ||
      !Number.isSafeInteger(input.maxResults) ||
      input.maxResults < 1 ||
      input.maxResults > WEB_SEARCH_MAX_RESULTS)
  )
    return `maxResults must be 1 to ${WEB_SEARCH_MAX_RESULTS}`;
  if (
    input.language !== undefined &&
    (typeof input.language !== "string" || !WEB_SEARCH_LANGUAGE.test(input.language))
  )
    return "language must be a language tag such as en, zh or zh-CN";
  return undefined;
}

/** Suffixes of names that mean a private network by convention, never a public site. */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".arpa"];

/** Whether `host` is an IP literal in any spelling the URL standard accepts. */
function isIpLiteral(host: string): boolean {
  if (host.includes(":") || host.startsWith("[")) return true;
  const last = host.slice(host.lastIndexOf(".") + 1);
  return /^(0x[0-9a-f]*|[0-9]+)$/.test(last);
}

/** An explicit entry of the workspace's allowlist (an exact name or `*.suffix`, never `*`). */
function explicitlyListed(host: string, allowlist: readonly string[]): boolean {
  for (const raw of allowlist) {
    const p = raw.trim().toLowerCase();
    if (p === "" || p === EGRESS_OPEN_INTERNET) continue;
    if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
    } else if (host === p) return true;
  }
  return false;
}

/**
 * Decision 7: whether a result URL may be shown to the bot. `http(s)` only, no credentials, at
 * most 2048 characters; the host must be one `*` admits, with a dot and no private suffix, unless
 * an explicit allowlist entry of the workspace names it. An IP literal is never kept. Returns the
 * URL as parsed (normalised), or undefined to drop it.
 */
export function webSearchResultUrl(raw: unknown, allowlist: readonly string[]): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > WEB_SEARCH_URL_MAX_CHARS)
    return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || isIpLiteral(host)) return undefined;
  if (explicitlyListed(host, allowlist)) return url.href;
  if (!isPublicHostname(host) || !host.includes(".")) return undefined;
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return undefined;
  return url.href;
}

/** Control characters out, whitespace runs folded, cut to `max` characters. */
export function webSearchText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const clean = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
