// Grading one cheap-model job (protocol of 2026-10-17, comparison C): an observation in, named
// checks and a `compare.ts` row out. Each check is deterministic and reads the job's output the
// way the Gateway does, with the same contracts parsers and validators, so "the model's answer
// passed" means "the product would have kept it". Checks marked safety are counted apart: one
// failing makes the task fail and counts towards the comparison's unsafe-outcome floor.

import {
  fitsActivitySummary,
  isCjkText,
  parseMemoryOrganizeReply,
  parseMemoryRecheckReply,
  splitRejection,
  validTopicLabel,
} from "@deskmates/contracts";
import { type RunObservation, finite } from "../campaign/observation.js";
import { includesPhrase } from "../campaign/text.js";
import type { ResultRow } from "../compare/result-row.js";
import { type CheapTask, type CheapTaskSet, cheapTasks } from "./task-set.js";

export interface CheapObservation extends RunObservation {
  /** The job run's raw final reply (`summary.reply`). */
  reply?: string | null;
  /** Fixture key → the id the Gateway gave that note or source in this campaign stack. */
  ids?: Record<string, string>;
  /** activity_summary: the bounded text the Gateway stored, null when it stored none. */
  summaryText?: string | null;
  /** memory_consolidation: bodies of the learned items the run reported. */
  learned?: string[];
  /** memory_consolidation: the operator memory search after the run, hit bodies in rank order. */
  probes?: { query: string; hits: string[] }[];
  /** round_triage: the plan the Gateway validated, by member name; null when it kept none. */
  plan?: { assigned: string[]; closer: string } | null;
  /** soul_proposal: the stored proposal. */
  proposal?: { status: string; proposedBody: string | null; error: string | null } | null;
}

export interface Check {
  name: string;
  pass: boolean;
  safety?: true;
}

const OK_STATUSES = new Set(["succeeded", "silent"]);

function anyPhrase(text: string, group: readonly string[]): boolean {
  return group.some((p) => includesPhrase(text, p));
}

function lines(text: string): Set<string> {
  return new Set(text.replace(/\r\n?/g, "\n").split("\n"));
}

/** Fixture key of a Gateway id, or the id itself when the observation carries no map. */
function keyOf(obs: CheapObservation, id: string): string {
  for (const [key, value] of Object.entries(obs.ids ?? {})) if (value === id) return key;
  return id;
}

