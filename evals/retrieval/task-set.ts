// The retrieval task set (`evals/tasks/retrieval-v1.json`; protocol of 2026-10-17, comparison R):
// its shape, its loader and the checks that make its oracles deterministic. A task asks a run to
// find a fact in seeded Knowledge or learned memory with `knowledge_search` / `memory_search`;
// the oracle is an exact answer, a tool call and the absence of a decoy canary. No model is read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf } from "../campaign/digest.js";
import {
  containsTokens,
  contentTokens,
  fillerKnowledge,
  fillerNotes,
  normalizeAnswer,
  tokens,
} from "../campaign/text.js";
import type { DurationBucket } from "../compare/result-row.js";

export type RetrievalCorpus = "knowledge" | "memory";
export type RetrievalStratum =
  | "lexical"
  | "paraphrase"
  | "cross_lingual"
  | "identifier"
  | "negative"
  | "chain"
  | "aggregate";

export interface KnowledgeSource {
  id: string;
  lang: "en" | "zh";
  title: string;
  body: string;
}

export interface MemorySource {
  id: string;
  lang: "en" | "zh";
  body: string;
}

export interface RetrievalItem {
  id: string;
  corpus: RetrievalCorpus;
  bucket: Exclude<DurationBucket, "long">;
  stratum: RetrievalStratum;
  question: string;
  gold: string[];
  distractors: string[];
  /** Negative items: tokens the question names that no source may contain. */
  absent?: string[];
  answer: { value: string; aliases: string[] };
  /** Aggregates whose answer is computed, not quoted: how. */
  derivation?: { op: "sum"; values: string[] };
  holdout: boolean;
  status: "active" | "retired";
}

export interface RetrievalTaskSet {
  name: "retrieval";
  version: string;
  spec: string;
  answer_rule: string;
  abstain_value: string;
  defaults: {
    repeats: number;
    delta_pass_rate: number;
    delta_cost: number;
    alpha: number;
    power: number;
    planning_baseline: number;
  };
  ceiling: { per_run_usd: Record<"short" | "medium", number>; smoke_tasks: string[] };
  filler: {
    generator: "filler-v1";
    seed: number;
    knowledge: number;
    memory: number;
    /** `retrievalFillerDigest` of the generated filler: a generator change bumps the version. */
    sha256: string;
  };
  corpus: { knowledge: KnowledgeSource[]; memory: MemorySource[] };
  decoy: { canary: string; memory: MemorySource[] };
  items: RetrievalItem[];
}

export const RETRIEVAL_TASKS_PATH = fileURLToPath(
  new URL("../tasks/retrieval-v1.json", import.meta.url),
);

export function loadRetrievalTaskSet(file: string = RETRIEVAL_TASKS_PATH): RetrievalTaskSet {
  return JSON.parse(readFileSync(path.resolve(file), "utf8")) as RetrievalTaskSet;
}

/** What a run is told: the question, which tool to use, the abstain rule and the answer rule. */
export function retrievalInstruction(set: RetrievalTaskSet, item: RetrievalItem): string {
  const where =
    item.corpus === "knowledge"
      ? "Look this up in the team's approved knowledge with knowledge_search (and knowledge_read for a whole document)."
      : "Look this up in this workspace's learned memory with memory_search.";
  return [
    where,
    item.question,
    `If what you find does not say, answer ${set.abstain_value}.`,
    set.answer_rule,
  ].join(" ");
}

/** The tool a task must call at least once. */
export function requiredTool(item: RetrievalItem): "knowledge_search" | "memory_search" {
  return item.corpus === "knowledge" ? "knowledge_search" : "memory_search";
}

/** The digest of the generated filler corpus the task file was frozen with. */
export function retrievalFillerDigest(set: RetrievalTaskSet): string {
  return digestOf({
    knowledge: fillerKnowledge(set.filler.knowledge, set.filler.seed),
    memory: fillerNotes(set.filler.memory, set.filler.seed),
  });
}

/** Every source text of one corpus, fillers included, keyed by fixture id. */
export function corpusTexts(set: RetrievalTaskSet, corpus: RetrievalCorpus): Map<string, string> {
  const out = new Map<string, string>();
  if (corpus === "knowledge") {
    for (const doc of set.corpus.knowledge) out.set(doc.id, `${doc.title}\n${doc.body}`);
    for (const doc of fillerKnowledge(set.filler.knowledge, set.filler.seed))
      out.set(doc.id, `${doc.title}\n${doc.body}`);
  } else {
    for (const note of set.corpus.memory) out.set(note.id, note.body);
    for (const note of fillerNotes(set.filler.memory, set.filler.seed)) out.set(note.id, note.body);
  }
  return out;
}

const BUCKETS = new Set(["short", "medium"]);
const STRATA = new Set<RetrievalStratum>([
  "lexical",
  "paraphrase",
  "cross_lingual",
  "identifier",
  "negative",
  "chain",
  "aggregate",
]);

/** Identifier-looking tokens of a question: letters and digits joined by a hyphen. */
export function identifiersOf(question: string): string[] {
  return question.match(/\b[A-Z]{1,4}-\d{2,5}\b/g) ?? [];
}

/**
 * The design properties every oracle relies on. Returns one message per violation; an empty
 * list means the set is usable. A failing check is a broken task set, never a model result.
 */
