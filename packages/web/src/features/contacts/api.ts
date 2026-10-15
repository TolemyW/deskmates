// Bots as Contacts and the bot management screen: the list, creation, settings, SOUL.md,
// archiving, and the per-bot stored approval rules (ADR-0002) that screen edits. After creation
// (ADR-0043): every field, the SOUL/MEMORY version history, the diary and "Run now".

import type {
  ApprovalRule,
  ApprovalRuleMatcher,
  BotAvatar,
  BotDefinition,
  BotDiaryDay,
  BotDiaryDaySummary,
  BotId,
  BotRuleFile,
  BotRuleVersion,
  BotRuleVersionList,
  BotRuleWriteNotice,
  CronEntry,
  EffortLevel,
  ModelCapabilityView,
  SoulProposal,
  ThinkingConfig,
  VisionProbeView,
  WorkspaceId,
} from "@deskmates/contracts";
import type { MemoryView, RunView } from "../../api/types.js";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface CreateBotInput {
  name: string;
  workspaceId: WorkspaceId;
  role?: string;
  avatar?: BotAvatar;
  model?: string;
  cheapModel?: string;
  connectors?: string[];
  messageAllowlist?: string[];
  /** `false` creates the bot without its welcome run, for a SOUL drafted next (issue #77). */
  welcome?: boolean;
}

/** What `PATCH /api/bots/:id` takes; every key is optional and independent (ADR-0043). */
export interface BotUpdate {
  name?: string;
  role?: string;
  connectors?: string[];
  messageAllowlist?: string[];
  model?: string | null;
  cheapModel?: string | null;
  effort?: EffortLevel | null;
  thinking?: ThinkingConfig | null;
  cron?: CronEntry[];
  avatar?: BotAvatar | null;
  paused?: boolean;
}

/** A restored SOUL or MEMORY: the body now current, its hash, and its new version number. */
export interface RestoredRuleFile extends BotRuleWriteNotice {
  body: string;
  version: string;
  revision: number;
}

export interface ContactsApi {
  applySoulProposal(
    botId: BotId,
    proposalId: string,
  ): Promise<{ proposal: SoulProposal; soul: MemoryView }>;
  archiveBot(id: BotId): Promise<BotDefinition>;
  createApprovalRule(
    botId: BotId,
    matcher: ApprovalRuleMatcher,
    decision: "allow_always" | "deny",
  ): Promise<ApprovalRule>;
  createBot(input: CreateBotInput): Promise<BotDefinition>;
  deleteApprovalRule(id: string): Promise<void>;
  /** Delete one diary line, named by index, exact text and the day's version. */
  deleteDiaryLine(
    botId: BotId,
    day: string,
    line: { line: number; text: string; version: string },
  ): Promise<BotDiaryDay>;
  discardSoulProposal(botId: BotId, proposalId: string): Promise<SoulProposal>;
  getRuleVersion(botId: BotId, file: BotRuleFile, version: number): Promise<BotRuleVersion>;
  getSoul(id: BotId): Promise<MemoryView>;
  getSoulProposal(botId: BotId, proposalId: string): Promise<SoulProposal>;
  /** One page of a bot's approval rules, oldest first, with the total (#113 slice B). */
  listApprovalRules(
    botId: BotId,
    page?: { offset?: number; limit?: number },
  ): Promise<{ rules: ApprovalRule[]; offset: number; limit: number; total: number }>;
  listBots(workspaceId?: WorkspaceId): Promise<BotDefinition[]>;
  listDiaryDays(botId: BotId): Promise<BotDiaryDaySummary[]>;
  /**
   * The named bots the caller may see, for labelling ids (#113 §3.2); asked 100 at a time.
   * Unknown and invisible ids are absent from the answer.
   */
  listBotsByIds(ids: readonly string[]): Promise<BotDefinition[]>;
  /** One page of a workspace's bots by name, with server search (#113 slice B). */
  listBotPage(
    workspaceId: WorkspaceId,
    page: { offset?: number; limit?: number; q?: string },
  ): Promise<{ bots: BotDefinition[]; offset: number; limit: number; total: number }>;
  listModelCapabilities(workspaceId: WorkspaceId): Promise<ModelCapabilityView[]>;
  listRuleVersions(botId: BotId, file: BotRuleFile): Promise<BotRuleVersionList>;
  probeVision(workspaceId: WorkspaceId, model: string): Promise<VisionProbeView>;
  proposeSoul(botId: BotId, instruction: string): Promise<SoulProposal>;
  readDiaryDay(botId: BotId, day: string): Promise<BotDiaryDay>;
  /** Write a saved version's body as a new version; history is never rewritten. */
  restoreRuleVersion(
    botId: BotId,
    file: BotRuleFile,
    version: number,
    expectedVersion: string,
  ): Promise<RestoredRuleFile>;
  /** "Run now" on one cron entry: a background run with trigger `manual`. */
  runCronNow(botId: BotId, entry: number): Promise<RunView>;
  startWelcome(botId: BotId): Promise<void>;
  updateApprovalRule(
    id: string,
    patch: { matcher?: ApprovalRuleMatcher; decision?: "allow_always" | "deny" },
  ): Promise<ApprovalRule>;
  updateBot(id: BotId, patch: BotUpdate): Promise<BotDefinition>;
  writeSoul(
    id: BotId,
    body: string,
    expectedVersion: string,
  ): Promise<MemoryView & BotRuleWriteNotice>;
}

