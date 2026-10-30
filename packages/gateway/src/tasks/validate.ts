// Strict, bounded operator inputs. Reference ownership and state invariants are checked by the store.
import {
  type BotId,
  type CreateTaskInput,
  DeskmatesError,
  type RunId,
  type RunTaskRequest,
  TASK_IDEMPOTENCY_KEY,
  TASK_STATUSES,
  TASK_TRIGGERS,
  type TaskArtifact,
  type TaskCheckpointRequest,
  type TaskCheckpointUnit,
  type TaskDeliverRequest,
  type TaskScheduleInput,
  type TaskTrigger,
  type ThreadId,
  type UpdateTaskInput,
  parseCron,
} from "@deskmates/contracts";
import { asRecord } from "../api/validate.js";
import { parseOutput, parseOutputSchema } from "./output-schema.js";

export const TASK_LIMITS = {
  title: 200,
  description: 20_000,
  blockedReason: 2_000,
  nextAction: 2_000,
  label: 200,
  path: 4_096,
  id: 200,
  references: 100,
  artifacts: 50,
  summary: 2_000,
  /** One outstanding criterion or checkpoint unit name. */
  criterion: 500,
  checkpointUnits: 100,
} as const;

const CREATE_KEYS = [
  "title",
  "description",
  "ownerBotId",
  "threadIds",
  "runIds",
  "artifacts",
  "outputSchema",
];

function onlyKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!keys.includes(key))
      throw new DeskmatesError("validation", `Unknown task property: ${key}`);
  }
}

function text(value: unknown, key: string, max: number, nonempty = false): string {
  if (typeof value !== "string" || value.length > max || (nonempty && !value.trim())) {
    throw new DeskmatesError(
      "validation",
      `${key} must be ${nonempty ? "a non-empty" : "a"} string of at most ${max} characters`,
      { key },
    );
  }
  return nonempty ? value.trim() : value;
}

function references<T extends string>(value: unknown, key: string): T[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.references) {
    throw new DeskmatesError(
      "validation",
      `${key} must be an array of at most ${TASK_LIMITS.references} references`,
      { key },
    );
  }
  const ids = value.map((id) => text(id, key, TASK_LIMITS.id, true) as T);
  if (new Set(ids).size !== ids.length)
    throw new DeskmatesError("validation", `${key} must not contain duplicate references`, { key });
  return ids;
}

function artifacts(
  value: unknown,
  keys: readonly string[] = ["label", "path", "runId"],
): TaskArtifact[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.artifacts) {
    throw new DeskmatesError(
      "validation",
      `artifacts must be an array of at most ${TASK_LIMITS.artifacts} references`,
    );
  }
  return value.map((entry) => {
    const a = asRecord(entry, "artifact");
    onlyKeys(a, keys);
    const artifact: TaskArtifact = {
      label: text(a.label, "label", TASK_LIMITS.label, true),
      path: text(a.path, "path", TASK_LIMITS.path, true),
    };
    if (a.runId !== undefined)
      artifact.runId = text(a.runId, "runId", TASK_LIMITS.id, true) as RunId;
    return artifact;
  });
}

function fields(body: Record<string, unknown>): Partial<CreateTaskInput> {
  const result: Partial<CreateTaskInput> = {};
  if (body.title !== undefined) result.title = text(body.title, "title", TASK_LIMITS.title, true);
  if (body.description !== undefined)
    result.description = text(body.description, "description", TASK_LIMITS.description);
  if (body.ownerBotId !== undefined)
    result.ownerBotId =
      body.ownerBotId === null
        ? null
        : (text(body.ownerBotId, "ownerBotId", TASK_LIMITS.id, true) as BotId);
  if (body.threadIds !== undefined)
    result.threadIds = references<ThreadId>(body.threadIds, "threadIds");
  if (body.runIds !== undefined) result.runIds = references<RunId>(body.runIds, "runIds");
  if (body.artifacts !== undefined) result.artifacts = artifacts(body.artifacts);
  if (body.outputSchema !== undefined)
    result.outputSchema = body.outputSchema === null ? null : parseOutputSchema(body.outputSchema);
  return result;
}

export function taskVersion(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new DeskmatesError(
      "validation",
      "version must be a positive safe integer below the maximum safe integer",
    );
  }
  return value;
}

export function createTaskInput(raw: unknown): CreateTaskInput {
  const body = asRecord(raw);
  onlyKeys(body, CREATE_KEYS);
  return { ...fields(body), title: text(body.title, "title", TASK_LIMITS.title, true) };
}

