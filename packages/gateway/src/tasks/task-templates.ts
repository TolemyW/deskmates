// Task templates (ADR-0021 amendment 4, A4a to A4c). A workspace's own templates are rows; the
// built-ins are constants. A template is data: creating a task from one stamps the task's kind,
// snapshots the template and appends one readable section with the labelled criteria to the
// description, which is the only way its text reaches a bot (A4d). Nothing here dispatches.

import {
  DeskmatesError,
  TASK_FIELD_KEY,
  TASK_KIND_KEY,
  TASK_REVIEW_ROLES,
  TASK_STAGE_KEY,
  TASK_TEMPLATE_LIMITS,
  type TaskKindStamp,
  type TaskReviewRole,
  type TaskTemplate,
  type TaskTemplateField,
  type TaskTemplateStage,
  type WorkspaceId,
} from "@deskmates/contracts";
import { asRecord } from "../api/validate.js";
import { newId, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import {
  BUILTIN_PREFIX,
  BUILTIN_TEMPLATES,
  builtinTemplate,
  isBuiltinKind,
} from "./builtin-templates.js";

const L = TASK_TEMPLATE_LIMITS;

interface TemplateRow {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  body_json: string;
  sla_minutes: number | null;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The part of a template stored in `body_json`. */
interface TemplateBody {
  description: string;
  stages: TaskTemplateStage[];
  review: TaskReviewRole;
  fields: TaskTemplateField[];
}

/** A checked template write. */
export type TemplateWrite = Pick<
  TaskTemplate,
  "kind" | "name" | "description" | "stages" | "review" | "slaMinutes" | "fields"
>;

const TEMPLATE_KEYS = ["kind", "name", "description", "stages", "review", "slaMinutes", "fields"];

function onlyKeys(input: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const key of Object.keys(input))
    if (!keys.includes(key))
      throw new DeskmatesError("validation", `Unknown ${what} property: ${key}`, { key });
}

function str(value: unknown, key: string, max: number, nonempty = true): string {
  if (typeof value !== "string" || value.length > max || (nonempty && !value.trim()))
    throw new DeskmatesError(
      "validation",
      `${key} must be ${nonempty ? "a non-empty" : "a"} string of at most ${max} characters`,
      { key },
    );
  return value.trim();
}

function list(value: unknown, key: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length > max || value.length < min)
    throw new DeskmatesError(
      "validation",
      `${key} must be an array of ${min > 0 ? `${min} to ` : "at most "}${max} items`,
      { key },
    );
  return value;
}

function key(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new DeskmatesError("validation", `${name} must match ${pattern.source}`, { key: name });
  return value;
}

/** A template body as an Admin writes it; criterion labels are assigned here (A4a). */
export function templateInput(raw: unknown): TemplateWrite {
  const body = asRecord(raw);
  onlyKeys(body, TEMPLATE_KEYS, "template");
  const stageKeys = new Set<string>();
  const stages = list(body.stages, "stages", L.stages, 1).map((entry): TaskTemplateStage => {
    const s = asRecord(entry, "stage");
    onlyKeys(s, ["key", "name", "criteria", "checkpointRequired"], "stage");
    const stageKey = key(s.key, "stage key", TASK_STAGE_KEY);
    if (stageKeys.has(stageKey))
      throw new DeskmatesError("validation", `stage key ${stageKey} is repeated`, {
        key: "stages",
      });
    stageKeys.add(stageKey);
    if (s.checkpointRequired !== undefined && typeof s.checkpointRequired !== "boolean")
      throw new DeskmatesError("validation", "checkpointRequired must be a boolean");
    return {
      key: stageKey,
      name: str(s.name, "stage name", L.name),
      checkpointRequired: s.checkpointRequired === true,
      criteria: list(s.criteria, "criteria", L.criteriaPerStage, 1).map((text, i) => ({
        label: `${stageKey}.${i + 1}`,
        text: str(text, "criterion", L.criterion),
      })),
    };
  });
  const fieldKeys = new Set<string>();
  const fields = (body.fields === undefined ? [] : list(body.fields, "fields", L.fields)).map(
    (entry): TaskTemplateField => {
      const f = asRecord(entry, "field");
      onlyKeys(f, ["key", "label", "required", "defaultValue", "relates"], "field");
      const fieldKey = key(f.key, "field key", TASK_FIELD_KEY);
      if (fieldKeys.has(fieldKey))
        throw new DeskmatesError("validation", `field key ${fieldKey} is repeated`, {
          key: "fields",
        });
      fieldKeys.add(fieldKey);
      for (const flag of ["required", "relates"] as const)
        if (f[flag] !== undefined && typeof f[flag] !== "boolean")
          throw new DeskmatesError("validation", `${flag} must be a boolean`, { key: flag });
      return {
        key: fieldKey,
        label: str(f.label, "field label", L.fieldLabel),
        required: f.required === true,
        defaultValue:
          f.defaultValue === undefined
            ? ""
            : str(f.defaultValue, "defaultValue", L.fieldValue, false),
        relates: f.relates === true,
      };
    },
  );
  const review = body.review === undefined ? "none" : body.review;
  if (!TASK_REVIEW_ROLES.includes(review as TaskReviewRole))
    throw new DeskmatesError("validation", "review must be human, peer_bot or none", {
      key: "review",
    });
  const sla = body.slaMinutes ?? null;
  if (
    sla !== null &&
    (typeof sla !== "number" || !Number.isSafeInteger(sla) || sla < 1 || sla > L.slaMinutes)
  )
    throw new DeskmatesError(
      "validation",
      `slaMinutes must be null or an integer from 1 to ${L.slaMinutes}`,
      { key: "slaMinutes" },
    );
  return {
    kind: key(body.kind, "kind", TASK_KIND_KEY),
    name: str(body.name, "name", L.name),
    description:
      body.description === undefined
        ? ""
        : str(body.description, "description", L.description, false),
    stages,
    review: review as TaskReviewRole,
    slaMinutes: sla as number | null,
    fields,
  };
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new DeskmatesError("validation", "version must be a positive integer", {
      key: "version",
    });
  return value;
}

