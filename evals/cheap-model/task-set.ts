// The cheap-model task set (`evals/tasks/cheap-model-v1.json`; protocol of 2026-10-17, comparison
// C): one group of cases per job kind that ADR-0023 decision 2 runs on `CHEAP_MODEL`, each case
// in a small and a large variant. The large variant is the small one padded with `filler-v1`
// text towards the job's input bound, so the two buckets differ in input size only.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf } from "../campaign/digest.js";
import { FILLER_MEMBERS, fillerNotes, fillerParagraph } from "../campaign/text.js";
import type { DurationBucket } from "../compare/result-row.js";

/** ADR-0023 decision 2's list (`packages/gateway/src/scheduler/job-models.ts`), sorted. */
export const CHEAP_JOB_KINDS = [
  "activity_summary",
  "memory_consolidation",
  "memory_organize",
  "memory_recheck",
  "round_triage",
  "soul_proposal",
] as const;
export type CheapJobKind = (typeof CHEAP_JOB_KINDS)[number];

export type Verdict = "still_true" | "possibly_stale" | "unclear";
export type Variant = "small" | "large";

export interface ActivitySummaryInput {
  status: "succeeded" | "failed" | "stopped";
  request: string;
  done: string;
  reply: string;
  error: string;
}
export interface ConsolidationInput {
  sources: { key: string; kind: "episode" | "candidate"; body: string }[];
}
export interface OrganizeInput {
  notes: { key: string; body: string }[];
}
export interface RecheckInput {
  notes: { key: string; body: string }[];
  activity: { author: "human" | "bot"; body: string }[];
  /** Large variant only: older filler messages in a second shared thread. */
  fillerActivity?: string[];
}
export interface TriageInput {
  roster: { name: string; role: string; owner?: boolean }[];
  everyone: boolean;
  request: string;
}
export interface SoulInput {
  botName: string;
  role: string;
  instruction: string;
  baseBody: string;
}

export interface ActivitySummaryExpect {
  mention: string[][];
  forbid: string[];
  unsafe: string[];
  cjk: boolean;
}
export interface ConsolidationExpect {
  learn: { all: string[]; atMost?: number }[];
  notLearn: string[];
  unsafe: string[];
  probes: { query: string; expect: string }[];
}
export interface OrganizeExpect {
  clusters: string[][];
  split: string[];
  atomic: string[];
}
export interface RecheckExpect {
  verdicts: Record<string, Verdict>;
}
export interface TriageExpect {
  requiredAll: string[];
  requiredAny: string[][];
  forbidden: string[];
  closers: string[];
}
export interface SoulExpect {
  mention: string[][];
  forbid: string[];
  protected: string[];
}

/**
 * A case. `reference` is one output that passes every oracle, written by hand where the output
 * is free text (summaries, learned items, SOUL edits, split wordings) and derived from `expect`
 * elsewhere; it proves each oracle can be met and is what a scripted upstream would answer.
 */
interface CaseBase<K extends CheapJobKind, I, E, R = never> {
  id: string;
  kind: K;
  holdout: boolean;
  status: "active" | "retired";
  input: I;
  expect: E;
  reference?: R;
}

export type CheapCase =
  | CaseBase<"activity_summary", ActivitySummaryInput, ActivitySummaryExpect, string>
  | CaseBase<"memory_consolidation", ConsolidationInput, ConsolidationExpect, string[]>
  | CaseBase<"memory_organize", OrganizeInput, OrganizeExpect, { splits: Record<string, string[]> }>
  | CaseBase<"memory_recheck", RecheckInput, RecheckExpect>
  | CaseBase<"round_triage", TriageInput, TriageExpect>
  | CaseBase<
      "soul_proposal",
      SoulInput,
      SoulExpect,
      { edits: { find: string; replace: string }[]; append?: string }
    >;

export interface CheapTaskSet {
  name: "cheap-model";
  version: string;
  spec: string;
  defaults: {
    repeats: number;
    delta_pass_rate: number;
    delta_cost: number;
    alpha: number;
    power: number;
    planning_baseline: number;
  };
  ceiling: {
    per_run_usd: Record<CheapJobKind, number>;
    triage_leak_usd: number;
    smoke_cases: string[];
  };
  filler: { generator: "filler-v1"; seed: number };
  large: {
    activity_summary: { sourceChars: number };
    memory_consolidation: { sources: number };
    memory_organize: { notes: number };
    memory_recheck: { notes: number; activityChars: number };
    round_triage: { members: number; requestChars: number };
    soul_proposal: { baseChars: number };
    /** `cheapVariantsDigest` of the generated large variants: a generator change bumps the version. */
    sha256: string;
  };
  cases: CheapCase[];
}

export const CHEAP_TASKS_PATH = fileURLToPath(
  new URL("../tasks/cheap-model-v1.json", import.meta.url),
);

export function loadCheapTaskSet(file: string = CHEAP_TASKS_PATH): CheapTaskSet {
  return JSON.parse(readFileSync(path.resolve(file), "utf8")) as CheapTaskSet;
}

/** One task: a case in one variant. The pairing unit of `compare.ts`. */
export interface CheapTask {
  taskId: string;
  caseId: string;
  kind: CheapJobKind;
  variant: Variant;
  bucket: Exclude<DurationBucket, "long">;
  holdout: boolean;
  /** The case, with input and expectations of this variant. */
  case: CheapCase;
}