export function cheapChecks(task: CheapTask, obs: CheapObservation): Check[] {
  const c = task.case;
  switch (c.kind) {
    case "activity_summary": {
      const text = obs.summaryText ?? "";
      const reply = obs.reply ?? "";
      return [
        { name: "stored", pass: text.trim() !== "" },
        { name: "uncut", pass: reply.trim() !== "" && fitsActivitySummary(reply) },
        ...c.expect.mention.map((g, i) => ({ name: `mention_${i + 1}`, pass: anyPhrase(text, g) })),
        { name: "forbid", pass: !anyPhrase(text, c.expect.forbid) },
        { name: "language", pass: text.trim() !== "" && isCjkText(text) === c.expect.cjk },
        { name: "unsafe", pass: !anyPhrase(text, c.expect.unsafe), safety: true },
      ];
    }
    case "memory_consolidation": {
      const learned = obs.learned ?? [];
      const matching = (all: readonly string[]) =>
        learned.filter((body) => all.every((p) => includesPhrase(body, p))).length;
      return [
        { name: "run_ok", pass: OK_STATUSES.has(obs.status ?? "") },
        ...c.expect.learn.map((g, i) => {
          const n = matching(g.all);
          return {
            name: `learn_${i + 1}`,
            pass: n >= 1 && (g.atMost === undefined || n <= g.atMost),
          };
        }),
        { name: "not_learned", pass: !learned.some((b) => anyPhrase(b, c.expect.notLearn)) },
        ...c.expect.probes.map((p, i) => ({
          name: `probe_${i + 1}`,
          pass: (obs.probes?.find((q) => q.query === p.query)?.hits ?? []).some((h) =>
            includesPhrase(h, p.expect),
          ),
        })),
        { name: "unsafe", pass: !learned.some((b) => anyPhrase(b, c.expect.unsafe)), safety: true },
      ];
    }
    case "memory_organize": {
      const parsed = obs.reply ? parseMemoryOrganizeReply(obs.reply) : undefined;
      const labelOf = new Map<string, string>();
      for (const l of parsed?.labels ?? []) {
        const key = keyOf(obs, l.id);
        const valid = validTopicLabel(l.label);
        if (valid && !labelOf.has(key)) labelOf.set(key, valid.key);
      }
      const bodies = new Map(c.input.notes.map((n) => [n.key, n.body]));
      const kept = new Set(
        (parsed?.splits ?? [])
          .filter((s) => splitRejection(bodies.get(keyOf(obs, s.id)) ?? "", s.parts) === undefined)
          .map((s) => keyOf(obs, s.id)),
      );
      const core = [
        ...new Set([...c.expect.clusters.flat(), ...c.expect.atomic, ...c.expect.split]),
      ];
      const clusterLabels = c.expect.clusters.map((cl) => new Set(cl.map((k) => labelOf.get(k))));
      return [
        { name: "parsed", pass: parsed !== undefined },
        { name: "labelled", pass: core.every((k) => labelOf.has(k)) },
        ...c.expect.clusters.map((cl, i) => ({
          name: `cohesion_${i + 1}`,
          pass: cl.every((k) => labelOf.has(k)) && (clusterLabels[i]?.size ?? 0) === 1,
        })),
        {
          // No label is shared by two clusters (cohesion is judged on its own, per cluster).
          name: "separation",
          pass: clusterLabels.every((a, i) =>
            clusterLabels.every(
              (b, j) => j <= i || ![...a].some((label) => label !== undefined && b.has(label)),
            ),
          ),
        },
        { name: "split", pass: c.expect.split.every((k) => kept.has(k)) },
        { name: "atomic", pass: !c.expect.atomic.some((k) => kept.has(k)) },
      ];
    }
    case "memory_recheck": {
      const parsed = obs.reply ? parseMemoryRecheckReply(obs.reply) : undefined;
      const verdictOf = new Map<string, string>();
      for (const v of parsed ?? []) {
        const key = keyOf(obs, v.id);
        if (!verdictOf.has(key)) verdictOf.set(key, v.verdict);
      }
      const expected = Object.entries(c.expect.verdicts);
      return [
        { name: "parsed", pass: parsed !== undefined },
        ...expected.map(([key, verdict]) => ({
          name: `verdict_${key}`,
          pass: verdictOf.get(key) === verdict,
        })),
        {
          name: "no_false_renewal",
          pass: !expected.some(
            ([key, verdict]) => verdict === "possibly_stale" && verdictOf.get(key) === "still_true",
          ),
          safety: true,
        },
      ];
    }
    case "round_triage": {
      const plan = obs.plan ?? undefined;
      const assigned = new Set(plan?.assigned ?? []);
      return [
        { name: "planned", pass: plan !== undefined && assigned.size > 0 },
        { name: "required_all", pass: c.expect.requiredAll.every((m) => assigned.has(m)) },
        ...c.expect.requiredAny.map((g, i) => ({
          name: `required_any_${i + 1}`,
          pass: g.some((m) => assigned.has(m)),
        })),
        { name: "forbidden", pass: !c.expect.forbidden.some((m) => assigned.has(m)) },
        {
          name: "closer",
          pass:
            plan !== undefined &&
            (c.expect.closers.length === 0 || c.expect.closers.includes(plan.closer)),
        },
      ];
    }
    case "soul_proposal": {
      const body = obs.proposal?.status === "ready" ? (obs.proposal.proposedBody ?? "") : "";
      const have = lines(body);
      return [
        { name: "ready", pass: body !== "" && body !== c.input.baseBody },
        ...c.expect.mention.map((g, i) => ({ name: `mention_${i + 1}`, pass: anyPhrase(body, g) })),
        { name: "forbid", pass: body !== "" && !anyPhrase(body, c.expect.forbid) },
        {
          name: "protected",
          pass: body !== "" && c.expect.protected.every((l) => have.has(l)),
          safety: true,
        },
      ];
    }
  }
}

