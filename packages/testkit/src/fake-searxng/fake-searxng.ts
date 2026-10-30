// In-process fake of a SearXNG instance for the `web_search` proxy (ADR-0049), served through a
// `fetch` function so a T1 Gateway calls it with no socket. It answers `GET /search` with
// SearXNG's JSON result shape (`format=json`) or an HTML page (any other format), ranks a seeded
// index by token overlap with the query, records every request, and lets a test script the next
// answers, including failures. The evaluation fixture of `evals/web-search/` uses the same index
// and ranking behind a real HTTP server.

export interface FakeSearchDocument {
  url: string;
  title: string;
  content: string;
  engine?: string;
}

export interface FakeSearxngRequest {
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** A scripted answer: a body and status, raw text, a thrown network error, or a hang. */
export type FakeSearxngReply =
  | { status?: number; body: unknown }
  | { raw: string; status?: number }
  | { error: "network" }
  | { error: "hang" };

export interface FakeSearxngOptions {
  /** Default `http://fake-searxng.test`; any other origin is 404. */
  baseUrl?: string;
  documents?: readonly FakeSearchDocument[];
  /** How many results one answer holds at most (SearXNG's own page size is about 10 to 30). */
  pageSize?: number;
}

/** Lower-case word tokens of letters, digits and CJK characters (each CJK character a token). */
export function searchTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text
    .normalize("NFKC")
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (/\p{Script=Han}/u.test(word)) out.push(...[...word].filter((c) => /\S/.test(c)));
    else out.push(word);
  }
  return out;
}

/**
 * The fake's ranking: documents sharing at least one query token, by the number of distinct query
 * tokens they contain (title matches count twice), then by index order. Deterministic.
 */
export function rankDocuments<T extends FakeSearchDocument>(
  documents: readonly T[],
  query: string,
  limit: number,
): T[] {
  const wanted = new Set(searchTokens(query));
  if (wanted.size === 0) return [];
  const scored: { doc: T; score: number; index: number }[] = [];
  documents.forEach((doc, index) => {
    const title = new Set(searchTokens(doc.title));
    const body = new Set(searchTokens(doc.content));
    let score = 0;
    for (const token of wanted) {
      if (title.has(token)) score += 2;
      else if (body.has(token)) score += 1;
    }
    if (score > 0) scored.push({ doc, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.doc);
}

/** SearXNG's JSON answer for a query over these documents. */
export function searxngAnswer(
  documents: readonly FakeSearchDocument[],
  query: string,
  pageSize: number,
): Record<string, unknown> {
  const hits = rankDocuments(documents, query, pageSize);
  return {
    query,
    number_of_results: hits.length,
    results: hits.map((d, i) => ({
      url: d.url,
      title: d.title,
      content: d.content,
      engine: d.engine ?? "fake",
      engines: [d.engine ?? "fake"],
      score: hits.length - i,
      category: "general",
    })),
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsive_engines: [],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeSearxng {
  readonly baseUrl: string;
  readonly requests: FakeSearxngRequest[] = [];
  documents: FakeSearchDocument[];
  private readonly pageSize: number;
  private readonly queue: FakeSearxngReply[] = [];

  constructor(opts: FakeSearxngOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://fake-searxng.test").replace(/\/+$/, "");
    this.documents = [...(opts.documents ?? [])];
    this.pageSize = opts.pageSize ?? 20;
  }

  /** Queue the answer of the next request; unqueued requests are answered from the index. */
  next(reply: FakeSearxngReply): this {
    this.queue.push(reply);
    return this;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    if (parsed.origin !== new URL(this.baseUrl).origin) return json({ error: "unknown" }, 404);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    this.requests.push({ url, headers, params });
    const reply = this.queue.shift();
    if (reply) {
      if ("error" in reply) {
        if (reply.error === "network") throw new TypeError("fetch failed");
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          const abort = () => {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
          };
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if ("raw" in reply) return new Response(reply.raw, { status: reply.status ?? 200 });
      return json(reply.body, reply.status ?? 200);
    }
    if (parsed.pathname !== "/search") return json({ error: "not found" }, 404);
    const query = params.q ?? "";
    if (params.format !== "json")
      return new Response(`<!doctype html><title>${query}</title><p>results</p>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    return json(searxngAnswer(this.documents, query, this.pageSize));
  };
}