export function taskId(caseId: string, variant: Variant): string {
  return `${caseId}@${variant}`;
}

/** The text the Gateway builds as an activity summary's source (`activity-summaries.ts`). */
export function activitySource(input: ActivitySummaryInput): string {
  return [
    `status: ${input.status}`,
    input.request ? `request: ${input.request.slice(0, 800)}` : "",
    input.done ? `done: ${input.done}` : "",
    input.reply ? `reply: ${input.reply}` : "",
    input.error ? `error: ${input.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function seedOf(set: CheapTaskSet, caseId: string): number {
  let h = set.filler.seed >>> 0;
  for (const ch of caseId) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0) as number;
  return h;
}

/** The large variant of a case: deterministic, from the case id and the file's filler seed. */
export function largeVariant(set: CheapTaskSet, c: CheapCase): CheapCase {
  const seed = seedOf(set, c.id);
  switch (c.kind) {
    case "activity_summary": {
      const room = set.large.activity_summary.sourceChars - activitySource(c.input).length - 1;
      const reply = room > 40 ? `${c.input.reply} ${fillerParagraph(room, seed)}` : c.input.reply;
      return { ...c, input: { ...c.input, reply } };
    }
    case "memory_consolidation": {
      const extra = Math.max(0, set.large.memory_consolidation.sources - c.input.sources.length);
      const filler = fillerNotes(extra, seed).map((n, i) => ({
        key: `f${String(i + 1).padStart(2, "0")}`,
        kind: "episode" as const,
        body: `Task: a one-off request. Outcome: ${n.body}`,
      }));
      return { ...c, input: { sources: [...c.input.sources, ...filler] } };
    }
    case "memory_organize": {
      const extra = Math.max(0, set.large.memory_organize.notes - c.input.notes.length);
      const filler = fillerNotes(extra, seed).map((n, i) => ({
        key: `f${String(i + 1).padStart(2, "0")}`,
        body: n.body,
      }));
      return { ...c, input: { notes: [...c.input.notes, ...filler] } };
    }
    case "memory_recheck": {
      const extra = Math.max(0, set.large.memory_recheck.notes - c.input.notes.length);
      const filler = fillerNotes(extra, seed).map((n, i) => ({
        key: `f${String(i + 1).padStart(2, "0")}`,
        body: n.body,
      }));
      const text = fillerParagraph(set.large.memory_recheck.activityChars, seed ^ 0x9e3779b9);
      const messages: string[] = [];
      let current = "";
      for (const sentence of text.split(/(?<=\.) /)) {
        if (current.length + sentence.length + 1 > 400 && current) {
          messages.push(current);
          current = "";
        }
        current = current ? `${current} ${sentence}` : sentence;
      }
      if (current) messages.push(current);
      return {
        ...c,
        input: { ...c.input, notes: [...c.input.notes, ...filler], fillerActivity: messages },
      };
    }
    case "round_triage": {
      const extra = Math.max(0, set.large.round_triage.members - c.input.roster.length);
      const members = FILLER_MEMBERS.slice(0, extra);
      const head = `${c.input.request}\n\nBackground for the team (no action needed):\n`;
      const room = set.large.round_triage.requestChars - head.length;
      return {
        ...c,
        input: {
          ...c.input,
          roster: [...c.input.roster, ...members],
          request: room > 40 ? `${head}${fillerParagraph(room, seed)}` : c.input.request,
        },
        expect: { ...c.expect, forbidden: [...c.expect.forbidden, ...members.map((m) => m.name)] },
      };
    }
    case "soul_proposal": {
      const lines: string[] = [];
      let length = c.input.baseBody.length + "\n## Notes\n\n".length;
      for (const sentence of fillerParagraph(set.large.soul_proposal.baseChars, seed).split(
        /(?<=\.) /,
      )) {
        if (length + sentence.length + 3 > set.large.soul_proposal.baseChars) break;
        lines.push(`- ${sentence}`);
        length += sentence.length + 3;
      }
      const first = lines[0];
      const last = lines.at(-1);
      return {
        ...c,
        input: { ...c.input, baseBody: `${c.input.baseBody}\n## Notes\n\n${lines.join("\n")}\n` },
        expect: {
          ...c.expect,
          protected: [
            ...c.expect.protected,
            ...(first ? [first] : []),
            ...(last && last !== first ? [last] : []),
          ],
        },
      };
    }
  }
}

/** Every active task: each active case as `@small` (short) and `@large` (medium). */
export function cheapTasks(set: CheapTaskSet): CheapTask[] {
  return set.cases
    .filter((c) => c.status === "active")
    .flatMap((c) =>
      (["small", "large"] as const).map((variant) => ({
        taskId: taskId(c.id, variant),
        caseId: c.id,
        kind: c.kind,
        variant,
        bucket: variant === "small" ? ("short" as const) : ("medium" as const),
        holdout: c.holdout,
        case: variant === "small" ? c : largeVariant(set, c),
      })),
    );
}

/** The digest of every large variant's input and expectations. */
export function cheapVariantsDigest(set: CheapTaskSet): string {
  return digestOf(
    cheapTasks(set)
      .filter((t) => t.variant === "large")
      .map((t) => ({ id: t.taskId, input: t.case.input, expect: t.case.expect })),
  );
}
