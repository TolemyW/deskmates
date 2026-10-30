// @vitest-environment jsdom
// T0: template management, task creation from a template, criteria and related tasks.

import "@testing-library/jest-dom/vitest";
import {
  TASK_STATUSES,
  type Task,
  type TaskKindStamp,
  type TaskListPage,
  type TaskStatus,
  type TaskTemplate,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WS_ID, bot, fakeFetch, task, workspace } from "../../test-support/fixtures.js";
import type { RecordedCall } from "../../test-support/fixtures.js";
import { selectOption } from "../../test-support/select.js";
import { TasksScreen } from "../tasks/tasks.js";
import { draftOfTemplate, inputOfDraft } from "./template-editor.js";
import { TemplatesSection } from "./templates-section.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

const ws = `/api/workspaces/${WS_ID}`;

const support: TaskTemplate = {
  id: "builtin:support-ticket",
  kind: "support-ticket",
  name: "Customer support ticket",
  description: "One customer request.",
  stages: [
    {
      key: "triage",
      name: "Triage",
      checkpointRequired: true,
      criteria: [{ label: "triage.1", text: "Customer recorded" }],
    },
    {
      key: "resolve",
      name: "Resolve",
      checkpointRequired: false,
      criteria: [{ label: "resolve.1", text: "Answer prepared" }],
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

const counts = (over: Partial<Record<TaskStatus, number>> = {}) =>
  ({ ...Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])), ...over }) as Record<
    TaskStatus,
    number
  >;

function kindFetch(extra: Record<string, unknown> = {}) {
  return fakeFetch({
    "GET /api/workspaces": { workspaces: [workspace] },
    [`GET ${ws}/task-templates`]: { templates: [support] },
    ...extra,
  });
}

