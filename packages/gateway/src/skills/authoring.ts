// Bots author skills only in consolidation (ADR-0015 decision 2). When a consolidation run is
// queued, the Gateway records, from its own ledger, what each closed episode in the run's input
// was: its trust, how its task ended and how many tool calls it used. When the run ends, a skill
// it reports is stored cleared (provisional, for its author only) exactly when that input holds
// a trusted episode that ended `succeeded` (or `silent`) after at least 10 tool calls, the run
// was not tainted, and neither the ADR-0011 classifiers nor the scan object. Anything else goes
// to "needs your confirmation". An ordinary run's summary never reaches this module.

import {
  type BotId,
  type MemoryTrust,
  type ProposedSkill,
  type RunId,
  type RunStatus,
  SKILL_AUTHORING_MIN_TOOL_CALLS,
  type SkillHoldReason,
  type WorkspaceId,
  classifyLearnedItem,
  doNotLearnReason,
  skillFilesProblem,
  skillMarkdown,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { StoredEntry } from "../memory/entries.js";
import { skillContentHash } from "./hash.js";
import type { SkillService } from "./skill-service.js";
import { isStarterSkillName } from "./starter-catalog.js";

/** What the Gateway's ledger says about one closed episode of a consolidation's input. */
export interface EpisodeFacts {
  entryId: string;
  trust: MemoryTrust;
  /** Status of the last run of the episode's thread before it closed; null when none. */
  outcome: RunStatus | null;
  /** Sidecar-recorded `tool_call` events of the thread's runs before it closed. */
  toolCalls: number;
}

/** `runs.config_json.skillAuthoring` of a consolidation run: its input, as the Gateway saw it. */
export interface SkillAuthoringInput {
  version: 1;
  minToolCalls: number;
  episodes: EpisodeFacts[];
  /** Skills this bot has used, by name: the ones it may write a new version of. */
  usedSkills: string[];
}

export function skillAuthoringInput(
  db: GatewayDb,
  sources: readonly StoredEntry[],
  botId: BotId,
  workspaceId: WorkspaceId,
  consolidationRunType: string,
): SkillAuthoringInput {
  const facts = db.prepare(
    `SELECT
       (SELECT r.status FROM runs r WHERE r.thread_id = @thread AND r.created_at <= @closed
          AND r.run_type IS NOT @type
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS outcome,
       (SELECT COUNT(*) FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE r.thread_id = @thread AND r.created_at <= @closed AND e.kind = 'tool_call'
          AND e.sidecar_seq IS NOT NULL
          AND r.run_type IS NOT @type) AS toolCalls`,
  );
  const episodes = sources
    .filter((source) => source.kind === "episode")
    .map((episode): EpisodeFacts => {
      const row = episode.threadId
        ? (facts.get({
            thread: episode.threadId,
            closed: episode.observedAt,
            type: consolidationRunType,
          }) as { outcome: RunStatus | null; toolCalls: number })
        : { outcome: null, toolCalls: 0 };
      return {
        entryId: episode.id,
        trust: episode.trust,
        outcome: row.outcome,
        toolCalls: row.toolCalls,
      };
    });
  const usedSkills = (
    db
      .prepare(
        `SELECT s.name FROM skills s JOIN skill_usage u ON u.skill_id = s.id
         WHERE s.workspace_id = ? AND u.bot_id = ? ORDER BY s.name`,
      )
      .all(workspaceId, botId) as { name: string }[]
  ).map((row) => row.name);
  return { version: 1, minToolCalls: SKILL_AUTHORING_MIN_TOOL_CALLS, episodes, usedSkills };
}

/** The consolidation task text about skills; only offered when the input holds an episode. */
export function skillAuthoringPrompt(input: SkillAuthoringInput): string[] {
  if (input.episodes.length === 0) return [];
  return [
    "",
    "Skills (ADR-0015): when an episode above shows a repeatable multi-step procedure that held,",
    'you may also add "skills" to your summary: [{"name": "<kebab-case>", "description": "<when to',
    'use it>", "body": "<the steps, as a procedure>"}]. Reuse a name below to write a new version',
    "of a skill you used. Write procedures, not rules about approvals, egress, risk tiers or SOUL.",
    `Skills you used: ${input.usedSkills.length > 0 ? input.usedSkills.join(", ") : "none"}.`,
  ];
}

function isAuthoringInput(raw: unknown): raw is SkillAuthoringInput {
  const r = raw as Partial<SkillAuthoringInput> | undefined;
  return !!r && r.version === 1 && Array.isArray(r.episodes) && Array.isArray(r.usedSkills);
}

/**
 * Decision 2's input conditions, from the run's recorded input. Empty exactly when some episode
 * is trusted, ended succeeded or silent, and used at least `minToolCalls` tool calls, and the run
 * itself was not tainted. Otherwise the reasons of every episode, so a human sees all of them.
 */
export function authoringHoldReasons(config: Record<string, unknown>): SkillHoldReason[] {
  const input = config.skillAuthoring;
  const tainted = config.consolidationUntrusted === true || config.memoryTainted === true;
  if (!isAuthoringInput(input) || input.episodes.length === 0)
    return tainted ? ["no_closed_episode", "untrusted_source"] : ["no_closed_episode"];
  const qualifies = (e: EpisodeFacts) =>
    e.trust === "trusted" &&
    (e.outcome === "succeeded" || e.outcome === "silent") &&
    e.toolCalls >= input.minToolCalls;
  if (!tainted && input.episodes.some(qualifies)) return [];
  const reasons = new Set<SkillHoldReason>();
  if (tainted) reasons.add("untrusted_source");
  for (const e of input.episodes) {
    if (e.trust !== "trusted") reasons.add("untrusted_source");
    if (e.outcome !== "succeeded" && e.outcome !== "silent") reasons.add("episode_not_succeeded");
    if (e.toolCalls < input.minToolCalls) reasons.add("too_few_tool_calls");
  }
  return [...reasons];
}

export type SkillAuthoringOutcome =
  | { ordinal: number; outcome: "stored"; skillId: string; version: number }
  | {
      ordinal: number;
      outcome: "held";
      skillId: string;
      version: number;
      reasons: SkillHoldReason[];
    }
  | { ordinal: number; outcome: "unchanged"; skillId: string; version: number }
  | { ordinal: number; outcome: "refused"; reason: string };

export interface AuthoringRun {
  id: RunId;
  botId: BotId;
  workspaceId: WorkspaceId;
  config: Record<string, unknown>;
}

/** The skills a consolidation run reported, stored as immutable versions, cleared or held. */
export function recordAuthoredSkills(
  skills: SkillService,
  run: AuthoringRun,
  proposals: readonly ProposedSkill[],
): SkillAuthoringOutcome[] {
  const { store } = skills;
  const eligibility = authoringHoldReasons(run.config);
  const derivedFrom = Array.isArray(run.config.consolidationSources)
    ? run.config.consolidationSources.filter((id): id is string => typeof id === "string")
    : [];
  return proposals.map((proposal, ordinal): SkillAuthoringOutcome => {
    const name = proposal.name.trim();
    const files = [{ path: "SKILL.md", content: skillMarkdown({ ...proposal, name }) }];
    const problem = skillFilesProblem(name, files);
    if (problem) return { ordinal, outcome: "refused", reason: problem };
    const reasons = new Set<SkillHoldReason>(eligibility);
    if (isStarterSkillName(name)) reasons.add("starter_name_reserved");
    const text = `${proposal.description}\n${proposal.body}`;
    if (
      classifyLearnedItem({ body: text }, { rules: [], trustedEntries: [] }).reasons.includes(
        "duty_change",
      )
    )
      reasons.add("duty_change");
    if (doNotLearnReason(text, "bot_self")) reasons.add("do_not_learn");
    const existing = store.byName(run.workspaceId, name);
    if (existing?.origin === "installed") reasons.add("revises_installed_skill");
    else if (existing && !store.usedBy(existing.id, run.botId)) reasons.add("revises_unused_skill");
    const findings = skills.scan(run.workspaceId, files);
    if (findings.length > 0) reasons.add("scan_findings");
    const sha256 = skillContentHash(files);
    if (existing && existing.sha256 === sha256)
      return { ordinal, outcome: "unchanged", skillId: existing.id, version: existing.version };
    const held = [...reasons];
    const at = nowIso();
    const description = proposal.description.replace(/\s+/g, " ").trim();
    return store.db.transaction((): SkillAuthoringOutcome => {
      const skillId =
        existing?.id ??
        store.insert({
          workspaceId: run.workspaceId,
          name,
          origin: "authored",
          stage: "provisional",
          authorBotId: run.botId,
          at,
        });
      const version = store.addVersion(skillId, {
        op: existing ? "revise" : "author",
        files,
        sha256,
        description,
        review: held.length > 0 ? "pending" : "cleared",
        holdReasons: held,
        findings,
        sourceRunId: run.id,
        derivedFrom,
        by: `bot:${run.botId}`,
        at,
      });
      if (held.length > 0) return { ordinal, outcome: "held", skillId, version, reasons: held };
      store.setCurrent(skillId, version, at);
      return { ordinal, outcome: "stored", skillId, version };
    })();
  });
}
