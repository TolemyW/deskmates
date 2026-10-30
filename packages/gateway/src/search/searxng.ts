// The SearXNG adapter (ADR-0049 decisions 3 and 7): the one upstream request, built from a fixed
// template, and the checked results taken from its JSON answer. Pure; the proxy forwards.

import {
  WEB_SEARCH_SNIPPET_MAX_CHARS,
  WEB_SEARCH_TITLE_MAX_CHARS,
  type WebSearchResult,
  webSearchResultUrl,
  webSearchText,
} from "@deskmates/contracts";
import type { SearchServiceConfig } from "../config/search.js";

/** What a redacted part of a query reads as; the sidecar's redaction writes the same mark. */
export const REDACTED_QUERY_MARK = "[redacted]";

export interface SearxngQuery {
  query: string;
  language?: string;
}

/**
 * Decision 3: `q`, `format=json`, `pageno=1`, `safesearch=1` and the optional language, and
 * nothing else the run could choose. The token, when configured, goes as a Bearer header.
 */
export function searxngRequest(
  service: SearchServiceConfig,
  query: SearxngQuery,
): { url: string; init: RequestInit } {
  const url = new URL(service.url);
  url.search = "";
  url.searchParams.set("q", query.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("safesearch", "1");
  if (query.language !== undefined) url.searchParams.set("language", query.language);
  return {
    url: url.href,
    init: {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(service.authToken ? { authorization: `Bearer ${service.authToken}` } : {}),
      },
      redirect: "error",
    },
  };
}

export interface ParsedSearch {
  results: WebSearchResult[];
  dropped: number;
}

/**
 * Decision 7: the answer's `results`, each with a string `url` and `title`, filtered by
 * `webSearchResultUrl` against the workspace's allowlist, de-duplicated, cut, and at most `max`.
 * Undefined when the answer has no `results` array (an HTML page, an error object).
 */
export function parseSearxngAnswer(
  body: unknown,
  max: number,
  allowlist: readonly string[],
): ParsedSearch | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { results?: unknown }).results;
  if (!Array.isArray(raw)) return undefined;
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw) {
    if (results.length >= max) break;
    const r = (item ?? {}) as Record<string, unknown>;
    const url = webSearchResultUrl(r.url, allowlist);
    const title = webSearchText(r.title, WEB_SEARCH_TITLE_MAX_CHARS);
    if (url === undefined || title === "" || seen.has(url)) {
      dropped += 1;
      continue;
    }
    seen.add(url);
    const engines = Array.isArray(r.engines) ? r.engines : [];
    const engine =
      typeof r.engine === "string"
        ? r.engine
        : typeof engines[0] === "string"
          ? (engines[0] as string)
          : "";
    results.push({
      title,
      url,
      snippet: webSearchText(r.content, WEB_SEARCH_SNIPPET_MAX_CHARS),
      engine: webSearchText(engine, 64),
    });
  }
  return { results, dropped };
}

/** Empty results with failed engines are incomplete evidence, not a reliable no-match answer. */
export function emptySearchEngineFailure(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = body as { results?: unknown; unresponsive_engines?: unknown };
  return (
    Array.isArray(value.results) &&
    value.results.length === 0 &&
    Array.isArray(value.unresponsive_engines) &&
    value.unresponsive_engines.length > 0
  );
}