describe("task templates within Tasks", () => {
  it("lets an Admin create a template from lines", async () => {
    let posted: unknown;
    const wire = kindFetch({
      [`POST ${ws}/task-templates`]: (call: RecordedCall) => {
        posted = call.body;
        return { template: { ...support, id: "ttpl_1", builtIn: false, kind: "invoice-check" } };
      },
    });
    render(<TemplatesSection api={createApiClient({ fetch: wire.fetch })} workspaceId={WS_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));
    const form = screen.getByRole("form", { name: "New template" });
    fireEvent.change(within(form).getByLabelText("Kind key"), {
      target: { value: "invoice-check" },
    });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Invoice check" } });
    fireEvent.change(within(form).getByLabelText("Target time in hours (empty: none)"), {
      target: { value: "2" },
    });
    fireEvent.change(within(form).getByLabelText("Stages and done criteria"), {
      target: { value: "check | Check | checkpoint\n- Totals match\n\nreport | Report\n- Listed" },
    });
    fireEvent.change(within(form).getByLabelText("Fields"), {
      target: { value: "supplier | Supplier | required, relates" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(posted).toBeDefined());
    expect(posted).toEqual({
      kind: "invoice-check",
      name: "Invoice check",
      description: "",
      review: "none",
      slaMinutes: 120,
      stages: [
        { key: "check", name: "Check", criteria: ["Totals match"], checkpointRequired: true },
        { key: "report", name: "Report", criteria: ["Listed"], checkpointRequired: false },
      ],
      fields: [
        { key: "supplier", label: "Supplier", required: true, relates: true, defaultValue: "" },
      ],
    });
  });

  it("round-trips a template through the line editor", () => {
    const input = inputOfDraft(draftOfTemplate(support));
    expect(input).toMatchObject({
      kind: "support-ticket",
      slaMinutes: 1440,
      review: "human",
      stages: [
        { key: "triage", criteria: ["Customer recorded"], checkpointRequired: true },
        { key: "resolve", criteria: ["Answer prepared"], checkpointRequired: false },
      ],
      fields: [
        { key: "customer", required: true, relates: true, defaultValue: "" },
        { key: "priority", required: false, relates: false, defaultValue: "P3" },
      ],
    });
    expect(draftOfTemplate(support, true).kind).toBe("support-ticket-custom");
    expect(inputOfDraft({ ...draftOfTemplate(support), stages: "- orphan" })).toEqual({
      invalid: "stages",
    });
  });
});

const listPage = (tasks: Task[]): TaskListPage => {
  const statusCounts = counts();
  for (const item of tasks) statusCounts[item.status] += 1;
  return { tasks, offset: 0, limit: 25, total: tasks.length, statusCounts };
};

describe("tasks with a kind (A4c, A4e, A4h)", () => {
  it("sends the template and its fields only when one is chosen", async () => {
    const bodies: unknown[] = [];
    const wire = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
      [`GET ${ws}/tasks?offset=0&limit=25`]: listPage([]),
      [`GET ${ws}/task-templates`]: { templates: [support] },
      [`POST ${ws}/tasks`]: (call: RecordedCall) => {
        bodies.push(call.body);
        return { task: task() };
      },
    });
    render(<TasksScreen api={createApiClient({ fetch: wire.fetch })} taskId="new" />);
    await screen.findByLabelText("Goal");
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Ticket" } });
    await selectOption("When work starts", "Manual");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty("templateId");
    expect(bodies[0]).not.toHaveProperty("fields");

    cleanup();
    render(<TasksScreen api={createApiClient({ fetch: wire.fetch })} taskId="new" />);
    await screen.findByLabelText("Goal");
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Ticket" } });
    await selectOption("When work starts", "Manual");
    await selectOption("Template", "Customer support ticket");
    const customer = await screen.findByLabelText("Customer (required)");
    expect(screen.getByLabelText("Priority")).toHaveValue("P3");
    fireEvent.change(customer, { target: { value: "ACME" } });
    expect(screen.getByText("triage.1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({
      title: "Ticket",
      templateId: "builtin:support-ticket",
      fields: { customer: "ACME", priority: "P3" },
    });
  });

  it("offers a template saved in the Templates dialog to the open create form (#63)", async () => {
    const templates: TaskTemplate[] = [support];
    const wire = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
      [`GET ${ws}/tasks?offset=0&limit=25`]: listPage([]),
      [`GET ${ws}/task-templates`]: () => ({ templates: [...templates] }),
      [`POST ${ws}/task-templates`]: () => {
        const template = {
          ...support,
          id: "ttpl_1",
          kind: "invoice-check",
          name: "Invoice check",
          builtIn: false,
        };
        templates.push(template);
        return { template };
      },
    });
    render(<TasksScreen api={createApiClient({ fetch: wire.fetch })} taskId="new" />);
    await screen.findByLabelText("Goal");
    fireEvent.click(screen.getByRole("button", { name: "Templates" }));
    const dialog = await screen.findByRole("dialog", { name: "Templates" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "New template" }));
    const form = within(dialog).getByRole("form", { name: "New template" });
    fireEvent.change(within(form).getByLabelText("Kind key"), {
      target: { value: "invoice-check" },
    });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Invoice check" } });
    fireEvent.change(within(form).getByLabelText("Stages and done criteria"), {
      target: { value: "check | Check\n- Totals match" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create template" }));
    expect(await within(dialog).findByText("Invoice check")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await selectOption("Template", "Invoice check");
  });

  it("shows a templated task's kind, criteria progress, discrepancies and related tasks", async () => {
    const kind: TaskKindStamp = {
      key: "support-ticket",
      name: "Customer support ticket",
      templateId: support.id,
      templateVersion: 1,
      stages: support.stages,
      review: "human",
      slaMinutes: 1440,
      fieldDefs: support.fields,
      fields: { customer: "ACME", priority: "P1" },
    };
    const templated = task({ kind, status: "delivered", deliveredAt: "2026-10-18T02:00:00Z" });
    const wire = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
      [`GET ${ws}/tasks?offset=0&limit=25`]: listPage([templated]),
      [`GET ${ws}/tasks/task_1`]: {
        task: templated,
        execution: {
          observedAt: "2026-10-18T05:00:00Z",
          submissions: [],
          linkedRuns: [],
          deliveries: [],
          latestCheckpoint: null,
        },
        kindProgress: {
          criteria: [
            {
              label: "triage.1",
              stageKey: "triage",
              text: "Customer recorded",
              state: "met",
              evidence: 2,
              reportedAt: "2026-10-18T01:00:00Z",
            },
            {
              label: "resolve.1",
              stageKey: "resolve",
              text: "Answer prepared",
              state: "open",
              evidence: 0,
              reportedAt: "2026-10-18T02:00:00Z",
            },
          ],
          currentStage: "resolve",
          missingCheckpoints: [],
          discrepancies: [{ kind: "delivered_open_criteria", items: ["resolve.1"] }],
        },
      },
      [`GET ${ws}/tasks/task_1/related`]: {
        taskId: "task_1",
        kind: "support-ticket",
        method: "lexical",
        related: [
          {
            id: "task_9",
            title: "Same login loop",
            status: "planned",
            createdAt: "2026-10-18T03:00:00Z",
            reasons: [
              { kind: "field", field: "customer", label: "Customer", value: "ACME" },
              { kind: "text", score: 0.82 },
            ],
            possibleDuplicate: true,
          },
        ],
      },
    });
    render(<TasksScreen api={createApiClient({ fetch: wire.fetch })} taskId="task_1" />);
    const panel = await screen.findByRole("region", { name: "Task kind" });
    expect(within(panel).getByText("Kind: Customer support ticket")).toBeInTheDocument();
    expect(within(panel).getByText("ACME")).toBeInTheDocument();
    expect(await within(panel).findByText("Current stage: Resolve")).toBeInTheDocument();
    expect(within(panel).getByText("2 evidence paths", { exact: false })).toBeInTheDocument();
    expect(
      within(panel).getByText("Delivered while these criteria were last reported open: resolve.1"),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Same login loop" })).toHaveAttribute(
      "href",
      "#/tasks/task_9",
    );
    expect(within(panel).getByText("Possible duplicate")).toBeInTheDocument();
    expect(
      within(panel).getByText("same Customer: ACME · similar text 0.82", { exact: false }),
    ).toBeInTheDocument();
  });
});

it("locks template mutations during archive and restores controls on failure", async () => {
  let rejectArchive: (reason: Error) => void = () => {};
  const pending = new Promise<never>((_resolve, reject) => {
    rejectArchive = reject;
  });
  const wire = fakeFetch({
    [`GET ${ws}/task-templates`]: { templates: [{ ...support, id: "ttpl_1", builtIn: false }] },
    [`DELETE ${ws}/task-templates/ttpl_1`]: () => pending,
  });
  render(<TemplatesSection api={createApiClient({ fetch: wire.fetch })} workspaceId={WS_ID} />);
  const archive = await screen.findByRole("button", { name: /^Archive$/ });
  fireEvent.click(archive);
  fireEvent.click(archive);
  expect(archive).toBeDisabled();
  expect(screen.getByRole("button", { name: "New template" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Edit$/ })).toBeDisabled();
  expect(wire.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  rejectArchive(new Error("archive unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cannot connect to the server");
  expect(archive).toBeEnabled();
  expect(screen.getByText("Customer support ticket")).toBeInTheDocument();
});