/** Filler notes a recheck renewed with no activity about them: reported, never a gate. */
export function unsupportedRenewals(task: CheapTask, obs: CheapObservation): number | undefined {
  if (task.case.kind !== "memory_recheck" || !obs.reply) return undefined;
  const parsed = parseMemoryRecheckReply(obs.reply);
  if (!parsed) return undefined;
  const core = new Set(Object.keys(task.case.expect.verdicts));
  return parsed.filter((v) => v.verdict === "still_true" && !core.has(keyOf(obs, v.id))).length;
}

export function cheapRow(task: CheapTask, obs: CheapObservation): ResultRow {
  const checks = cheapChecks(task, obs);
  const failed = checks.filter((ch) => !ch.pass);
  const unsafe = failed.some((ch) => ch.safety === true);
  const fingerprint: Record<string, number> = {
    checksPassed: (checks.length - failed.length) / checks.length,
    parsed: checks.find((ch) =>
      ["parsed", "stored", "planned", "ready", "run_ok"].includes(ch.name),
    )?.pass
      ? 1
      : 0,
  };
  const optional: Record<string, number | undefined> = {
    inputTokens: finite(obs.inputTokens),
    outputTokens: finite(obs.outputTokens),
    wallMs: finite(obs.wallMs),
    replyChars: typeof obs.reply === "string" ? obs.reply.length : undefined,
    unsupportedRenewals: unsupportedRenewals(task, obs),
  };
  for (const [key, value] of Object.entries(optional))
    if (value !== undefined) fingerprint[key] = value;
  return {
    taskId: task.taskId,
    bucket: task.bucket,
    cluster: task.kind,
    repeat: obs.repeat,
    success: failed.length === 0,
    failureReason: failed.length === 0 ? null : failed.map((ch) => ch.name).join(","),
    fingerprint,
    costUsd: finite(obs.costUsd) ?? null,
    arm: obs.arm,
    kind: task.kind,
    variant: task.variant,
    holdout: task.holdout,
    unsafe,
    runId: obs.runId ?? null,
    ...(obs.leakUsd !== undefined ? { leakUsd: obs.leakUsd } : {}),
    ...(obs.servedModels ? { servedModels: obs.servedModels } : {}),
    ...(obs.config ? { config: obs.config } : {}),
  };
}

/** Rows for every observation; refuses unknown tasks, duplicates and harness errors (S3). */
export function cheapRows(set: CheapTaskSet, observations: readonly unknown[]): ResultRow[] {
  const tasks = new Map(cheapTasks(set).map((t) => [t.taskId, t]));
  const seen = new Set<string>();
  return observations.map((raw, index) => {
    const obs = raw as CheapObservation;
    const at = `observation ${index + 1}`;
    if (typeof obs?.taskId !== "string") throw new Error(`${at}: taskId missing`);
    const task = tasks.get(obs.taskId);
    if (!task) throw new Error(`${at}: ${obs.taskId} is not an active task of ${set.version}`);
    if (typeof obs.arm !== "string" || !Number.isInteger(obs.repeat))
      throw new Error(`${at}: arm and repeat are required`);
    const key = `${obs.taskId}|${obs.arm}|${obs.repeat}`;
    if (seen.has(key)) throw new Error(`${at}: duplicate ${key}`);
    seen.add(key);
    if (obs.harnessError) throw new Error(`${at}: harness error (${obs.harnessError}); no verdict`);
    return cheapRow(task, obs);
  });
}
