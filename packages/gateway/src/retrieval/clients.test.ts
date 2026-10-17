// T0 (ADR-0041 decisions 2 and 4): the retrieval clients post only to their configured URL, send
// the fixed request shapes, and read only vectors, scores and usage counts.

import { describe, expect, it } from "vitest";
import {
  FAKE_EMBEDDING,
  FAKE_RERANK,
  FakeRetrievalService,
} from "../test-support/fake-retrieval.js";
import { EmbeddingClient, RerankClient, RetrievalCallError } from "./clients.js";

describe("embedding client", () => {
  it("sends ollama's /api/embed shape and normalises the vectors", async () => {
    const fake = new FakeRetrievalService();
    const client = new EmbeddingClient(FAKE_EMBEDDING, fake.fetch);
    const answer = await client.embed(["pg_dump nightly", "lunch menu"], 1000);
    expect(fake.calls).toEqual([
      {
        url: FAKE_EMBEDDING.url,
        body: { model: "fake-embed", input: ["pg_dump nightly", "lunch menu"], truncate: true },
      },
    ]);
    expect(answer.inputTokens).toBe(6);
    expect(answer.vectors).toHaveLength(2);
    const norm = Math.hypot(...Array.from(answer.vectors[0] ?? []));
    expect(norm).toBeCloseTo(1);
  });

  it("sends the OpenAI shape to a /v1/embeddings URL", async () => {
    const fake = new FakeRetrievalService();
    const service = { url: "http://embed.test:8006/v1/embeddings", model: "m" };
    const answer = await new EmbeddingClient(service, fake.fetch).embed(["backup"], 1000);
    expect(fake.calls[0]?.body).toEqual({ model: "m", input: ["backup"] });
    expect(answer.inputTokens).toBe(3);
    expect(answer.vectors).toHaveLength(1);
  });

  it("reports unknown tokens as null, never zero", async () => {
    const fake = new FakeRetrievalService();
    fake.reportUsage = false;
    const answer = await new EmbeddingClient(FAKE_EMBEDDING, fake.fetch).embed(["x"], 1000);
    expect(answer.inputTokens).toBeNull();
  });

  it("types failures: refused, error, timeout, malformed", async () => {
    const fake = new FakeRetrievalService();
    const client = new EmbeddingClient(FAKE_EMBEDDING, fake.fetch);
    fake.failEmbed = "refuse";
    await expect(client.embed(["x"], 1000)).rejects.toMatchObject({
      outcome: "error",
      refused: true,
    });
    fake.failEmbed = "error";
    await expect(client.embed(["x"], 1000)).rejects.toMatchObject({
      outcome: "error",
      refused: false,
    });
    fake.failEmbed = "malformed";
    await expect(client.embed(["x"], 1000)).rejects.toBeInstanceOf(RetrievalCallError);
    fake.failEmbed = "timeout";
    await expect(client.embed(["x"], 20)).rejects.toMatchObject({ outcome: "timeout" });
    const stop = new AbortController();
    const pending = client.embed(["x"], 60_000, stop.signal);
    stop.abort();
    await expect(pending).rejects.toBeInstanceOf(RetrievalCallError);
  });
});

describe("rerank client", () => {
  it("sends the vLLM rerank shape and returns scores in input order", async () => {
    const fake = new FakeRetrievalService();
    const client = new RerankClient(FAKE_RERANK, fake.fetch);
    const answer = await client.rerank(
      "how to back up",
      ["lunch at noon", "pg_dump nightly"],
      1000,
    );
    expect(fake.calls).toEqual([
      {
        url: FAKE_RERANK.url,
        body: {
          model: "fake-rerank",
          query: "how to back up",
          documents: ["lunch at noon", "pg_dump nightly"],
          top_n: 2,
        },
      },
    ]);
    expect(answer.scores[1]).toBeGreaterThan(answer.scores[0] ?? 1);
    expect(answer.inputTokens).toBe(14);
  });

  it("refuses a malformed answer", async () => {
    const fake = new FakeRetrievalService();
    fake.failRerank = "malformed";
    await expect(
      new RerankClient(FAKE_RERANK, fake.fetch).rerank("q", ["a", "b"], 1000),
    ).rejects.toBeInstanceOf(RetrievalCallError);
  });
});
