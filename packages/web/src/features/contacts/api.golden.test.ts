// T0 wire golden for the contacts API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type ContactsApi, createContactsApi } from "./api.js";

const CASES: GoldenCases<ContactsApi> = {
  applySoulProposal: (a) => a.applySoulProposal(BOT, "soulp/1"),
  archiveBot: (a) => a.archiveBot(BOT),
  createApprovalRule: (a) => a.createApprovalRule(BOT, { toolName: "browser_click" }, "deny"),
  createBot: (a) => a.createBot({ name: "Ada", workspaceId: WS, role: "analyst" }),
  deleteApprovalRule: (a) => a.deleteApprovalRule("rule/1"),
  discardSoulProposal: (a) => a.discardSoulProposal(BOT, "soulp/1"),
  getSoul: (a) => a.getSoul(BOT),
  getSoulProposal: (a) => a.getSoulProposal(BOT, "soulp/1"),
  listApprovalRules: (a) => a.listApprovalRules(BOT, { offset: 25, limit: 25 }),
  listBotPage: (a) => a.listBotPage(WS, { offset: 50, limit: 50, q: "ana" }),
  listBots: (a) => a.listBots(WS),
  listModelCapabilities: (a) => a.listModelCapabilities(WS),
  probeVision: (a) => a.probeVision(WS, "model-a"),
  proposeSoul: (a) => a.proposeSoul(BOT, "review release notes too"),
  startWelcome: (a) => a.startWelcome(BOT),
  updateBot: (a) => a.updateBot(BOT, { model: null, cron: [] }),
  writeSoul: (a) => a.writeSoul(BOT, "soul", "v2"),
};

describe("contacts API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createContactsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
