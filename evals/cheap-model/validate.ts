// The checks that make the cheap-model task set's oracles deterministic and meetable (protocol
// of 2026-10-17, comparison C). A failing check is a broken task set, never a model result.

import {
  ACTIVITY_SUMMARY_SOURCE_MAX,
  MEMORY_ORGANIZE_MAX_NOTES,
  MEMORY_RECHECK_MAX_NOTES,
  SOUL_PROPOSAL_INSTRUCTION_MAX_CHARS,
  applySoulEdits,
  classifyLearnedItem,
  fitsActivitySummary,
  splitRejection,
} from "@deskmates/contracts";
import { FILLER_MEMBERS, FILLER_SENTENCES, includesPhrase } from "../campaign/text.js";
import { cheapChecks, cheapRow } from "./grade.js";
import { referenceObservation } from "./reference.js";
import {
  CHEAP_JOB_KINDS,
  type CheapCase,
  type CheapTaskSet,
  activitySource,
  cheapTasks,
  cheapVariantsDigest,
} from "./task-set.js";

/** Gateway bounds the task set must stay inside; mirrored, with the module that owns each. */
export const GATEWAY_BOUNDS = {
  /** `model-jobs/round-triage.ts` TRIAGE_REQUEST_MAX_CHARS. */
  triageRequestChars: 8000,
  /** `memory/recheck.ts` RECHECK_ACTIVITY_LIMITS.messageChars and messagesPerThread. */
  recheckMessageChars: 500,
  recheckMessagesPerThread: 15,
  /** `model-jobs/soul-proposals.ts` SOUL_MAX_BYTES. */
  soulBytes: 65536,
} as const;

const PREFIX: Record<CheapCase["kind"], string> = {
  activity_summary: "AS-",
  memory_consolidation: "CS-",
  memory_organize: "OR-",
  memory_recheck: "RC-",
  round_triage: "RT-",
  soul_proposal: "SP-",
};

/** Every phrase an oracle looks for: none may come from filler text. */
function oraclePhrases(c: CheapCase): string[] {
  switch (c.kind) {
    case "activity_summary":
      return [...c.expect.mention.flat(), ...c.expect.forbid, ...c.expect.unsafe];
    case "memory_consolidation":
      return [
        ...c.expect.learn.flatMap((l) => l.all),
        ...c.expect.notLearn,
        ...c.expect.unsafe,
        ...c.expect.probes.map((p) => p.expect),
      ];
    case "soul_proposal":
      return [...c.expect.mention.flat(), ...c.expect.forbid];
    default:
      return [];
  }
}

function validateCase(c: CheapCase, add: (msg: string) => void): void {
  const at = `case ${c.id}`;
  switch (c.kind) {
    case "activity_summary": {
      const source = activitySource(c.input);
      if (fitsActivitySummary(source)) add(`${at}: its source fits the bound, so no job would run`);
      if (c.reference === undefined) add(`${at}: needs a reference summary`);
      else if (!fitsActivitySummary(c.reference))
        add(`${at}: the reference does not fit the bound`);
      if (c.expect.mention.some((g) => g.length === 0)) add(`${at}: an empty mention group`);
      break;
    }
    case "memory_consolidation": {
      const keys = c.input.sources.map((s) => s.key);
      if (new Set(keys).size !== keys.length) add(`${at}: duplicate source key`);
      if (!c.reference || c.reference.length === 0) add(`${at}: needs reference learned items`);
      for (const body of c.reference ?? [])
        if (classifyLearnedItem({ body }, { rules: [] }).decision === "gate")
          add(`${at}: reference item is gated: ${body}`);
      if (c.expect.probes.length === 0) add(`${at}: needs a memory_search probe`);
      break;
    }
    case "memory_organize": {
      const keys = new Set(c.input.notes.map((n) => n.key));
      if (keys.size !== c.input.notes.length) add(`${at}: duplicate note key`);
      for (const k of [...c.expect.clusters.flat(), ...c.expect.split, ...c.expect.atomic])
        if (!keys.has(k)) add(`${at}: unknown note ${k}`);
      if (c.expect.split.some((k) => c.expect.atomic.includes(k))) add(`${at}: split and atomic`);
      if (c.expect.clusters.some((cl) => cl.length < 2)) add(`${at}: a cluster has 2+ notes`);
      const splits = c.reference?.splits ?? {};
      if (Object.keys(splits).sort().join() !== [...c.expect.split].sort().join())
        add(`${at}: reference splits are exactly the expected ones`);
      for (const [key, parts] of Object.entries(splits)) {
        const body = c.input.notes.find((n) => n.key === key)?.body ?? "";
        const why = splitRejection(body, parts);
        if (why) add(`${at}: reference split of ${key} is rejected (${why})`);
      }
      break;
    }
    case "memory_recheck": {
      const keys = c.input.notes.map((n) => n.key);
      if (Object.keys(c.expect.verdicts).sort().join() !== [...keys].sort().join())
        add(`${at}: a verdict for every note and no other`);
      if (!Object.values(c.expect.verdicts).includes("possibly_stale"))
        add(`${at}: needs a contradicted note for the safety check`);
      for (const m of c.input.activity)
        if (m.body.length > GATEWAY_BOUNDS.recheckMessageChars) add(`${at}: message too long`);
      break;
    }
    case "round_triage": {
      const names = c.input.roster.map((m) => m.name);
      if (new Set(names).size !== names.length) add(`${at}: duplicate member`);
      if (c.input.roster.filter((m) => m.owner).length !== 1) add(`${at}: exactly one owner`);
      const all = [
        ...c.expect.requiredAll,
        ...c.expect.requiredAny.flat(),
        ...c.expect.forbidden,
        ...c.expect.closers,
      ];
      for (const n of all) if (!names.includes(n)) add(`${at}: ${n} is not a member`);
      if (c.expect.requiredAll.some((n) => c.expect.forbidden.includes(n)))
        add(`${at}: required and forbidden`);
      if (c.expect.requiredAll.length === 0 && c.expect.requiredAny.length === 0)
        add(`${at}: requires someone`);
      break;
    }
    case "soul_proposal": {
      const lines = new Set(c.input.baseBody.split("\n"));
      for (const l of c.expect.protected)
        if (!lines.has(l)) add(`${at}: protected line not in base`);
      for (const f of c.expect.forbid)
        if (!includesPhrase(c.input.baseBody, f)) add(`${at}: forbidden ${f} is not in the base`);
      if (c.input.instruction.length > SOUL_PROPOSAL_INSTRUCTION_MAX_CHARS)
        add(`${at}: instruction too long`);
      if (!c.reference) add(`${at}: needs reference edits`);
      else if (!applySoulEdits(c.input.baseBody, c.reference.edits, c.reference.append).ok)
        add(`${at}: reference edits do not apply`);
      break;
    }
  }
}

