// T0 (ADR-0041 decision 4): chunks are bounded, overlap only inside an over-long paragraph, and
// are a pure function of the text, so a chunk's text can be recomputed instead of stored.

import { describe, expect, it } from "vitest";
import { CHUNKING, chunkText, knowledgeChunkInput } from "./chunk.js";
import { applyRerank, reciprocalRankFusion, topByScore } from "./fuse.js";
import { dot, fromBlob, normalize, toBlob } from "./vectors.js";

describe("chunkText", () => {
  it("has no chunk for blank text and one for a short note", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText(" \n\n \t")).toEqual([]);
    expect(chunkText("Backups run nightly.")).toEqual(["Backups run nightly."]);
  });

  it("packs paragraphs up to the limit and starts a new chunk past it", () => {
    const a = "a".repeat(600);
    const b = "b".repeat(500);
    const c = "c".repeat(300);
    expect(chunkText(`${a}\n\n${b}\n\n${c}`)).toEqual([`${a}\n\n${b}`, c]);
  });

  it("windows an over-long paragraph with the overlap, counting code points", () => {
    const long = "备".repeat(3000);
    const chunks = chunkText(long);
    expect(chunks.every((chunk) => Array.from(chunk).length <= CHUNKING.characters)).toBe(true);
    expect(Array.from(chunks[0] ?? "")).toHaveLength(CHUNKING.characters);
    // Consecutive windows share exactly the overlap.
    const step = CHUNKING.characters - CHUNKING.overlap;
    expect(chunks).toHaveLength(Math.ceil((3000 - CHUNKING.overlap) / step));
    expect(chunks.join("").length).toBeGreaterThan(3000);
  });

  it("is deterministic and puts the title first for Knowledge", () => {
    const text = "One.\n\nTwo.\n\n\nThree.";
    expect(chunkText(text)).toEqual(chunkText(text));
    expect(knowledgeChunkInput("Backups", "pg_dump nightly")).toBe("Backups\npg_dump nightly");
  });
});

describe("fusion (decision 5)", () => {
  it("adds reciprocal ranks and breaks ties by id", () => {
    expect(
      reciprocalRankFusion(
        [
          ["a", "b", "c"],
          ["c", "d"],
        ],
        60,
      ),
    ).toEqual(["c", "a", "b", "d"]);
    expect(reciprocalRankFusion([["b"], ["a"]], 60)).toEqual(["a", "b"]);
    // One list keeps its own order.
    expect(reciprocalRankFusion([["z", "y", "x"], []], 60)).toEqual(["z", "y", "x"]);
  });

  it("reorders only the reranked head; ties keep the fused order", () => {
    expect(applyRerank(["a", "b", "c", "d"], [0.1, 0.9, 0.1])).toEqual(["b", "a", "c", "d"]);
  });

  it("keeps the best scores above the floor", () => {
    const scores = new Map([
      ["a", 0.9],
      ["b", 0.3],
      ["c", 0.9],
      ["d", 0.5],
    ]);
    expect(topByScore(scores, 0.45, 2)).toEqual(["a", "c"]);
    expect(topByScore(scores, 0.45, 10)).toEqual(["a", "c", "d"]);
  });
});

describe("vectors (decision 3)", () => {
  it("normalises, round-trips little-endian float32 and scores by dot product", () => {
    const v = normalize([3, 4]);
    expect(Array.from(v)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    const blob = toBlob(v);
    expect(blob.byteLength).toBe(8);
    expect(blob.readFloatLE(0)).toBeCloseTo(0.6);
    // An unaligned buffer (as SQLite may hand back) still reads correctly.
    const unaligned = Buffer.concat([Buffer.from([0]), blob]).subarray(1);
    expect(Array.from(fromBlob(unaligned))).toEqual(Array.from(v));
    expect(dot(v, v)).toBeCloseTo(1);
    expect(dot(v, normalize([1, 2, 3]))).toBe(Number.NEGATIVE_INFINITY);
    expect(Array.from(normalize([0, 0]))).toEqual([0, 0]);
  });
});
