// Related tasks of the same kind (ADR-0021 amendment 4, A4h): equal values of a relating field
// ("same customer") and textual similarity of title, description and the latest delivery
// summary. With an embedding service configured (ADR-0041 decision 1) similarity is the cosine of
// one vector per task, every call recorded in `retrieval_calls` with corpus `task`; otherwise, or
// when a call fails, a deterministic token Jaccard. Operators only: no run reads this, and
// nothing is merged, closed or linked automatically.

import { createHash } from "node:crypto";
import {
  DeskmatesError,
  type RelatedTask,
  type RelatedTaskList,
  type RelatedTaskMethod,
  type RelatedTaskReason,
  type TaskKindStamp,
  type TaskStatus,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import type { EmbeddingClient } from "../retrieval/clients.js";
import type { RetrievalUsage } from "../retrieval/usage.js";
import { dot, fromBlob, toBlob } from "../retrieval/vectors.js";

/** Bounds and thresholds (A4h); the thresholds are guesses, not measured values. */
export const RELATED = {
  limit: 10,
  candidates: 200,
  batch: 16,
  textMax: 4_000,
  timeoutMs: 5_000,
  lexicalMin: 0.2,
  lexicalDuplicate: 0.6,
  embeddingMin: 0.5,
  embeddingDuplicate: 0.9,
} as const;

/** Where the appended template section starts (A4c); it is the same in every task of a kind. */
const BRIEF_MARKER = "--- Template: ";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Words of two or more letters or digits, and CJK runs as character bigrams. */
export function similarityTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    let latin = "";
    let cjk = "";
    const flushLatin = () => {
      if (latin.length >= 2) out.add(latin);
      latin = "";
    };
    const flushCjk = () => {
      if (cjk.length === 1) out.add(cjk);
      for (let i = 0; i + 1 < cjk.length; i += 1) out.add(cjk.slice(i, i + 2));
      cjk = "";
    };
    for (const ch of word) {
      if (CJK.test(ch)) {
        flushLatin();
        cjk += ch;
      } else {
        flushCjk();
        latin += ch;
      }
    }
    flushLatin();
    flushCjk();
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface TaskTextRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  created_at: string;
  kind: string | null;
  kind_json: string | null;
}

const round = (x: number) => Math.round(x * 100) / 100;

export interface RelatedTaskDeps {
  db: GatewayDb;
  /** The configured embedding client; undefined uses the lexical path. */
  embedding: EmbeddingClient | undefined;
  usage: RetrievalUsage;
  clock?: () => Date;
}

export class RelatedTasks {
  constructor(private readonly deps: RelatedTaskDeps) {}

  /**
   * The text a task is compared by: title, the description without the template section, and the
   * latest delivery summary of a run that is not in a private chat.
   */
  textOf(row: Pick<TaskTextRow, "id" | "title" | "description">): string {
    const cut = row.description.indexOf(BRIEF_MARKER);
    const description = (cut >= 0 ? row.description.slice(0, cut) : row.description).trim();
    const summary = (
      this.deps.db
        .prepare(`SELECT d.summary FROM task_deliveries d
          LEFT JOIN runs r ON r.id = d.run_id LEFT JOIN threads t ON t.id = r.thread_id
          WHERE d.task_id = ? AND t.private_to_user_id IS NULL
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`)
        .get(row.id) as { summary: string } | undefined
    )?.summary;
    return [row.title, description, summary ?? ""]
      .filter((s) => s !== "")
      .join("\n")
      .slice(0, RELATED.textMax);
  }

