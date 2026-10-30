// The reference output of every cheap-model task, as the model's reply and as the observation
// an executor would record for it. A T0 test grades these and expects every task to pass, which
// proves each oracle can be met; a scripted upstream for the $0 plumbing phase (P0) would answer
// with `referenceReply`. The organize, recheck and triage references are derived from `expect`.

import { applySoulEdits, boundActivitySummary } from "@deskmates/contracts";
import type { CheapObservation } from "./grade.js";
import type { CheapTask } from "./task-set.js";

/** The reply text a model would give for the reference output, where a reply is graded. */
export function referenceReply(task: CheapTask): string {
  const c = task.case;
  switch (c.kind) {
    case "activity_summary":
      return c.reference ?? "";
    case "memory_consolidation":
      return "";
    case "memory_organize": {
      const labels: { id: string; label: string }[] = [];
      c.expect.clusters.forEach((cluster, i) => {
        for (const key of cluster) labels.push({ id: key, label: `Topic ${i + 1}` });
      });
      let n = c.expect.clusters.length;
      for (const note of c.input.notes)
        if (!labels.some((l) => l.id === note.key)) {
          n += 1;
          labels.push({ id: note.key, label: `Topic ${n}` });
        }
      const splits = Object.entries(c.reference?.splits ?? {}).map(([id, parts]) => ({
        id,
        parts,
      }));
      return JSON.stringify({ labels, splits });
    }
    case "memory_recheck":
      return JSON.stringify({
        verdicts: c.input.notes.map((note) => ({
          id: note.key,
          verdict: c.expect.verdicts[note.key] ?? "unclear",
          reason: "reference",
        })),
      });
    case "round_triage": {
      const names = [...c.expect.requiredAll];
      for (const group of c.expect.requiredAny)
        if (!group.some((m) => names.includes(m)) && group[0]) names.push(group[0]);
      if (names.length === 0) {
        const fallback = c.input.roster.find((m) => !c.expect.forbidden.includes(m.name));
        if (fallback) names.push(fallback.name);
      }
      const closer = c.expect.closers.find((m) => names.includes(m)) ?? names[0] ?? "";
      return JSON.stringify({
        assignments: names.map((member) => ({ member, task: `Handle your part of: ${member}` })),
        closer,
      });
    }
    case "soul_proposal":
      return JSON.stringify(c.reference ?? { edits: [] });
  }
}

/** The observation an executor would record if the job returned the reference output. */
export function referenceObservation(
  task: CheapTask,
  arm = "reference",
  repeat = 1,
): CheapObservation {
  const c = task.case;
  const base: CheapObservation = {
    taskId: task.taskId,
    arm,
    repeat,
    status: "succeeded",
    reply: referenceReply(task),
    costUsd: 0,
  };
  switch (c.kind) {
    case "activity_summary":
      return { ...base, summaryText: boundActivitySummary(c.reference ?? "") };
    case "memory_consolidation": {
      const learned = c.reference ?? [];
      return {
        ...base,
        learned,
        probes: c.expect.probes.map((p) => ({
          query: p.query,
          hits: learned.filter((b) => b.toLowerCase().includes(p.expect.toLowerCase())),
        })),
      };
    }
    case "round_triage": {
      const reply = JSON.parse(referenceReply(task)) as {
        assignments: { member: string }[];
        closer: string;
      };
      return {
        ...base,
        plan: { assigned: reply.assignments.map((a) => a.member), closer: reply.closer },
      };
    }
    case "soul_proposal": {
      const ref = c.reference ?? { edits: [] };
      const applied = applySoulEdits(c.input.baseBody, ref.edits, ref.append);
      return {
        ...base,
        proposal: applied.ok
          ? { status: "ready", proposedBody: applied.body, error: null }
          : { status: "failed", proposedBody: null, error: applied.error },
      };
    }
    default:
      return base;
  }
}