/** The Gateway's cap on ids per name lookup (#113 §3.2). */
const BOT_IDS_PER_REQUEST = 100;

export function createContactsApi(t: HttpTransport): ContactsApi {
  const bot = (id: BotId) => `/api/bots/${encodeURIComponent(id)}`;
  const proposal = (id: BotId, proposalId: string) =>
    `${bot(id)}/soul-proposals/${encodeURIComponent(proposalId)}`;
  const capabilities = (id: WorkspaceId) =>
    `/api/workspaces/${encodeURIComponent(id)}/model-capabilities`;
  return {
    async applySoulProposal(botId, proposalId) {
      return t.json<{ proposal: SoulProposal; soul: MemoryView }>(
        "POST",
        `${proposal(botId, proposalId)}/apply`,
      );
    },
    async archiveBot(id) {
      return (await t.json<{ bot: BotDefinition }>("POST", `${bot(id)}/archive`)).bot;
    },
    async createApprovalRule(botId, matcher, decision) {
      return (
        await t.json<{ rule: ApprovalRule }>("POST", `${bot(botId)}/approval-rules`, {
          matcher,
          decision,
        })
      ).rule;
    },
    async createBot(input) {
      const r = await t.json<{ bot: BotDefinition }>("POST", "/api/bots", stripUndefined(input));
      return r.bot;
    },
    async deleteApprovalRule(id) {
      await t.json<{ deleted: true }>("DELETE", `/api/approval-rules/${encodeURIComponent(id)}`);
    },
    async deleteDiaryLine(botId, day, line) {
      return (
        await t.json<{ day: BotDiaryDay }>(
          "POST",
          `${bot(botId)}/diary/${encodeURIComponent(day)}/delete-line`,
          line,
        )
      ).day;
    },
    async discardSoulProposal(botId, proposalId) {
      return (
        await t.json<{ proposal: SoulProposal }>("POST", `${proposal(botId, proposalId)}/discard`)
      ).proposal;
    },
    async getRuleVersion(botId, file, version) {
      return (
        await t.json<{ version: BotRuleVersion }>(
          "GET",
          `${bot(botId)}/rule-versions/${file}/${encodeURIComponent(String(version))}`,
        )
      ).version;
    },
    async getSoul(id) {
      return (await t.json<{ soul: MemoryView }>("GET", `${bot(id)}/soul`)).soul;
    },
    async getSoulProposal(botId, proposalId) {
      return (await t.json<{ proposal: SoulProposal }>("GET", proposal(botId, proposalId)))
        .proposal;
    },
    listApprovalRules(botId, page = {}) {
      return t.json(
        "GET",
        `${bot(botId)}/approval-rules${query({ offset: page.offset, limit: page.limit })}`,
      );
    },
    listBotPage(workspaceId, page) {
      return t.json(
        "GET",
        `/api/bots${query({ workspaceId, offset: page.offset ?? 0, limit: page.limit, q: page.q })}`,
      );
    },
    async listBots(workspaceId) {
      const r = await t.json<{ bots: BotDefinition[] }>(
        "GET",
        `/api/bots${query({ workspaceId })}`,
      );
      return r.bots;
    },
    async listDiaryDays(botId) {
      return (await t.json<{ days: BotDiaryDaySummary[] }>("GET", `${bot(botId)}/diary`)).days;
    },
    async listBotsByIds(ids) {
      const unique = [...new Set(ids)];
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += BOT_IDS_PER_REQUEST)
        batches.push(unique.slice(i, i + BOT_IDS_PER_REQUEST));
      const answers = await Promise.all(
        batches.map((batch) =>
          t.json<{ bots: BotDefinition[] }>("GET", `/api/bots${query({ ids: batch.join(",") })}`),
        ),
      );
      return answers.flatMap((answer) => answer.bots);
    },
    async listModelCapabilities(workspaceId) {
      return (
        await t.json<{ capabilities: ModelCapabilityView[] }>("GET", capabilities(workspaceId))
      ).capabilities;
    },
    listRuleVersions(botId, file) {
      return t.json<BotRuleVersionList>("GET", `${bot(botId)}/rule-versions/${file}`);
    },
    async probeVision(workspaceId, model) {
      return (
        await t.json<{ probe: VisionProbeView }>(
          "POST",
          `${capabilities(workspaceId)}/vision/probe`,
          { model },
        )
      ).probe;
    },
    async proposeSoul(botId, instruction) {
      return (
        await t.json<{ proposal: SoulProposal }>("POST", `${bot(botId)}/soul-proposals`, {
          instruction,
        })
      ).proposal;
    },
    async readDiaryDay(botId, day) {
      return (
        await t.json<{ day: BotDiaryDay }>("GET", `${bot(botId)}/diary/${encodeURIComponent(day)}`)
      ).day;
    },
    async restoreRuleVersion(botId, file, version, expectedVersion) {
      const r = await t.json<
        { version: number; appliesFromNextRun: boolean } & Partial<Record<BotRuleFile, MemoryView>>
      >(
        "POST",
        `${bot(botId)}/rule-versions/${file}/${encodeURIComponent(String(version))}/restore`,
        { expectedVersion },
      );
      const saved = r[file] ?? { body: "", version: "" };
      return {
        body: saved.body,
        version: saved.version,
        revision: r.version,
        appliesFromNextRun: r.appliesFromNextRun,
      };
    },
    async runCronNow(botId, entry) {
      return (
        await t.json<{ run: RunView }>(
          "POST",
          `${bot(botId)}/cron/${encodeURIComponent(String(entry))}/run`,
          {},
        )
      ).run;
    },
    async startWelcome(botId) {
      await t.json<unknown>("POST", `${bot(botId)}/welcome`);
    },
    async updateApprovalRule(id, patch) {
      return (
        await t.json<{ rule: ApprovalRule }>(
          "PATCH",
          `/api/approval-rules/${encodeURIComponent(id)}`,
          stripUndefined(patch),
        )
      ).rule;
    },
    async updateBot(id, patch) {
      return (await t.json<{ bot: BotDefinition }>("PATCH", bot(id), stripUndefined(patch))).bot;
    },
    async writeSoul(id, body, expectedVersion) {
      const r = await t.json<{ soul: MemoryView; appliesFromNextRun?: boolean }>(
        "PATCH",
        `${bot(id)}/soul`,
        { body, expectedVersion },
      );
      return { ...r.soul, appliesFromNextRun: r.appliesFromNextRun === true };
    },
  };
}
