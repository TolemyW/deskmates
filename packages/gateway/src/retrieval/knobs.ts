// ADR-0041 decision 9: what `runs.config_json` records of retrieval. Absent when unconfigured, so
// earlier and unconfigured run rows stay comparable.

import type { RetrievalSettings } from "../config/retrieval.js";
import { CHUNKING } from "./chunk.js";

export function retrievalKnobs(settings: RetrievalSettings): Record<string, unknown> {
  return {
    version: 1,
    ...(settings.embedding ? { embeddingModel: settings.embedding.model } : {}),
    ...(settings.rerank ? { rerankModel: settings.rerank.model } : {}),
    candidates: settings.candidates,
    rrfK: settings.rrfK,
    rerankTopN: settings.rerankTopN,
    minSimilarity: settings.minSimilarity,
    chunkVersion: CHUNKING.version,
    chunkCharacters: CHUNKING.characters,
    chunkOverlap: CHUNKING.overlap,
  };
}
