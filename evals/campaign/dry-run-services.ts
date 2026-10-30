// Scripted embedding and rerank services for the dry run's `vectors` and `vectors-rerank` arms
// (protocol amendment 1 A4): deterministic, model-free, in the request and answer shapes
// `packages/gateway/src/retrieval/clients.ts` reads (the OpenAI `/v1/embeddings` shape and the
// vLLM/Jina/Cohere `/rerank` shape). The vectors are hashed token counts and the scores token
// overlap, so they exercise the indexer, the vector store, fusion and rerank plumbing, and say
// nothing about retrieval quality. T2/T4 support for the executors; the pure parts are T0.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { contentTokens, tokens } from "./text.js";

export const DRY_RUN_VECTOR_DIMS = 64;

/** FNV-1a over the token's UTF-16 code units: stable across runs and platforms. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Token counts hashed into a fixed number of dimensions; never the zero vector. */
export function hashedVector(text: string, dims = DRY_RUN_VECTOR_DIMS): number[] {
  const v: number[] = Array.from({ length: dims }, () => 0);
  for (const t of tokens(text)) {
    const i = hash(t) % dims;
    v[i] = (v[i] ?? 0) + 1;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return v;
}

/** Share of the query's content tokens the document contains, in [0, 1]. */
export function overlapScore(query: string, document: string): number {
  const q = contentTokens(query);
  if (q.size === 0) return 0;
  const d = new Set(tokens(document));
  let n = 0;
  for (const t of q) if (d.has(t)) n += 1;
  return n / q.size;
}

export interface DryRunServices {
  embeddingUrl: string;
  rerankUrl: string;
  /** Requests served, by path: the dry run's evidence that the arm reached its services. */
  calls: Record<string, number>;
  close(): Promise<void>;
}

function answer(body: Record<string, unknown>, pathname: string): unknown {
  if (pathname === "/v1/embeddings") {
    const input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? "")];
    return {
      data: input.map((text, index) => ({ index, embedding: hashedVector(text) })),
      usage: { prompt_tokens: input.reduce((a, t) => a + tokens(t).length, 0) },
    };
  }
  const query = String(body.query ?? "");
  const documents = Array.isArray(body.documents) ? body.documents.map(String) : [];
  return {
    results: documents.map((d, index) => ({ index, relevance_score: overlapScore(query, d) })),
    usage: { total_tokens: tokens(query).length * documents.length },
  };
}

/** Both services on one loopback port: `/v1/embeddings` and `/rerank`. */
export async function startDryRunServices(): Promise<DryRunServices> {
  const calls: Record<string, number> = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const pathname = new URL(req.url ?? "/", "http://dry-run").pathname;
      if (req.method !== "POST" || (pathname !== "/v1/embeddings" && pathname !== "/rerank")) {
        res.writeHead(404).end();
        return;
      }
      calls[pathname] = (calls[pathname] ?? 0) + 1;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(body, pathname)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    embeddingUrl: `${base}/v1/embeddings`,
    rerankUrl: `${base}/rerank`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