export function validateCheapTaskSet(set: CheapTaskSet): string[] {
  const problems: string[] = [];
  const add = (msg: string) => problems.push(msg);
  const ids = new Set<string>();
  if (cheapVariantsDigest(set) !== set.large.sha256)
    add("generated large variants differ from the frozen digest: bump the task-set version");
  for (const c of set.cases) {
    if (ids.has(c.id)) add(`duplicate case id ${c.id}`);
    ids.add(c.id);
    if (!(CHEAP_JOB_KINDS as readonly string[]).includes(c.kind)) {
      add(`case ${c.id}: unknown kind ${c.kind}`);
      continue;
    }
    if (!c.id.startsWith(PREFIX[c.kind])) add(`case ${c.id}: id must start with ${PREFIX[c.kind]}`);
    validateCase(c, add);
    for (const phrase of oraclePhrases(c))
      if (FILLER_SENTENCES.some((s) => includesPhrase(s, phrase)))
        add(`case ${c.id}: filler text contains the oracle phrase ${phrase}`);
  }
  const active = set.cases.filter((c) => c.status === "active");
  const perKind = CHEAP_JOB_KINDS.map((k) => active.filter((c) => c.kind === k).length);
  if (new Set(perKind).size !== 1) add(`every job kind has the same number of cases: ${perKind}`);
  for (const k of CHEAP_JOB_KINDS)
    if (!active.some((c) => c.kind === k && c.holdout)) add(`${k} has no held-out case`);
  for (const id of set.ceiling.smoke_cases) if (!ids.has(id)) add(`smoke case ${id} is unknown`);
  for (const m of FILLER_MEMBERS)
    if (
      active.some((c) => c.kind === "round_triage" && c.input.roster.some((r) => r.name === m.name))
    )
      add(`filler member ${m.name} collides with a roster`);
  for (const task of cheapTasks(set)) {
    const c = task.case;
    const at = `task ${task.taskId}`;
    // Oracle determinism and satisfiability: the reference passes, twice the same way, and an
    // observation of a job that produced nothing fails.
    const ref = referenceObservation(task);
    const first = cheapRow(task, ref);
    if (!first.success) add(`${at}: the reference output fails ${first.failureReason}`);
    if (JSON.stringify(cheapRow(task, ref)) !== JSON.stringify(first))
      add(`${at}: not deterministic`);
    const empty = cheapChecks(task, { taskId: task.taskId, arm: "x", repeat: 1, status: "failed" });
    if (empty.every((ch) => ch.pass)) add(`${at}: an empty output passes`);
    if (
      c.kind === "activity_summary" &&
      activitySource(c.input).length > ACTIVITY_SUMMARY_SOURCE_MAX
    )
      add(`${at}: source over ${ACTIVITY_SUMMARY_SOURCE_MAX} characters would be cut`);
    if (c.kind === "memory_organize" && c.input.notes.length > MEMORY_ORGANIZE_MAX_NOTES)
      add(`${at}: over ${MEMORY_ORGANIZE_MAX_NOTES} notes`);
    if (c.kind === "memory_recheck") {
      if (c.input.notes.length > MEMORY_RECHECK_MAX_NOTES)
        add(`${at}: over ${MEMORY_RECHECK_MAX_NOTES} notes`);
      const filler = c.input.fillerActivity ?? [];
      if (filler.length > GATEWAY_BOUNDS.recheckMessagesPerThread)
        add(`${at}: too many filler messages`);
      if (filler.some((m) => m.length > GATEWAY_BOUNDS.recheckMessageChars))
        add(`${at}: filler message too long`);
    }
    if (c.kind === "round_triage" && c.input.request.length > GATEWAY_BOUNDS.triageRequestChars)
      add(`${at}: request over ${GATEWAY_BOUNDS.triageRequestChars} characters`);
    if (
      c.kind === "soul_proposal" &&
      Buffer.byteLength(c.input.baseBody) > GATEWAY_BOUNDS.soulBytes
    )
      add(`${at}: SOUL over ${GATEWAY_BOUNDS.soulBytes} bytes`);
  }
  return problems;
}
