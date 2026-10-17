// T0 wire golden for the chats API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, BOT2, type GoldenCases, THR, WS, wireGolden } from "../../platform/http-golden.js";
import { type ChatsApi, createChatsApi } from "./api.js";

const CASES: GoldenCases<ChatsApi> = {
  addThreadMembers: (a) => a.addThreadMembers(THR, [BOT, BOT2]),
  cancelRound: (a) => a.cancelRound(THR, "msg_1"),
  createThread: (a) => a.createThread({ workspaceId: WS, botIds: [BOT] }),
  getThread: (a) => a.getThread(THR),
  listHandoffs: (a) => a.listHandoffs(THR, "c/1"),
  listMessageSlice: (a) => a.listMessageSlice(THR, { beforeSeq: 51, limit: 50 }),
  listMessages: (a) => a.listMessages(THR, 7),
  listRounds: (a) => a.listRounds(THR, 5),
  listThreadPage: (a) => a.listThreadPage(WS, { cursor: "c/1", q: "launch" }),
  listThreads: (a) => a.listThreads(),
  pinThread: (a) => a.pinThread(THR),
  postMessage: (a) =>
    a.postMessage(THR, "hello @Ada", undefined, undefined, [{ uploadId: "upl_1" }]),
  readHandoffs: (a) => a.readHandoffs(THR, 12),
  removeThreadMember: (a) => a.removeThreadMember(THR, BOT),
  resolvePrivateChat: (a) => a.resolvePrivateChat(BOT),
  retryBotWelcome: (a) => a.retryBotWelcome(BOT),
  retryRoundMember: (a) => a.retryRoundMember(THR, "msg_1", BOT),
  unpinThread: (a) => a.unpinThread(THR),
};

describe("chats API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createChatsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
