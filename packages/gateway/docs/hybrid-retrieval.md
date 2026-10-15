# Hybrid Knowledge and memory search (ADR-0041)

`knowledge_search`, `memory_search` and the operator search pages (`GET /api/knowledge?q=`,
`GET /api/workspaces/:id/memory/search`) go through `ctx.retrieval`
(`src/retrieval/hybrid-retrieval.ts`). With no retrieval variable set it calls the FTS5
functions it replaced (`KnowledgeStore.search` / `searchPage`, `searchMemory` /
`searchMemoryPage`) with the same arguments, and the results are byte-identical.

## Configuration

| Variable | Meaning |
| --- | --- |
| `EMBEDDING_URL`, `EMBEDDING_MODEL` | Embedding service and model, set together. ollama `/api/embed` shape, or the OpenAI shape when the path ends in `/v1/embeddings`. |
| `RERANK_URL`, `RERANK_MODEL` | Rerank service and model, set together. vLLM/Jina/Cohere `{model, query, documents, top_n}` → `results[].{index, relevance_score}`. |
| `RETRIEVAL_CANDIDATES` | Candidates from each of bm25 and vectors (default 50, at most 200). |
| `RETRIEVAL_RRF_K` | Reciprocal rank fusion constant (default 60). |
| `RERANK_TOP_N` | Fused candidates reranked (default 20, at most 100). |
| `RETRIEVAL_MIN_SIMILARITY` | Cosine floor for a vector candidate (default 0.45, from one bge-m3 probe). |

On Testbox with the tos-00 services (owner decisions 2026-10-14, item 9):

```
EMBEDDING_URL=http://172.17.120.16:11434/api/embed
EMBEDDING_MODEL=BAAI/bge-m3:latest
RERANK_URL=http://172.17.120.16:8899/rerank
RERANK_MODEL=bge-reranker-v2-m3
```

When either pair is set, every run's `runs.config_json` carries `retrieval` (models, the four
knobs and the chunking version). Turning it on is a strategy change: compare it with the FTS5
baseline on a paired run (`evals/compare.ts`) before calling it better, vectors and rerank as
separate knobs.

## How it works

- **Indexing.** `RetrievalIndexer` runs at Gateway start (backfill), shortly after a Knowledge
  document is published or edited, and every 30 seconds. It embeds published documents and
  searchable memory entries that have no vector for the configured model, in batches of at most
  16 chunks per tenant or workspace, and stores one float32 vector per chunk in
  `knowledge_chunk_vectors` / `memory_chunk_vectors`. Chunk text is not stored. Triggers delete a
  source's vectors when its text changes or it is forgotten or distilled; vectors of another model
  are deleted at the start of a pass. A failed call ends the pass; the next pass retries.
- **Query.** bm25 candidates (the FTS5 query, unchanged) and vector candidates (brute-force dot
  product over the scope's vectors, best chunk per source, above the floor) are fused by
  reciprocal rank fusion; the first `RERANK_TOP_N` are reordered by the reranker. The tenant or
  workspace filter and memory's liveness filter are part of the vector SQL.
- **Degradation.** An embedding failure returns the bm25 result; a rerank failure returns the
  fused order. Neither fails the search.
- **Usage.** Every call writes a `retrieval_calls` row (tenant, run when a run asked, corpus,
  purpose, service, model, inputs, tokens or NULL for unknown, duration, outcome). Local services
  are priced as known zero.

## Limits

Brute force costs about 4 µs per 1024-dimension chunk on an Apple M1 Pro (40 ms per query at
10,000 chunks in one scope, 168 ms at 50,000) and blocks the Gateway's event loop while it runs.
Past about 20,000 chunks per tenant or workspace, an approximate index or a worker thread needs
its own decision (ADR-0041 decision 11).