  async related(workspaceId: WorkspaceId, taskId: string): Promise<RelatedTaskList> {
    const db = this.deps.db;
    const target = db
      .prepare(`SELECT id, title, description, status, created_at, kind, kind_json FROM tasks
        WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
      .get(workspaceId, taskId) as TaskTextRow | undefined;
    if (!target)
      throw new DeskmatesError("not_found", "Task not found in this workspace", { taskId });
    if (target.kind === null || target.kind_json === null)
      return { taskId, kind: null, method: "lexical", related: [] };
    const stamp = JSON.parse(target.kind_json) as Omit<TaskKindStamp, "fields">;
    const candidates = db
      .prepare(`SELECT id, title, description, status, created_at, kind, kind_json FROM tasks
        WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL AND id <> ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(workspaceId, target.kind, taskId, RELATED.candidates) as TaskTextRow[];

    // Equal values of each relating field, within the kind.
    const fieldReasons = new Map<string, RelatedTaskReason[]>();
    for (const def of stamp.fieldDefs.filter((d) => d.relates)) {
      const own = db
        .prepare(
          "SELECT value, normalized FROM task_field_values WHERE task_id = ? AND field_key = ?",
        )
        .get(taskId, def.key) as { value: string; normalized: string } | undefined;
      if (!own) continue;
      const matches = db
        .prepare(`SELECT v.task_id FROM task_field_values v JOIN tasks t ON t.id = v.task_id
          WHERE v.workspace_id = ? AND v.field_key = ? AND v.normalized = ? AND v.task_id <> ?
            AND t.kind = ? AND t.deleted_at IS NULL`)
        .all(workspaceId, def.key, own.normalized, taskId, target.kind) as { task_id: string }[];
      for (const m of matches)
        fieldReasons.set(m.task_id, [
          ...(fieldReasons.get(m.task_id) ?? []),
          { kind: "field", field: def.key, label: def.label, value: own.value },
        ]);
    }

    const texts = new Map([target, ...candidates].map((row) => [row.id, this.textOf(row)]));
    let method: RelatedTaskMethod = "lexical";
    let scores: Map<string, number> | undefined;
    if (this.deps.embedding) {
      scores = await this.embeddingScores(workspaceId, taskId, texts);
      method = scores ? "embedding" : "lexical_fallback";
    }
    if (!scores) {
      const own = similarityTokens(texts.get(taskId) ?? "");
      scores = new Map(
        candidates.map((c) => [c.id, jaccard(own, similarityTokens(texts.get(c.id) ?? ""))]),
      );
    }
    const min = method === "embedding" ? RELATED.embeddingMin : RELATED.lexicalMin;
    const duplicate =
      method === "embedding" ? RELATED.embeddingDuplicate : RELATED.lexicalDuplicate;
    const related: RelatedTask[] = [];
    for (const c of candidates) {
      const score = Math.max(0, Math.min(1, scores.get(c.id) ?? 0));
      const reasons = [...(fieldReasons.get(c.id) ?? [])];
      if (score >= min) reasons.push({ kind: "text", score: round(score) });
      if (reasons.length === 0) continue;
      related.push({
        id: c.id,
        title: c.title,
        status: c.status,
        createdAt: c.created_at,
        reasons,
        possibleDuplicate: score >= duplicate,
      });
    }
    const rank = (r: RelatedTask) =>
      (r.reasons.some((x) => x.kind === "field") ? 1 : 0) +
      (r.reasons.find((x) => x.kind === "text")?.score ?? 0);
    related.sort((a, b) => rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt));
    return { taskId, kind: target.kind, method, related: related.slice(0, RELATED.limit) };
  }

  /**
   * Cosine of the target's vector with each candidate's, embedding only texts whose stored vector
   * is missing or was computed from other text. Undefined when any call fails: the caller falls
   * back to the lexical path (ADR-0041 decision 7).
   */
  private async embeddingScores(
    workspaceId: WorkspaceId,
    taskId: string,
    texts: ReadonlyMap<string, string>,
  ): Promise<Map<string, number> | undefined> {
    const client = this.deps.embedding as EmbeddingClient;
    const model = client.service.model;
    const db = this.deps.db;
    const tenantId = (
      db.prepare("SELECT tenant_id FROM workspaces WHERE id = ?").get(workspaceId) as {
        tenant_id: string;
      }
    ).tenant_id;
    const hashes = new Map([...texts].map(([id, text]) => [id, sha256(text)]));
    const stored = new Map<string, Float32Array>();
    const rows = db
      .prepare(`SELECT task_id, text_sha256, vector FROM task_text_vectors
        WHERE workspace_id = ? AND model = ?`)
      .all(workspaceId, model) as { task_id: string; text_sha256: string; vector: Buffer }[];
    for (const row of rows)
      if (hashes.get(row.task_id) === row.text_sha256)
        stored.set(row.task_id, fromBlob(row.vector));
    const missing = [...texts.keys()].filter((id) => !stored.has(id));
    for (let i = 0; i < missing.length; i += RELATED.batch) {
      const ids = missing.slice(i, i + RELATED.batch);
      const inputs = ids.map((id) => texts.get(id) ?? "");
      let vectors: Float32Array[];
      try {
        vectors = (
          await this.deps.usage.timed(
            {
              tenantId,
              corpus: "task",
              purpose: "index",
              service: "embedding",
              model,
              inputs: inputs.length,
            },
            () => client.embed(inputs, RELATED.timeoutMs),
            (result) => result.inputTokens,
          )
        ).vectors;
      } catch {
        return undefined;
      }
      const at = (this.deps.clock ?? (() => new Date()))().toISOString();
      const clear = db.prepare("DELETE FROM task_text_vectors WHERE task_id = ? AND model <> ?");
      const write = db.prepare(`INSERT INTO task_text_vectors (task_id, model, workspace_id,
          text_sha256, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (task_id, model) DO UPDATE SET text_sha256 = excluded.text_sha256,
          dimensions = excluded.dimensions, vector = excluded.vector, created_at = excluded.created_at`);
      db.transaction(() => {
        ids.forEach((id, k) => {
          const vector = vectors[k] as Float32Array;
          clear.run(id, model);
          write.run(id, model, workspaceId, hashes.get(id), vector.length, toBlob(vector), at);
          stored.set(id, vector);
        });
      })();
    }
    const own = stored.get(taskId);
    if (!own) return undefined;
    return new Map(
      [...stored]
        .filter(([id]) => id !== taskId)
        .map(([id, vector]) => [id, Math.max(0, dot(own, vector))]),
    );
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
