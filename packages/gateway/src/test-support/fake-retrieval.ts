// T0/T1 fake for ADR-0041: an embedding service (ollama `/api/embed` or OpenAI `/v1/embeddings`)
// and a vLLM-style rerank service behind one `fetch`, with no network. A text's vector counts
// the concept keywords it contains, so "pg_dump nightly" and "how do we back up the database"
// are close although they share no word; a text with no concept gets a small constant vector.

export const CONCEPTS: Record<string, readonly string[]> = {
  backup: ["backup", "back up", "pg_dump", "备份", "snapshot"],
  expense: ["expense", "reimburse", "报销", "invoice"],
  deploy: ["deploy", "release", "上线", "rollout"],
  cafeteria: ["cafeteria", "lunch", "食堂"],
};
const NAMES = Object.keys(CONCEPTS);

export function conceptVector(text: string): number[] {
  const lower = text.toLowerCase();
  const v = NAMES.map((name) =>
    (CONCEPTS[name] ?? []).reduce((n, word) => n + (lower.includes(word) ? 1 : 0), 0),
  );
  // A small "other" dimension keeps every vector non-zero and unrelated texts far apart.
  return [...v, 0.2];
}

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
};

export type FakeFailure = "error" | "refuse" | "timeout" | "malformed";

export interface FakeRetrievalCall {
  url: string;
  body: Record<string, unknown>;
}

export class FakeRetrievalService {
  readonly calls: FakeRetrievalCall[] = [];
  failEmbed: FakeFailure | undefined;
  failRerank: FakeFailure | undefined;
  /** Report usage counts; false answers without them (unknown tokens). */
  reportUsage = true;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    this.calls.push({ url, body });
    const path = new URL(url).pathname;
    const failure = path.endsWith("/rerank") ? this.failRerank : this.failEmbed;
    if (failure === "timeout")
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    if (failure === "error") return new Response("down", { status: 503 });
    if (failure === "refuse") return new Response("too long", { status: 400 });
    if (failure === "malformed") return Response.json({ nothing: true });
    if (path.endsWith("/rerank")) {
      const query = conceptVector(String(body.query));
      const documents = (body.documents as string[]) ?? [];
      const results = documents
        .map((text, index) => ({
          index,
          document: { text },
          relevance_score: cosine(query, conceptVector(text)),
        }))
        .sort((a, b) => b.relevance_score - a.relevance_score);
      return Response.json({
        id: "rerank-fake",
        model: body.model,
        ...(this.reportUsage ? { usage: { total_tokens: documents.length * 7 } } : {}),
        results,
      });
    }
    const inputs = (body.input as string[]) ?? [];
    const vectors = inputs.map(conceptVector);
    if (path.endsWith("/v1/embeddings"))
      return Response.json({
        data: vectors.map((embedding, index) => ({ index, embedding, object: "embedding" })),
        ...(this.reportUsage ? { usage: { prompt_tokens: inputs.length * 3 } } : {}),
      });
    return Response.json({
      model: body.model,
      embeddings: vectors,
      ...(this.reportUsage ? { prompt_eval_count: inputs.length * 3 } : {}),
    });
  };

  embedCalls(): FakeRetrievalCall[] {
    return this.calls.filter((call) => !new URL(call.url).pathname.endsWith("/rerank"));
  }

  rerankCalls(): FakeRetrievalCall[] {
    return this.calls.filter((call) => new URL(call.url).pathname.endsWith("/rerank"));
  }
}

export const FAKE_EMBEDDING = { url: "http://embed.test:11434/api/embed", model: "fake-embed" };
export const FAKE_RERANK = { url: "http://rerank.test:8899/rerank", model: "fake-rerank" };
