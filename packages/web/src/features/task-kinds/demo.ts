// Demo routes of task kinds (ADR-0021 amendment 4): one built-in template, the workspace's own
// templates and related tasks by word overlap. Production rules live in the Gateway.

import type {
  TaskKindStamp,
  TaskTemplate,
  TaskTemplateInput,
  WorkspaceId,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const SUPPORT: TaskTemplate = {
  id: "builtin:support-ticket",
  kind: "support-ticket",
  name: "Customer support ticket",
  description: "One customer request: understand it, resolve or escalate it, confirm the outcome.",
  stages: [
    {
      key: "triage",
      name: "Triage",
      checkpointRequired: true,
      criteria: [{ label: "triage.1", text: "Customer, channel and priority are recorded." }],
    },
    {
      key: "resolve",
      name: "Resolve",
      checkpointRequired: true,
      criteria: [{ label: "resolve.1", text: "A fix or answer is prepared and checked." }],
    },
    {
      key: "confirm",
      name: "Confirm",
      checkpointRequired: false,
      criteria: [{ label: "confirm.1", text: "The customer's confirmation is recorded." }],
    },
  ],
  review: "human",
  slaMinutes: 1440,
  fields: [
    { key: "customer", label: "Customer", required: true, defaultValue: "", relates: true },
    { key: "priority", label: "Priority", required: false, defaultValue: "P3", relates: false },
  ],
  builtIn: true,
  version: 1,
  archivedAt: null,
  createdAt: null,
  updatedAt: null,
};

interface Store {
  templates: TaskTemplate[];
  next: number;
}

function store(s: DemoState): Store {
  return s.store<Store>("taskKinds", () => ({ templates: [], next: 1 }));
}

function templatesOf(s: DemoState, workspaceId: string): TaskTemplate[] {
  return [
    SUPPORT,
    ...store(s).templates.filter(
      (t) => (t as TaskTemplate & { workspaceId?: string }).workspaceId === workspaceId,
    ),
  ];
}

/** The stamp a demo create from a template gives its task (the tasks demo calls it). */
export function demoStamp(
  s: DemoState,
  workspaceId: string,
  templateId: string,
  fields: Record<string, string>,
): TaskKindStamp | undefined {
  const t = templatesOf(s, workspaceId).find((item) => item.id === templateId);
  if (!t) return undefined;
  return {
    key: t.kind,
    name: t.name,
    templateId: t.id,
    templateVersion: t.version,
    stages: t.stages,
    review: t.review,
    slaMinutes: t.slaMinutes,
    fieldDefs: t.fields,
    fields: Object.fromEntries(t.fields.map((f) => [f.key, fields[f.key] ?? f.defaultValue])),
  };
}

function fromInput(input: TaskTemplateInput, id: string, version: number): TaskTemplate {
  return {
    id,
    kind: input.kind,
    name: input.name,
    description: input.description ?? "",
    stages: input.stages.map((stage) => ({
      key: stage.key,
      name: stage.name,
      checkpointRequired: stage.checkpointRequired ?? false,
      criteria: stage.criteria.map((text, i) => ({ label: `${stage.key}.${i + 1}`, text })),
    })),
    review: input.review ?? "none",
    slaMinutes: input.slaMinutes ?? null,
    fields: (input.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      required: f.required ?? false,
      defaultValue: f.defaultValue ?? "",
      relates: f.relates ?? false,
    })),
    builtIn: false,
    version,
    archivedAt: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

const tokens = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) as string[]);

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const m =
    req.match(/^\/api\/workspaces\/([^/]+)\/(task-templates)(?:\/([^/]+))?$/) ??
    req.match(/^\/api\/workspaces\/([^/]+)\/tasks\/([^/]+)\/(related)$/);
  if (!m) return undefined;
  const workspaceId = decodeURIComponent(m[1] ?? "") as WorkspaceId;
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  if (m[3] === "related") {
    const task = s.tasks.get(decodeURIComponent(m[2] ?? ""));
    if (!task || task.workspaceId !== workspaceId) return notFound("task");
    if (!task.kind) return ok({ taskId: task.id, kind: null, method: "lexical", related: [] });
    const own = tokens(task.title);
    const related = [...s.tasks.values()]
      .filter(
        (o) => o.id !== task.id && o.workspaceId === workspaceId && o.kind?.key === task.kind?.key,
      )
      .map((o) => {
        const other = tokens(o.title);
        const shared = [...own].filter((x) => other.has(x)).length;
        const score = own.size + other.size ? shared / (own.size + other.size - shared) : 0;
        return { o, score };
      })
      .filter(({ score }) => score >= 0.2)
      .map(({ o, score }) => ({
        id: o.id,
        title: o.title,
        status: o.status,
        createdAt: o.createdAt,
        reasons: [{ kind: "text", score: Math.round(score * 100) / 100 }],
        possibleDuplicate: score >= 0.6,
      }));
    return ok({ taskId: task.id, kind: task.kind.key, method: "lexical", related });
  }
  const id = m[3] ? decodeURIComponent(m[3]) : undefined;
  const own = store(s);
  if (!id) {
    if (req.method === "GET") return ok({ templates: templatesOf(s, workspaceId) });
    if (req.method !== "POST") return undefined;
    const input = req.body as unknown as TaskTemplateInput;
    if (
      typeof input.kind !== "string" ||
      templatesOf(s, workspaceId).some((t) => t.kind === input.kind)
    )
      return {
        status: 409,
        json: { code: "invalid_transition", message: "kind exists", details: {} },
      };
    const template = { ...fromInput(input, `ttpl_demo_${own.next++}`, 1), workspaceId };
    own.templates.push(template);
    return created({ template });
  }
  const index = own.templates.findIndex((t) => t.id === id);
  const current = own.templates[index];
  if (!current) return notFound("template");
  if (req.body.version !== current.version)
    return { status: 409, json: { code: "invalid_transition", message: "changed", details: {} } };
  const next =
    req.method === "DELETE"
      ? { ...current, version: current.version + 1, archivedAt: "2026-10-18T00:00:00.000Z" }
      : req.method === "PATCH"
        ? {
            ...fromInput(
              { ...(req.body as unknown as TaskTemplateInput), kind: current.kind },
              current.id,
              current.version + 1,
            ),
            workspaceId,
          }
        : undefined;
  if (!next) return undefined;
  if (next.archivedAt) own.templates.splice(index, 1);
  else own.templates[index] = next;
  return ok({ template: next });
}

export const demo: DemoFeature = { route };
