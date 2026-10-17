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
  deleteDiaryLine: (a) =>
    a.deleteDiaryLine(BOT, "2026-10-15", { line: 2, text: "- 09:00 run", version: "v" }),
  discardSoulProposal: (a) => a.discardSoulProposal(BOT, "soulp/1"),
  getRuleVersion: (a) => a.getRuleVersion(BOT, "soul", 3),
  getSoul: (a) => a.getSoul(BOT),
  getSoulProposal: (a) => a.getSoulProposal(BOT, "soulp/1"),
  listApprovalRules: (a) => a.listApprovalRules(BOT, { offset: 25, limit: 25 }),
  listBotPage: (a) => a.listBotPage(WS, { offset: 50, limit: 50, q: "ana" }),
  listBots: (a) => a.listBots(WS),
  listDiaryDays: (a) => a.listDiaryDays(BOT),
  listBotsByIds: (a) => a.listBotsByIds([BOT, "bot/2", BOT]),
  listModelCapabilities: (a) => a.listModelCapabilities(WS),
  listRuleVersions: (a) => a.listRuleVersions(BOT, "memory"),
  probeVision: (a) => a.probeVision(WS, "model-a"),
  proposeSoul: (a) => a.proposeSoul(BOT, "review release notes too"),
  readDiaryDay: (a) => a.readDiaryDay(BOT, "2026-10-15"),
  restoreRuleVersion: (a) => a.restoreRuleVersion(BOT, "soul", 1, "v3"),
  runCronNow: (a) => a.runCronNow(BOT, 0),
  startWelcome: (a) => a.startWelcome(BOT),
  updateApprovalRule: (a) => a.updateApprovalRule("rule/1", { decision: "deny" }),
  updateBot: (a) => a.updateBot(BOT, { model: null, cron: [], name: "ada", paused: true }),
  writeSoul: (a) => a.writeSoul(BOT, "soul", "v2"),
};

describe("contacts API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createContactsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