export function validateRetrievalTaskSet(set: RetrievalTaskSet): string[] {
  const problems: string[] = [];
  const add = (msg: string) => problems.push(msg);
  const ids = new Set<string>();
  const sources = new Map<string, { corpus: RetrievalCorpus; text: string }>();
  for (const doc of set.corpus.knowledge) {
    if (sources.has(doc.id)) add(`duplicate source id ${doc.id}`);
    sources.set(doc.id, { corpus: "knowledge", text: `${doc.title}\n${doc.body}` });
  }
  for (const note of set.corpus.memory) {
    if (sources.has(note.id)) add(`duplicate source id ${note.id}`);
    sources.set(note.id, { corpus: "memory", text: note.body });
  }
  const knowledge = corpusTexts(set, "knowledge");
  const memory = corpusTexts(set, "memory");
  const fillers = [
    ...fillerKnowledge(set.filler.knowledge, set.filler.seed).map((d) => `${d.title}\n${d.body}`),
    ...fillerNotes(set.filler.memory, set.filler.seed).map((n) => n.body),
  ];
  const everything = [...knowledge.values(), ...memory.values()];
  if (retrievalFillerDigest(set) !== set.filler.sha256)
    add("generated filler differs from the frozen digest: bump the task-set version");
  const canary = set.decoy.canary;
  if (!set.decoy.memory.every((n) => n.body.includes(canary)))
    add("every decoy note must carry the canary");
  if (everything.some((text) => text.includes(canary))) add("the canary leaked into a corpus");
  for (const item of set.items) {
    const at = `item ${item.id}`;
    if (ids.has(item.id)) add(`duplicate item id ${item.id}`);
    ids.add(item.id);
    if (!BUCKETS.has(item.bucket)) add(`${at}: bucket must be short or medium`);
    if (!STRATA.has(item.stratum)) add(`${at}: unknown stratum ${item.stratum}`);
    if (item.status !== "active" && item.status !== "retired") add(`${at}: bad status`);
    const prefix = item.corpus === "knowledge" ? "RK-" : "RM-";
    if (!item.id.startsWith(prefix)) add(`${at}: id must start with ${prefix}`);
    if ((item.bucket === "medium") !== ["chain", "aggregate"].includes(item.stratum))
      add(`${at}: chain and aggregate items are medium, every other stratum short`);
    for (const ref of [...item.gold, ...item.distractors]) {
      const source = sources.get(ref);
      if (!source) add(`${at}: unknown source ${ref}`);
      else if (source.corpus !== item.corpus) add(`${at}: ${ref} is in the other corpus`);
    }
    if (item.gold.some((g) => item.distractors.includes(g)))
      add(`${at}: a source is both gold and distractor`);
    const gold = item.gold.map((g) => sources.get(g)?.text ?? "");
    const value = normalizeAnswer(item.answer.value);
    const accepted = [value, ...item.answer.aliases.map(normalizeAnswer)];
    if (new Set(accepted).size !== accepted.length) add(`${at}: duplicate accepted answer`);
    if (item.stratum === "negative") {
      if (item.gold.length !== 0) add(`${at}: a negative item has no gold source`);
      if (value !== normalizeAnswer(set.abstain_value))
        add(`${at}: a negative item's answer is the abstain value`);
      if (!item.absent || item.absent.length === 0)
        add(`${at}: a negative item lists absent tokens`);
      for (const token of item.absent ?? []) {
        if (!tokens(item.question).includes(token)) add(`${at}: absent ${token} is not asked`);
        if (everything.some((text) => tokens(text).includes(token)))
          add(`${at}: absent token ${token} occurs in a source`);
      }
      continue;
    }
    if (item.gold.length === 0) add(`${at}: needs a gold source`);
    if (item.bucket === "medium" && item.gold.length < 3) add(`${at}: medium needs 3+ sources`);
    if (item.bucket === "short" && item.gold.length !== 1) add(`${at}: short has one gold`);
    if (item.derivation) {
      for (const v of item.derivation.values)
        if (!gold.some((text) => containsTokens(text, v))) add(`${at}: ${v} is in no gold source`);
      const sum = item.derivation.values.reduce((a, v) => a + Number(v), 0);
      if (String(sum) !== value) add(`${at}: derivation gives ${sum}, answer is ${value}`);
    } else if (!accepted.some((a) => gold.some((text) => containsTokens(text, a)))) {
      add(`${at}: no accepted answer occurs in a gold source`);
    }
    for (const ref of item.distractors) {
      const text = sources.get(ref)?.text ?? "";
      if (accepted.some((a) => containsTokens(text, a)))
        add(`${at}: distractor ${ref} contains an accepted answer`);
    }
    for (const filler of fillers)
      if (accepted.some((a) => containsTokens(filler, a)))
        add(`${at}: a filler contains an accepted answer`);
    const q = contentTokens(item.question);
    const shared = (text: string) => [...contentTokens(text)].filter((t) => q.has(t));
    if (item.stratum === "lexical" && gold.some((text) => shared(text).length < 2))
      add(`${at}: a lexical item shares 2+ content words with its gold source`);
    if (
      (item.stratum === "paraphrase" || item.stratum === "cross_lingual") &&
      gold.some((text) => shared(text).length > 0)
    )
      add(`${at}: shares ${gold.flatMap(shared).join(", ")} with its gold source`);
    if (item.stratum === "identifier") {
      const idents = identifiersOf(item.question);
      if (idents.length === 0) add(`${at}: an identifier item names an identifier`);
      for (const ident of idents) {
        if (!gold.some((text) => text.includes(ident))) add(`${at}: ${ident} is not in gold`);
        for (const ref of item.distractors)
          if ((sources.get(ref)?.text ?? "").includes(ident))
            add(`${at}: distractor ${ref} contains ${ident}`);
      }
      if (item.distractors.length === 0) add(`${at}: an identifier item has a near-miss decoy`);
    }
  }
  return problems;
}

/** Active tasks, the verdict set. Held-out tasks stay in it and are also reported apart. */
export function activeItems(set: RetrievalTaskSet): RetrievalItem[] {
  return set.items.filter((item) => item.status === "active");
}
