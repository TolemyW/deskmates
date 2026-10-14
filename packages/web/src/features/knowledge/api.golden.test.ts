// T0 wire golden for the knowledge API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, THR, WS, wireGolden } from "../../platform/http-golden.js";
import { type KnowledgeApi, createKnowledgeApi } from "./api.js";

const CASES: GoldenCases<KnowledgeApi> = {
  cleanupKnowledgeVersions: (a) => a.cleanupKnowledgeVersions(),
  closeThreadTask: (a) => a.closeThreadTask(THR),
  commitMemoryBatch: (a) =>
    a.commitMemoryBatch(WS, { groupKey: "g/1", decision: "merge", token: "tok" }),
  confirmMemoryEntry: (a) => a.confirmMemoryEntry("mem/1"),
  consolidateBotMemory: (a) => a.consolidateBotMemory(BOT),
  editKnowledge: (a) => a.editKnowledge("doc/1", "Title", "Body", 2),
  editMemoryEntry: (a) => a.editMemoryEntry("mem/1", "fact", undefined),
  forgetMemoryEntry: (a) => a.forgetMemoryEntry("mem/1"),
  getKnowledge: (a) => a.getKnowledge("doc/1"),
  listKnowledgeHistory: (a) => a.listKnowledgeHistory("doc/1", { cursor: "c1", limit: 5 }),
  listKnowledgePage: (a) => a.listKnowledgePage({ q: "a&b", offset: 25, limit: 20 }),
  listKnowledgeProposalsPage: (a) => a.listKnowledgeProposalsPage({ status: "pending" }),
  listMemoryEntriesPage: (a) =>
    a.listMemoryEntriesPage(WS, {
      botId: BOT,
      scope: "bot",
      threadId: THR,
      topic: "vendordb",
      includeForgotten: true,
      cursor: "c3",
      limit: 25,
    }),
  listMemoryReviewGroups: (a) => a.listMemoryReviewGroups(WS, { cursor: "c4" }),
  listMemorySuggestions: (a) =>
    a.listMemorySuggestions({ workspaceId: WS, status: "pending", limit: 10 }),
  listMemoryTopics: (a) => a.listMemoryTopics(WS, { offset: 25 }),
  listMemoryVersionsPage: (a) => a.listMemoryVersionsPage("mem/1", { cursor: "c5" }),
  memoryProvenance: (a) => a.memoryProvenance("mem/1"),
  previewMemoryBatch: (a) => a.previewMemoryBatch(WS, { groupKey: "g/1", decision: "reject" }),
  proposeKnowledge: (a) => a.proposeKnowledge("Title", "Body"),
  readMemory: (a) => a.readMemory(BOT),
  reviewKnowledge: (a) => a.reviewKnowledge("prop/1", "approve"),
  reviewMemorySuggestion: (a) =>
    a.reviewMemorySuggestion("sug/1", { decision: "apply", authorId: "user_1" }),
  searchLearnedMemory: (a) => a.searchLearnedMemory(WS, "old facts"),
  searchLearnedMemoryPage: (a) =>
    a.searchLearnedMemoryPage(WS, "old facts", { scope: "bot", cursor: "c2" }),
  undoMemoryBatch: (a) => a.undoMemoryBatch(WS, "mrb_1"),
  undoMemoryEntry: (a) => a.undoMemoryEntry("mem/1"),
  writeMemory: (a) => a.writeMemory(BOT, "notes", "v1"),
};

describe("knowledge API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createKnowledgeApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