/** The create body split into the record and how it takes effect (ADR-0021 A3a, A3b). */
export interface CheckedCreateRequest {
  input: CreateTaskInput;
  trigger: TaskTrigger;
  schedule?: TaskScheduleInput;
  idempotencyKey?: string;
  templateId?: string;
  fields?: Record<string, string>;
}

export function idempotencyKey(value: unknown, key = "idempotencyKey"): string {
  if (typeof value !== "string" || !TASK_IDEMPOTENCY_KEY.test(value))
    throw new DeskmatesError(
      "validation",
      `${key} must be 8 to 128 characters of [A-Za-z0-9._:-]`,
      {
        key,
      },
    );
  return value;
}

export function createTaskRequest(raw: unknown): CheckedCreateRequest {
  const body = asRecord(raw);
  const {
    trigger: rawTrigger,
    schedule: rawSchedule,
    idempotencyKey: rawKey,
    templateId: rawTemplate,
    fields: rawFields,
    ...rest
  } = body;
  const input = createTaskInput(rest);
  // ADR-0021 A4c: fields belong to a template; the store checks them against its definitions.
  if (rawFields !== undefined && rawTemplate === undefined)
    throw new DeskmatesError("validation", "fields are given only with a templateId", {
      key: "fields",
    });
  const trigger = rawTrigger === undefined ? "manual" : rawTrigger;
  if (typeof trigger !== "string" || !TASK_TRIGGERS.includes(trigger as TaskTrigger))
    throw new DeskmatesError("validation", "trigger must be immediate, scheduled or manual", {
      key: "trigger",
    });
  if ((trigger === "scheduled") !== (rawSchedule !== undefined))
    throw new DeskmatesError(
      "validation",
      "a schedule is given exactly when trigger is scheduled",
      {
        key: "schedule",
      },
    );
  return {
    input,
    trigger: trigger as TaskTrigger,
    ...(rawSchedule === undefined ? {} : { schedule: scheduleInput(rawSchedule) }),
    ...(rawKey === undefined ? {} : { idempotencyKey: idempotencyKey(rawKey) }),
    ...(rawTemplate === undefined
      ? {}
      : { templateId: text(rawTemplate, "templateId", TASK_LIMITS.id, true) }),
    ...(rawFields === undefined ? {} : { fields: fieldMap(rawFields) }),
  };
}

/** A `fields` object of strings; keys and bounds are checked against the template (A4c). */
function fieldMap(value: unknown): Record<string, string> {
  const record = asRecord(value, "fields");
  for (const [key, entry] of Object.entries(record))
    if (typeof entry !== "string")
      throw new DeskmatesError("validation", `fields.${key} must be a string`, { key: "fields" });
  return record as Record<string, string>;
}