/** Field values for a create or a correction, checked against the definitions (A4c). */
export function fieldValues(
  defs: readonly TaskTemplateField[],
  raw: unknown,
  opts: { fillDefaults: boolean },
): Record<string, string> {
  const given = raw === undefined ? {} : asRecord(raw, "fields");
  const known = new Set(defs.map((d) => d.key));
  for (const k of Object.keys(given))
    if (!known.has(k))
      throw new DeskmatesError("validation", `Unknown field: ${k}`, { key: "fields", field: k });
  const out: Record<string, string> = {};
  for (const def of defs) {
    const value = given[def.key];
    if (value !== undefined) {
      out[def.key] = str(value, def.key, L.fieldValue, false);
    } else if (opts.fillDefaults && def.defaultValue !== "") out[def.key] = def.defaultValue;
    if (opts.fillDefaults && def.required && !(out[def.key] ?? "").trim())
      throw new DeskmatesError("validation", `The field ${def.label} is required`, {
        key: "fields",
        field: def.key,
      });
  }
  return out;
}

/** How a value compares for "same customer" (A4h): trimmed, case-folded, spaces collapsed. */
export function normalizeFieldValue(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

const REVIEW_TEXT: Record<TaskReviewRole, string> = {
  human: "A person reviews and accepts the delivery.",
  peer_bot: "A teammate bot that did not do the work reviews it before delivery.",
  none: "No separate review is required.",
};

function duration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/**
 * The section a templated create appends to the description (A4c): the stages with labelled
 * criteria, the fields, the target and the review role, and how to report against the labels.
 * Plain text the operator can edit afterwards; never a hidden prompt.
 */
export function templateBrief(
  stamp: Omit<TaskKindStamp, "fields">,
  fields: Record<string, string>,
): string {
  const lines = [
    `--- Template: ${stamp.name} (kind ${stamp.key}, version ${stamp.templateVersion})`,
  ];
  const shown = stamp.fieldDefs.filter((d) => (fields[d.key] ?? "") !== "");
  if (shown.length > 0)
    lines.push(`Fields: ${shown.map((d) => `${d.label}: ${fields[d.key]}`).join("; ")}`);
  if (stamp.slaMinutes !== null)
    lines.push(`Target: delivered within ${duration(stamp.slaMinutes)} of creation.`);
  lines.push("Stages, in order. Done criteria are labelled:");
  stamp.stages.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.name}${s.checkpointRequired ? " (checkpoint required)" : ""}`);
    for (const c of s.criteria) lines.push(`   - [${c.label}] ${c.text}`);
  });
  lines.push(`Review: ${REVIEW_TEXT[stamp.review]}`);
  lines.push(
    'Report progress with task_checkpoint: one completed unit per criterion, starting with its label (for example [triage.1] becomes unit "triage.1 ..."), with evidence paths. In task_deliver, list each unmet criterion by its label in outstanding; a delivery with outstanding criteria is partial.',
  );
  return lines.join("\n");
}

/** The kind stamp a template gives a new task, without its field values. */
export function stampOf(template: TaskTemplate): Omit<TaskKindStamp, "fields"> {
  return {
    key: template.kind,
    name: template.name,
    templateId: template.id,
    templateVersion: template.version,
    stages: template.stages,
    review: template.review,
    slaMinutes: template.slaMinutes,
    fieldDefs: template.fields,
  };
}

export class TaskTemplateStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Built-ins first, then the workspace's own by name; archived ones only when asked. */
  list(workspaceId: WorkspaceId, opts: { archived?: boolean } = {}): TaskTemplate[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_templates WHERE workspace_id = ?
         ${opts.archived ? "" : "AND archived_at IS NULL"} ORDER BY name, id`,
      )
      .all(workspaceId) as TemplateRow[];
    return [...BUILTIN_TEMPLATES, ...rows.map(toTemplate)];
  }

  /** A built-in, or the workspace's own template; another workspace's is not found. */
  mustGet(workspaceId: WorkspaceId, id: string): TaskTemplate {
    const builtin = builtinTemplate(id);
    if (builtin) return builtin;
    const row = this.db
      .prepare("SELECT * FROM task_templates WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as TemplateRow | undefined;
    if (!row)
      throw new DeskmatesError("not_found", "Task template not found in this workspace", {
        templateId: id,
      });
    return toTemplate(row);
  }

  /** The newest template of a kind, archived or not: names the kind and its target. */
  forKind(workspaceId: WorkspaceId, kind: string): TaskTemplate | undefined {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.kind === kind);
    if (builtin) return builtin;
    const row = this.db
      .prepare("SELECT * FROM task_templates WHERE workspace_id = ? AND kind = ?")
      .get(workspaceId, kind) as TemplateRow | undefined;
    return row ? toTemplate(row) : undefined;
  }

  create(workspaceId: WorkspaceId, raw: unknown, actor: string): TaskTemplate {
    const input = templateInput(raw);
    if (isBuiltinKind(input.kind))
      throw new DeskmatesError(
        "invalid_transition",
        `The kind ${input.kind} belongs to a built-in template; choose another kind key`,
        { key: "kind" },
      );
    if (
      this.db
        .prepare("SELECT 1 FROM task_templates WHERE workspace_id = ? AND kind = ?")
        .get(workspaceId, input.kind)
    )
      throw new DeskmatesError(
        "invalid_transition",
        `A template of kind ${input.kind} exists already`,
        {
          key: "kind",
        },
      );
    const at = this.clock().toISOString();
    const id = newId("ttpl");
    this.db
      .prepare(`INSERT INTO task_templates (id, workspace_id, kind, name, body_json, sla_minutes,
        version, created_by, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`)
      .run(
        id,
        workspaceId,
        input.kind,
        input.name,
        bodyJson(input),
        input.slaMinutes,
        actor,
        at,
        at,
      );
    return this.mustGet(workspaceId, id);
  }

  /** A versioned edit; the kind key never changes, so stamped tasks keep naming their kind. */
  update(
    workspaceId: WorkspaceId,
    id: string,
    raw: unknown,
  ): { before: TaskTemplate; after: TaskTemplate } {
    const current = this.writable(workspaceId, id);
    const body = asRecord(raw);
    const expected = version(body.version);
    const { version: _v, ...rest } = body;
    const input = templateInput({ ...templateFields(current), ...rest });
    if (input.kind !== current.kind)
      throw new DeskmatesError("validation", "A template's kind key cannot change", {
        key: "kind",
      });
    if (current.archivedAt !== null)
      throw new DeskmatesError("invalid_transition", "An archived template cannot be edited");
    const at = this.clock().toISOString();
    const result = this.db
      .prepare(`UPDATE task_templates SET name = ?, body_json = ?, sla_minutes = ?,
        version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?`)
      .run(input.name, bodyJson(input), input.slaMinutes, at, id, workspaceId, expected);
    if (result.changes !== 1)
      throw new DeskmatesError("invalid_transition", "Template changed; reload before editing", {
        reason: "version_conflict",
        currentVersion: current.version,
      });
    return { before: current, after: this.mustGet(workspaceId, id) };
  }

  /** Archive: no new task from it; every stamped task is unchanged (A4a). */
  archive(workspaceId: WorkspaceId, id: string, raw: unknown): TaskTemplate {
    const current = this.writable(workspaceId, id);
    const body = asRecord(raw);
    onlyKeys(body, ["version"], "archive");
    const expected = version(body.version);
    const at = this.clock().toISOString();
    const result = this.db
      .prepare(`UPDATE task_templates SET archived_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND version = ? AND archived_at IS NULL`)
      .run(at, at, id, workspaceId, expected);
    if (result.changes !== 1)
      throw new DeskmatesError("invalid_transition", "Template changed or is archived; reload", {
        reason: "version_conflict",
        currentVersion: current.version,
      });
    return this.mustGet(workspaceId, id);
  }

  private writable(workspaceId: WorkspaceId, id: string): TaskTemplate {
    if (id.startsWith(BUILTIN_PREFIX))
      throw new DeskmatesError(
        "forbidden",
        "Built-in templates are read-only; copy one into a new kind to change it",
        { reason: "builtin_template" },
      );
    return this.mustGet(workspaceId, id);
  }
}

function templateFields(t: TaskTemplate): Record<string, unknown> {
  return {
    kind: t.kind,
    name: t.name,
    description: t.description,
    stages: t.stages.map((s) => ({
      key: s.key,
      name: s.name,
      checkpointRequired: s.checkpointRequired,
      criteria: s.criteria.map((c) => c.text),
    })),
    review: t.review,
    slaMinutes: t.slaMinutes,
    fields: t.fields,
  };
}

function bodyJson(input: TemplateWrite): string {
  const body: TemplateBody = {
    description: input.description,
    stages: input.stages,
    review: input.review,
    fields: input.fields,
  };
  return JSON.stringify(body);
}

function toTemplate(row: TemplateRow): TaskTemplate {
  const body = parseJson<TemplateBody>(row.body_json, {
    description: "",
    stages: [],
    review: "none",
    fields: [],
  });
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: body.description,
    stages: body.stages,
    review: body.review,
    slaMinutes: row.sla_minutes,
    fields: body.fields,
    builtIn: false,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
