// The search fixture of the web search comparison (protocol of 2026-10-18): one HTTP server that
// is both the web and its search engine. It serves the task set's pages at `/p/<slug>`, a search
// page for the browser at `/search?q=` (HTML, built like a SearXNG results page), and SearXNG's
// JSON answer at `/search?q=&format=json` for the Gateway's search proxy. Both search paths rank
// the same index the same way (the testkit's token-overlap rank), so the arms differ in how the
// bot reaches the engine, never in what it finds. Every request is logged; a search carrying the
// campaign's search token is the Gateway's (the `web_search` tool), any other is the bot's own.
// Model-free; the executor and the T1 dry run start it.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { searxngAnswer } from "@deskmates/testkit";
import { type IndexDocument, type WebSearchTaskSet, indexDocuments } from "./task-set.js";

export interface FixtureLogEntry {
  kind: "search" | "page" | "home" | "miss";
  /** `tool`: the Gateway's proxy (it carried the search token); `browser`: anything else. */
  via?: "tool" | "browser";
  query?: string;
  /** The page's document id, for a page request. */
  doc?: string;
}

export interface SearchFixture {
  /** Loopback origin, for the Gateway's `SEARCH_URL` and the harness. */
  url: string;
  port: number;
  /** Entries logged since the last call; the executor reads them once per task. */
  drain(): FixtureLogEntry[];
  close(): Promise<void>;
}

export interface SearchFixtureOptions {
  /** The origin result URLs and links use: what the workspace container reaches. */
  publicOrigin?: (port: number) => string;
  /** The Bearer the Gateway sends (`SEARCH_AUTH_TOKEN`); marks a search as the tool's. */
  searchToken: string;
  host?: string;
  /** Results per answer, like a SearXNG page. */
  pageSize?: number;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

export async function startSearchFixture(
  set: WebSearchTaskSet,
  opts: SearchFixtureOptions,
): Promise<SearchFixture> {
  const docs = indexDocuments(set);
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const pageSize = opts.pageSize ?? 10;
  let log: FixtureLogEntry[] = [];
  let origin = "";
  const resultDocs = () =>
    docs.map((d: IndexDocument) => ({
      url: `${origin}/p/${d.slug}`,
      title: d.title,
      content: d.body,
      engine: "fixture",
      snippet: d.snippet,
    }));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET") return send(405, "text/plain", "GET only");
    if (url.pathname === "/") {
      log.push({ kind: "home" });
      return send(
        200,
        "text/html; charset=utf-8",
        page(
          "Coastal search",
          '<h1>Coastal search</h1><form action="/search" method="get"><input name="q" aria-label="Search"><button>Search</button></form>',
        ),
      );
    }
    if (url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      const tool = req.headers.authorization === `Bearer ${opts.searchToken}`;
      log.push({ kind: "search", via: tool ? "tool" : "browser", query });
      // A search result shows the page's snippet, as SearXNG shows an engine's description.
      const answer = searxngAnswer(resultDocs(), query, pageSize) as {
        results: { url: string; title: string }[];
      };
      const snippets = new Map(resultDocs().map((d) => [d.url, d.snippet]));
      const results = answer.results.map((r) => ({ ...r, content: snippets.get(r.url) ?? "" }));
      if (url.searchParams.get("format") === "json")
        return send(200, "application/json", JSON.stringify({ ...answer, results }));
      const items = results
        .map(
          (r) =>
            `<article><h3><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></h3><p class="url">${escapeHtml(r.url)}</p><p>${escapeHtml(r.content)}</p></article>`,
        )
        .join("");
      return send(
        200,
        "text/html; charset=utf-8",
        page(
          `${query} - Coastal search`,
          `<form action="/search" method="get"><input name="q" value="${escapeHtml(query)}" aria-label="Search"><button>Search</button></form>${items || "<p>No results.</p>"}`,
        ),
      );
    }
    const slug = /^\/p\/([0-9a-f]{12})$/.exec(url.pathname)?.[1];
    const doc = slug ? bySlug.get(slug) : undefined;
    if (doc) {
      log.push({ kind: "page", doc: doc.id });
      const rest = doc.body.slice(doc.snippet.length).trim();
      return send(
        200,
        "text/html; charset=utf-8",
        page(
          doc.title,
          `<h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.snippet)}</p>${rest ? `<p>${escapeHtml(rest)}</p>` : ""}`,
        ),
      );
    }
    log.push({ kind: "miss" });
    return send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origin = opts.publicOrigin?.(port) ?? `http://127.0.0.1:${port}`;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    drain() {
      const out = log;
      log = [];
      return out;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Searches by path, page opens and page ids of one run's log. */
export function fixtureCounts(entries: readonly FixtureLogEntry[]): {
  searches: { tool: number; browser: number };
  pagesOpened: number;
  pages: string[];
} {
  const searches = { tool: 0, browser: 0 };
  const pages: string[] = [];
  for (const e of entries) {
    if (e.kind === "search") searches[e.via ?? "browser"] += 1;
    if (e.kind === "page" && e.doc) pages.push(e.doc);
  }
  return { searches, pagesOpened: pages.length, pages };
}
