import { describe, expect, it } from "vitest";
import { RETRIEVAL_DEFAULTS, readRetrievalConfig } from "./retrieval.js";

describe("retrieval configuration (ADR-0041 decisions 1, 6 and 10)", () => {
  it("is absent when nothing is set, so search stays FTS5", () => {
    expect(readRetrievalConfig({})).toEqual({});
    expect(readRetrievalConfig({ EMBEDDING_URL: " ", RERANK_MODEL: "" })).toEqual({});
    // Tuning knobs alone switch nothing on.
    expect(readRetrievalConfig({ RETRIEVAL_CANDIDATES: "10" })).toEqual({});
  });

  it("refuses half a pair", () => {
    expect(() => readRetrievalConfig({ EMBEDDING_URL: "http://e:1" })).toThrow(/together/);
    expect(() => readRetrievalConfig({ RERANK_MODEL: "r" })).toThrow(/together/);
    expect(() => readRetrievalConfig({ EMBEDDING_URL: "ftp://e", EMBEDDING_MODEL: "m" })).toThrow(
      /http/,
    );
  });

  it("applies defaults and reads overrides", () => {
    const on = readRetrievalConfig({
      EMBEDDING_URL: "http://e:1/api/embed/",
      EMBEDDING_MODEL: "m",
    });
    expect(on.retrieval).toEqual({
      embedding: { url: "http://e:1/api/embed", model: "m" },
      ...RETRIEVAL_DEFAULTS,
    });
    const tuned = readRetrievalConfig({
      RERANK_URL: "http://r:2/rerank",
      RERANK_MODEL: "rr",
      RETRIEVAL_CANDIDATES: "30",
      RETRIEVAL_RRF_K: "10",
      RERANK_TOP_N: "8",
      RETRIEVAL_MIN_SIMILARITY: "0.3",
    });
    expect(tuned.retrieval).toEqual({
      rerank: { url: "http://r:2/rerank", model: "rr" },
      candidates: 30,
      rrfK: 10,
      rerankTopN: 8,
      minSimilarity: 0.3,
    });
    expect(() =>
      readRetrievalConfig({
        RERANK_URL: "http://r",
        RERANK_MODEL: "x",
        RETRIEVAL_MIN_SIMILARITY: "2",
      }),
    ).toThrow(/between/);
  });
});