/** A schedule's shape; the time zone and the cron text are checked here, the instant too. */
export function scheduleInput(raw: unknown): TaskScheduleInput {
  const body = asRecord(raw, "schedule");
  const zone = body.timeZone === undefined ? undefined : text(body.timeZone, "timeZone", 64, true);
  if (zone !== undefined && !validTimeZone(zone))
    throw new DeskmatesError("validation", "timeZone must be an IANA time zone", {
      key: "timeZone",
    });
  if (body.kind === "once") {
    onlyKeys(body, ["kind", "runAt", "timeZone"]);
    const runAt = text(body.runAt, "runAt", 40, true);
    const at = new Date(runAt);
    if (Number.isNaN(at.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(runAt))
      throw new DeskmatesError("validation", "runAt must be an ISO-8601 instant", { key: "runAt" });
    return { kind: "once", runAt: at.toISOString(), ...(zone ? { timeZone: zone } : {}) };
  }
  if (body.kind === "repeat") {
    onlyKeys(body, ["kind", "cron", "timeZone"]);
    const cron = text(body.cron, "cron", 200, true);
    try {
      parseCron(cron);
    } catch (err) {
      throw new DeskmatesError("validation", `cron: ${(err as Error).message}`, { key: "cron" });
    }
    return { kind: "repeat", cron, ...(zone ? { timeZone: zone } : {}) };
  }
  throw new DeskmatesError("validation", "schedule.kind must be once or repeat", { key: "kind" });
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function runTaskRequest(raw: unknown): RunTaskRequest {
  const body = asRecord(raw);
  onlyKeys(body, ["version", "idempotencyKey", "feedback"]);
  return {
    version: taskVersion(body.version),
    idempotencyKey: idempotencyKey(body.idempotencyKey),
    ...(body.feedback === undefined
      ? {}
      : { feedback: text(body.feedback, "feedback", 4000, true) }),
  };
}

export function updateTaskInput(raw: unknown): UpdateTaskInput {
  const body = asRecord(raw);
  onlyKeys(body, [
    ...CREATE_KEYS,
    "version",
    "status",
    "blockedReason",
    "nextAction",
    "schedule",
    "fields",
  ]);
  const result: UpdateTaskInput = { ...fields(body), version: taskVersion(body.version) };
  if (body.fields !== undefined) result.fields = fieldMap(body.fields);
  if (body.schedule !== undefined)
    result.schedule = body.schedule === null ? null : scheduleInput(body.schedule);
  if (body.status !== undefined) {
    if (
      typeof body.status !== "string" ||
      body.status === "accepted" ||
      !TASK_STATUSES.includes(body.status as (typeof TASK_STATUSES)[number])
    ) {
      throw new DeskmatesError(
        "validation",
        "status must be planned, in_progress, blocked, delivered or cancelled; use /accept for acceptance",
      );
    }
    result.status = body.status as NonNullable<UpdateTaskInput["status"]>;
  }
  if (body.blockedReason !== undefined)
    result.blockedReason = text(body.blockedReason, "blockedReason", TASK_LIMITS.blockedReason);
  if (body.nextAction !== undefined)
    result.nextAction = text(body.nextAction, "nextAction", TASK_LIMITS.nextAction);
  return result;
}

export function acceptTaskVersion(raw: unknown): number {
  const body = asRecord(raw);
  onlyKeys(body, ["version"]);
  return taskVersion(body.version);
}

/**
 * A bot's `task_deliver` body (ADR-0021 amendment 2). The bot names label and path only; the
 * Gateway stamps each artifact with the delivering run, so a bot cannot attribute bytes to
 * another run. Path policy and the schema check need the task, so the store applies them.
 */
export function deliverTaskInput(raw: unknown): TaskDeliverRequest {
  const body = asRecord(raw);
  onlyKeys(body, ["taskId", "summary", "artifacts", "output", "outstanding", "scopeVersion"]);
  // ADR-0021 A3g: a non-file task delivers with no artifact and no placeholder.
  const delivered =
    body.artifacts === undefined ? [] : artifacts(body.artifacts, ["label", "path"]);
  if (new Set(delivered.map((a) => a.path)).size !== delivered.length)
    throw new DeskmatesError("validation", "artifacts must not repeat a path");
  return {
    taskId: text(body.taskId, "taskId", TASK_LIMITS.id, true),
    summary: text(body.summary, "summary", TASK_LIMITS.summary, true),
    artifacts: delivered,
    ...(body.output === undefined ? {} : { output: parseOutput(body.output) }),
    ...(body.outstanding === undefined
      ? {}
      : { outstanding: textList(body.outstanding, "outstanding", 50, TASK_LIMITS.criterion) }),
    ...(body.scopeVersion === undefined ? {} : { scopeVersion: taskVersion(body.scopeVersion) }),
  };
}

function textList(value: unknown, key: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new DeskmatesError("validation", `${key} must be an array of at most ${maxItems} items`, {
      key,
    });
  return value.map((entry) => text(entry, key, maxLength, true));
}

/** `task_checkpoint` (ADR-0021 A3h); evidence paths get the lexical policy in the store. */
export function checkpointInput(raw: unknown): TaskCheckpointRequest {
  const body = asRecord(raw);
  onlyKeys(body, ["taskId", "completed", "outstanding", "note", "scopeVersion"]);
  if (!Array.isArray(body.completed) || body.completed.length > TASK_LIMITS.checkpointUnits)
    throw new DeskmatesError(
      "validation",
      `completed must be an array of at most ${TASK_LIMITS.checkpointUnits} units`,
      { key: "completed" },
    );
  const completed = body.completed.map((entry): TaskCheckpointUnit => {
    const unit = asRecord(entry, "completed unit");
    onlyKeys(unit, ["unit", "outcome", "evidence"]);
    return {
      unit: text(unit.unit, "unit", TASK_LIMITS.criterion, true),
      outcome: text(unit.outcome, "outcome", TASK_LIMITS.summary, true),
      evidence:
        unit.evidence === undefined
          ? []
          : textList(unit.evidence, "evidence", 20, TASK_LIMITS.path),
    };
  });
  return {
    taskId: text(body.taskId, "taskId", TASK_LIMITS.id, true),
    completed,
    ...(body.scopeVersion === undefined ? {} : { scopeVersion: taskVersion(body.scopeVersion) }),
    outstanding:
      body.outstanding === undefined
        ? []
        : textList(
            body.outstanding,
            "outstanding",
            TASK_LIMITS.checkpointUnits,
            TASK_LIMITS.criterion,
          ),
    note: body.note === undefined ? "" : text(body.note, "note", TASK_LIMITS.summary),
  };
}
