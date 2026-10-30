import { selectOption } from "../../test-support/select.js";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  type CreateTaskInput,
  TASK_STATUSES,
  type Task,
  type TaskListPage,
  type TaskStatus,
  type UpdateTaskInput,
  type WorkspaceId,
} from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import {
  BOT_ID,
  RUN_ID,
  THREAD_ID,
  WS_ID,
  bot,
  fakeFetch,
  run as runFixture,
  task,
  thread,
  workspace,
} from "../../test-support/fixtures.js";
import type { RecordedCall } from "../../test-support/fixtures.js";
import { TasksScreen, acceptedByLabel, deliveredByLabel } from "./tasks.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const base = `/api/workspaces/${WS_ID}/tasks`;
/** The first page of a workspace's tasks, as the Gateway answers it (#113). */
const firstPage = "?offset=0&limit=25";

/** A whole list as one Gateway page, with its counts by status. */
function listPage(tasks: Task[], offset = 0, total = tasks.length): TaskListPage {
  const statusCounts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >;
  for (const item of tasks) statusCounts[item.status] += 1;
  return { tasks, offset, limit: 25, total, statusCounts };
}
const deliveredAt = "2026-10-04T06:00:00Z";

function setup(initial = task()) {
  let saved = initial;
  const wire = fakeFetch({
    "GET /api/workspaces": { workspaces: [workspace] },
    [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
    [`GET /api/threads?workspaceId=${WS_ID}`]: {
      threads: [{ ...thread, memberIds: [BOT_ID] }],
    },
    [`GET /api/runs?workspaceId=${WS_ID}&limit=100`]: { runs: [runFixture()] },
    [`GET /api/workspaces/${WS_ID}/assets?offset=0&limit=100`]: {
      scope: { workspaceId: WS_ID },
      items: [
        {
          path: "/work/report.md",
          name: "report.md",
          kind: "documents",
          source: "bot",
          verification: "unverified",
          lastReferencedAt: deliveredAt,
          referenceCount: 1,
          references: [],
        },
      ],
      total: 1,
      offset: 0,
      limit: 100,
      truncated: false,
      facets: { types: {}, sources: {} },
    },
    [`GET ${base}${firstPage}`]: () => listPage([saved]),
    [`GET ${base}/${initial.id}`]: () => ({
      task: saved,
      execution: {
        observedAt: deliveredAt,
        submissions: [],
        linkedRuns: [],
        deliveries: [],
        latestCheckpoint: null,
      },
    }),
    [`POST ${base}`]: (call: RecordedCall) => {
      saved = task({ ...(call.body as CreateTaskInput) });
      return { task: saved };
    },
    [`PATCH ${base}/${initial.id}`]: (call: RecordedCall) => {
      const { schedule: _schedule, ...patch } = call.body as UpdateTaskInput;
      expect(patch.version).toBe(saved.version);
      saved = {
        ...saved,
        ...patch,
        version: saved.version + 1,
        deliveredAt: patch.status === "delivered" ? deliveredAt : null,
        acceptedAt: null,
        acceptedBy: null,
      };
      return { task: saved };
    },
    [`POST ${base}/${initial.id}/accept`]: (call: RecordedCall) => {
      expect(call.body).toEqual({ version: saved.version });
      saved = {
        ...saved,
        status: "accepted",
        version: saved.version + 1,
        acceptedAt: deliveredAt,
        acceptedBy: "human:web",
      };
      return { task: saved };
    },
  });
  return { api: createApiClient({ fetch: wire.fetch }), calls: wire.calls, current: () => saved };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function ready() {
  await screen.findByLabelText("Goal");
  const editor = screen.queryByText("Edit goal");
  if (editor && !editor.parentElement?.hasAttribute("open")) fireEvent.click(editor);
}

function openAdvanced() {
  fireEvent.click(screen.getByText("Advanced options"));
}

function openSystemDetails() {
  fireEvent.click(screen.getByText("System details"));
}

describe("acceptance attribution label", () => {
  it("distinguishes a signed-in person from the shared operator label", () => {
    expect(acceptedByLabel("human:web")).toBe("human:web (shared operator label)");
    expect(acceptedByLabel("user:usr_1")).toBe("user:usr_1 (signed-in person)");
    expect(acceptedByLabel(null)).toBe("");
  });
});

describe("bot delivery (ADR-0021 amendment 2)", () => {
  it("labels who delivered", () => {
    expect(deliveredByLabel("bot:bot_1")).toBe("bot:bot_1 (bot, through task_deliver)");
    expect(deliveredByLabel("user:usr_1")).toBe("user:usr_1 (signed-in person)");
    expect(deliveredByLabel("human:web")).toBe("human:web (shared operator label)");
    expect(deliveredByLabel(null)).toBe("");
  });

  it("shows the deliverer, the schema and the output as inert text", async () => {
    const outputSchema = { type: "object", required: ["note"] };
    const output = {
      note: "<img src=x onerror=alert(1)>",
      rows: [1, 2],
      open_issues: ["Verify the source period before acceptance."],
    };
    const { api } = setup(
      task({
        status: "delivered",
        version: 2,
        deliveredAt,
        deliveredBy: `bot:${BOT_ID}`,
        outputSchema,
        output,
        artifacts: [{ label: "Report", path: "/work/report.md", runId: RUN_ID }],
      }),
    );
    const { container } = render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    expect(screen.getByText("System details").parentElement).not.toHaveAttribute("open");
    openSystemDetails();
    expect(
      screen.getByText(new RegExp(`bot:${BOT_ID} \\(bot, through task_deliver\\)`)),
    ).toBeVisible();
    const shownOutput = screen.getByRole("region", { name: "Delivered output" });
    expect(shownOutput).toBeVisible();
    expect(within(shownOutput).getByText(output.note)).toBeVisible();
    expect(shownOutput.closest("details")).toBeNull();
    expect(within(shownOutput).getAllByRole("term")[0]).toHaveTextContent("open issues");
    expect(within(shownOutput).getByText(output.open_issues[0] as string)).toBeVisible();
    const shownSchema = screen.getByRole("region", { name: "Output schema" });
    expect(within(shownSchema).getByText(/required/).textContent).toBe(
      JSON.stringify(outputSchema, null, 2),
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows neither section for a task without schema or output", async () => {
    const { api } = setup();
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    expect(screen.queryByRole("region", { name: "Delivered output" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Output schema" })).not.toBeInTheDocument();
  });
});

describe("operator task management", () => {
  it("leads with the goal and result, keeping editing and technical fields collapsed", async () => {
    const { api } = setup(
      task({
        status: "delivered",
        ownerBotId: BOT_ID,
        description: "Summarize this week's findings",
        artifacts: [{ label: "Findings", path: "/work/report.md" }],
      }),
    );
    render(<TasksScreen api={api} taskId="task_1" />);
    expect(await screen.findByRole("button", { name: "Accept delivery" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeVisible();
    expect(screen.getByLabelText("Goal")).not.toBeVisible();
    expect(screen.getByText("System details").parentElement).not.toHaveAttribute("open");
    expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload latest task" })).not.toBeInTheDocument();
    expect(
      await screen.findByText("Findings", { selector: ".task-deliveries strong" }),
    ).toBeVisible();
    const runTask = vi
      .spyOn(api, "runTask")
      .mockResolvedValue({ task: task({ ownerBotId: BOT_ID, status: "in_progress", version: 2 }) });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(runTask).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What should change?")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Request changes" })).toHaveFocus();
    expect(runTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fill("What should change?", "Include the missing sources.");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and start revision" }));
    await screen.findByText("Feedback sent. Revision queued.");
    expect(runTask).toHaveBeenCalledWith(
      WS_ID,
      "task_1",
      1,
      expect.stringMatching(/^web-/),
      "Include the missing sources.",
    );
    expect(screen.getByRole("button", { name: "Start work" })).toBeVisible();
  });

  it("keeps revision feedback and the same request key after a lost response", async () => {
    const initial = task({ ownerBotId: BOT_ID, status: "delivered" });
    const { api } = setup(initial);
    const execute = vi
      .spyOn(api, "runTask")
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ task: { ...initial, status: "in_progress", version: 2 } });
    render(<TasksScreen api={api} taskId="task_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    fill("What should change?", "Keep the caveat visible.");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and start revision" }));
    await screen.findByText("Connection lost");
    expect(screen.getByLabelText("What should change?")).toHaveValue("Keep the caveat visible.");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and start revision" }));
    await screen.findByText("Feedback sent. Revision queued.");
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  });

  it("lets rejected feedback be edited and resent under a fresh key", async () => {
    const initial = task({ ownerBotId: BOT_ID, status: "delivered" });
    const { api } = setup(initial);
    const execute = vi
      .spyOn(api, "runTask")
      .mockRejectedValueOnce(new ApiError("validation", "feedback is too vague", 400))
      .mockResolvedValueOnce({ task: { ...initial, status: "in_progress", version: 2 } });
    render(<TasksScreen api={api} taskId="task_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    fill("What should change?", "Fix it.");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and start revision" }));
    await screen.findByText("feedback is too vague");
    const feedback = screen.getByLabelText("What should change?");
    expect(feedback).toHaveValue("Fix it.");
    expect(feedback).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Reload and discard draft" })).toBeNull();
    fill("What should change?", "Add the missing sources for section 2.");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and start revision" }));
    await screen.findByText("Feedback sent. Revision queued.");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[4]).toBe("Add the missing sources for section 2.");
    expect(execute.mock.calls[1]?.[3]).not.toBe(execute.mock.calls[0]?.[3]);
  });

  it("preserves feedback on a concurrent edit and offers an explicit reload", async () => {
    const initial = task({ ownerBotId: BOT_ID, status: "delivered" });
    const { api } = setup(initial);
    vi.spyOn(api, "runTask").mockRejectedValue(
      new ApiError("invalid_transition", "Task changed", 409),
    );
    render(<TasksScreen api={api} taskId="task_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    fill("What should change?", "Retain this feedback until reviewed.");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback and start revision" }));
    expect(await screen.findByRole("button", { name: "Reload and discard draft" })).toBeVisible();
    expect(screen.getByLabelText("What should change?")).toHaveValue(
      "Retain this feedback until reviewed.",
    );
    expect(screen.getByLabelText("What should change?")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Accept delivery" })).toBeDisabled();
  });

  it("uses the authenticated name in delivery and acceptance with IDs retained in audit details", async () => {
    const { api } = setup(
      task({
        status: "accepted",
        deliveredAt,
        deliveredBy: "user:usr_self",
        acceptedAt: deliveredAt,
        acceptedBy: "user:usr_self",
      }),
    );
    render(
      <SessionRolesProvider
        roles={{ tenantRole: "admin", platformMaintainer: false }}
        actorId="user:usr_self"
        displayName="Demo operator"
      >
        <TasksScreen api={api} taskId="task_1" />
      </SessionRolesProvider>,
    );
    await ready();
    openSystemDetails();
    expect(screen.getAllByText(/Demo operator/)).toHaveLength(2);
    for (const label of screen.getAllByText("user:usr_self"))
      expect(label.closest("details")).not.toBeNull();
  });

  it("creates a task with owner and choices for related work and files", async () => {
    const { api, calls } = setup();
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    expect(screen.getByText(/Set a goal, choose a responsible Bot/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to tasks" })).toHaveAttribute("href", "#/tasks");
    openAdvanced();
    fill("Goal", "Weekly findings");
    fill("Details and success criteria", "Review the sources");
    await selectOption("Owner bot", "ops");
    await selectOption("When work starts", "Immediately");
    fireEvent.click(screen.getByRole("checkbox", { name: /^Morning check chat$/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^waiting to start · run_1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add result file" }));
    fill("Result file 1 label", "Draft report");
    await selectOption("Result file 1", "/work/report.md");
    await selectOption("Result file 1 related work (optional)", "waiting to start · run_1");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/task_1"));
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      {
        method: "POST",
        path: base,
        body: {
          title: "Weekly findings",
          description: "Review the sources",
          ownerBotId: BOT_ID,
          threadIds: [THREAD_ID],
          runIds: [RUN_ID],
          artifacts: [{ label: "Draft report", path: "/work/report.md", runId: RUN_ID }],
          trigger: "immediate",
          idempotencyKey: expect.stringMatching(/^web-/),
        },
      },
    ]);
    openSystemDetails();
    expect(screen.getByRole("link", { name: `Open chat · ${THREAD_ID}` })).toHaveAttribute(
      "href",
      `#/threads/${THREAD_ID}`,
    );
    expect(screen.getByRole("link", { name: `Open work · ${RUN_ID}` })).toHaveAttribute(
      "href",
      `#/runs/${RUN_ID}`,
    );
    expect(screen.getByRole("link", { name: `Result file work · ${RUN_ID}` })).toHaveAttribute(
      "href",
      `#/runs/${RUN_ID}`,
    );
    expect(await screen.findByRole("button", { name: "Preview of /work/report.md" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Download /work/report.md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept delivery" })).not.toBeInTheDocument();
  });

  it("keeps the task list visible but hides creation controls from a Member", async () => {
    const { api } = setup();
    render(
      <SessionRolesProvider roles={{ tenantRole: "member", platformMaintainer: false }}>
        <TasksScreen api={api} taskId="new" />
      </SessionRolesProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Task list" })).toBeVisible();
    expect(screen.queryByLabelText("Goal")).toBeNull();
    expect(screen.queryByRole("form", { name: "Create task" })).toBeNull();
    expect(screen.queryByRole("link", { name: "New task" })).toBeNull();
  });

  it("edits owner/status, enforces blocker and next action, and shows blockers in the list", async () => {
    const { api, current } = setup();
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    openAdvanced();
    const update = vi.spyOn(api, "updateTask");
    await selectOption("Owner bot", "ops");
    await selectOption("Status", "In progress");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Task saved.");
    expect(update).toHaveBeenLastCalledWith(
      WS_ID,
      "task_1",
      expect.objectContaining({ version: 1, ownerBotId: BOT_ID, status: "in_progress" }),
    );
    await selectOption("Status", "Blocked");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Blocked tasks need a reason and a next action.");
    expect(update).toHaveBeenCalledTimes(1);
    fill("Blocked reason", "Missing source export");
    fill("Next action", "Ask the operator for the export");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Task saved.");
    expect(current()).toMatchObject({
      status: "blocked",
      version: 3,
      blockedReason: "Missing source export",
      nextAction: "Ask the operator for the export",
    });
    expect(
      within(screen.getByRole("complementary", { name: "Workspace tasks" })).getByText(
        "Missing source export",
      ),
    ).toBeVisible();
  });

  it("requires an artifact for delivery and explicit human acceptance with the loaded version", async () => {
    const { api, current, calls } = setup();
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    openAdvanced();
    await selectOption("Status", "Needs your review");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Add at least one result file before marking this task delivered.");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Add result file" }));
    fill("Result file 1 label", "Report");
    await selectOption("Result file 1", "/work/report.md");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Accept delivery" });
    expect(current()).toMatchObject({ status: "delivered", version: 2, acceptedAt: null });
    expect(calls.some((call) => call.path.endsWith("/accept"))).toBe(false);
    fill("Details and success criteria", "Unsaved description");
    expect(screen.getByRole("button", { name: "Accept delivery" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Accept delivery" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept delivery" }));
    await screen.findByText("Delivery accepted by the operator.");
    expect(current()).toMatchObject({ status: "accepted", version: 4, acceptedBy: "human:web" });
    expect(calls.filter((call) => call.method !== "GET").at(-1)).toEqual({
      method: "POST",
      path: `${base}/task_1/accept`,
      body: { version: 3 },
    });
    expect(screen.getByLabelText("Goal")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    openSystemDetails();
    expect(screen.getByText(/shared operator label/)).toBeVisible();
  });

  it.each(["accepted", "cancelled"] as const)(
    "keeps %s tasks read-only until an explicit reopen clears metadata",
    async (status) => {
      const { api, current } = setup(
        task({ status, version: 4, deliveredAt, acceptedAt: deliveredAt, acceptedBy: "human:web" }),
      );
      const update = vi.spyOn(api, "updateTask");
      render(<TasksScreen api={api} taskId="task_1" />);
      await ready();
      openAdvanced();
      expect(screen.getByLabelText("Goal")).toBeDisabled();
      expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: status === "accepted" ? "Reopen as planned" : "Reopen in progress",
        }),
      );
      await screen.findByLabelText("Status");
      expect(update).toHaveBeenCalledWith(WS_ID, "task_1", {
        version: 4,
        status: status === "accepted" ? "planned" : "in_progress",
      });
      expect(current()).toMatchObject({ deliveredAt: null, acceptedAt: null, acceptedBy: null });
      expect(screen.getByLabelText("Goal")).toBeEnabled();
    },
  );

  it("shows an old checkpoint as historical and preserves a delivery result snapshot", async () => {
    const initial = task({ scopeVersion: 2 });
    const { api } = setup(initial);
    vi.spyOn(api, "getTaskDetail").mockResolvedValue({
      task: initial,
      execution: {
        observedAt: deliveredAt,
        submissions: [],
        linkedRuns: [],
        latestCheckpoint: {
          id: "cp-old",
          taskId: initial.id,
          runId: RUN_ID,
          botId: BOT_ID,
          attempt: 1,
          scopeVersion: 1,
          createdAt: deliveredAt,
          completed: [{ unit: "Outline", outcome: "ready", evidence: ["/work/outline.md"] }],
          outstanding: [],
          note: "",
        },
        deliveries: [
          {
            id: "delivery-old",
            kind: "complete",
            runId: RUN_ID,
            attempt: 1,
            deliveredBy: "bot:b",
            scopeVersion: 1,
            summary: "Earlier result",
            output: { priorResult: "<script>old result</script>" },
            outstanding: [],
            createdAt: deliveredAt,
            publications: [],
          },
        ],
      },
    });
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    expect(
      await screen.findByText(/Historical checkpoint \(scope 1; current 2\)/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Structured result at this delivery")[0] as HTMLElement);
    expect(screen.getAllByText(/<script>old result<\/script>/).length).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
  });

  it("uses pickers instead of asking for raw conversation, run or file IDs", async () => {
    const { api } = setup();
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    openAdvanced();
    expect(screen.queryByLabelText("Conversation IDs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Run IDs")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Related chats" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Related work" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add result file" }));
    expect(screen.getByLabelText("Result file 1")).toBeVisible();
    expect(screen.queryByPlaceholderText("/work/result.md")).not.toBeInTheDocument();
  });

  it("retains unsaved text after a version conflict and requires explicit reload", async () => {
    const { api } = setup();
    const update = vi
      .spyOn(api, "updateTask")
      .mockRejectedValueOnce(new ApiError("invalid_transition", "Task changed", 409));
    const get = vi.spyOn(api, "getTask");
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fill("Goal", "My unsaved report title");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Your unsaved draft is still here/);
    expect(screen.getByLabelText("Goal")).toHaveValue("My unsaved report title");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValueOnce(task({ title: "Their saved title", version: 7 }));
    fireEvent.click(screen.getByRole("button", { name: "Reload and discard draft" }));
    await screen.findByText("Latest task loaded.");
    expect(screen.getByLabelText("Goal")).toHaveValue("Their saved title");
    fill("Goal", "Reconciled title");
    update.mockResolvedValueOnce(task({ title: "Reconciled title", version: 8 }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Task saved.");
    expect(update).toHaveBeenLastCalledWith(
      WS_ID,
      "task_1",
      expect.objectContaining({ version: 7, title: "Reconciled title" }),
    );
  });

  it("retains the delivered view on acceptance conflict until explicitly reloaded", async () => {
    const { api } = setup(
      task({
        status: "delivered",
        artifacts: [{ label: "Report", path: "/work/report.md" }],
        deliveredAt,
      }),
    );
    vi.spyOn(api, "acceptTask").mockRejectedValueOnce(
      new ApiError("invalid_transition", "Task changed", 409),
    );
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Accept delivery" }));
    await screen.findByText(/Your unsaved draft is still here/);
    expect(screen.getByRole("button", { name: "Accept delivery" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload and discard draft" })).toBeEnabled();
  });

  it("refreshes the list and owner choices without replacing an unsaved detail draft", async () => {
    const { api } = setup();
    const list = vi.spyOn(api, "listTasks");
    const owners = vi.spyOn(api, "listBots");
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fill("Goal", "Local draft");
    list.mockResolvedValueOnce(listPage([task({ title: "New server title", version: 2 })]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh task list" }));
    await screen.findByText("New server title");
    expect(screen.getByLabelText("Goal")).toHaveValue("Local draft");
    expect(owners).toHaveBeenCalledTimes(2);
    expect(owners).toHaveBeenLastCalledWith(WS_ID);
  });

  it("does not duplicate submissions even before disabled controls repaint", async () => {
    const { api } = setup();
    const pending = deferred<Task>();
    const create = vi.spyOn(api, "createTask").mockReturnValue(pending.promise);
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    fill("Goal", "New report");
    await selectOption("When work starts", "Manual");
    const form = screen.getByRole("form", { name: "Create task" });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => pending.resolve(task({ title: "New report" })));
    expect(window.location.hash).toBe("#/tasks/task_1");
  });

  it("does not duplicate explicit acceptance", async () => {
    const initial = task({
      status: "delivered",
      deliveredAt,
      artifacts: [{ label: "Report", path: "/work/report.md" }],
    });
    const { api } = setup(initial);
    const pending = deferred<Task>();
    const accept = vi.spyOn(api, "acceptTask").mockReturnValue(pending.promise);
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    const button = screen.getByRole("button", { name: "Accept delivery" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(accept).toHaveBeenCalledOnce();
    await act(async () =>
      pending.resolve({
        ...initial,
        status: "accepted",
        acceptedAt: deliveredAt,
        acceptedBy: "human:web",
        version: 2,
      }),
    );
    expect(screen.queryByRole("button", { name: "Accept delivery" })).not.toBeInTheDocument();
  });
});

describe("task async navigation boundaries", () => {
  it("still shows the new workspace's task list when the old selected ID returns a real 404", async () => {
    const ws2 = "ws_2" as WorkspaceId;
    const foreign = task({ id: "task_other", workspaceId: ws2, title: "Other workspace task" });
    const wire = fakeFetch({
      "GET /api/workspaces": {
        workspaces: [workspace, { ...workspace, id: ws2, name: "Other team" }],
      },
      [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
      [`GET /api/bots?workspaceId=${ws2}`]: { bots: [] },
      [`GET ${base}${firstPage}`]: listPage([task()]),
      [`GET ${base}/task_1`]: { task: task() },
      [`GET /api/workspaces/${ws2}/tasks${firstPage}`]: listPage([foreign]),
      // No ws_2/tasks/task_1 route: fakeFetch returns the real 404 JSON error shape.
    });
    const api = createApiClient({ fetch: wire.fetch });
    function SwitchWorkspace() {
      const scope = useWorkspaceScope(api);
      return (
        <button type="button" onClick={() => scope.select(ws2)}>
          Switch workspace
        </button>
      );
    }
    render(
      <WorkspaceScopeProvider api={api} initialWorkspaceId={WS_ID}>
        <SwitchWorkspace />
        <TasksScreen api={api} taskId="task_1" />
      </WorkspaceScopeProvider>,
    );
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
    await screen.findByRole("link", { name: /Other workspace task/ });
    expect(screen.getByTestId("deleted-object")).toHaveTextContent(
      "This item is no longer available",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "#/tasks/new");
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale task load that finishes with %s after navigation",
    async (outcome) => {
      const { api } = setup();
      const old = deferred<Task>();
      vi.spyOn(api, "getTask").mockImplementation((_ws, id) =>
        id === "task_1" ? old.promise : Promise.resolve(task({ id, title: "Second task" })),
      );
      const view = render(<TasksScreen api={api} taskId="task_1" />);
      await waitFor(() => expect(api.getTask).toHaveBeenCalledWith(WS_ID, "task_1"));
      view.rerender(<TasksScreen api={api} taskId="task_2" />);
      await ready();
      expect(screen.getByLabelText("Goal")).toHaveValue("Second task");
      await act(async () => {
        if (outcome === "resolve") old.resolve(task());
        else old.reject(new Error("Old task failed"));
      });
      expect(screen.getByLabelText("Goal")).toHaveValue("Second task");
      expect(screen.queryByText("Old task failed")).not.toBeInTheDocument();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a stale mutation that finishes with %s after navigation",
    async (outcome) => {
      const { api } = setup();
      const old = deferred<Task>();
      vi.spyOn(api, "updateTask").mockReturnValue(old.promise);
      vi.spyOn(api, "getTask").mockImplementation((_ws, id) =>
        Promise.resolve(task({ id, title: id === "task_1" ? "First task" : "Second task" })),
      );
      const view = render(<TasksScreen api={api} taskId="task_1" />);
      await ready();
      fill("Goal", "Saving first task");
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      view.rerender(<TasksScreen api={api} taskId="task_2" />);
      await ready();
      await act(async () => {
        if (outcome === "resolve") old.resolve(task({ title: "Saved first task" }));
        else old.reject(new ApiError("invalid_transition", "Old save conflict", 409));
      });
      expect(screen.getByLabelText("Goal")).toHaveValue("Second task");
      expect(screen.queryByText("Old save conflict")).not.toBeInTheDocument();
      expect(screen.queryByText("Task saved.")).not.toBeInTheDocument();
    },
  );

  it("does not navigate back when a create finishes after switching workspace", async () => {
    const ws2 = "ws_2" as WorkspaceId;
    const { api } = setup();
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([
      workspace,
      { ...workspace, id: ws2, name: "Other team" },
    ]);
    vi.spyOn(api, "listTasks").mockImplementation((id) =>
      Promise.resolve(listPage(id === WS_ID ? [task()] : [])),
    );
    vi.spyOn(api, "listBots").mockImplementation((id) =>
      Promise.resolve(id === WS_ID ? [bot] : []),
    );
    const pending = deferred<Task>();
    vi.spyOn(api, "createTask").mockReturnValue(pending.promise);
    function SwitchWorkspace() {
      const scope = useWorkspaceScope(api);
      return (
        <button type="button" onClick={() => scope.select(ws2)}>
          Switch workspace
        </button>
      );
    }
    render(
      <WorkspaceScopeProvider api={api} initialWorkspaceId={WS_ID}>
        <SwitchWorkspace />
        <TasksScreen api={api} taskId="new" />
      </WorkspaceScopeProvider>,
    );
    await ready();
    fill("Goal", "Old workspace task");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
    await waitFor(() =>
      expect(api.listTasks).toHaveBeenLastCalledWith(ws2, { offset: 0, limit: 25 }),
    );
    await ready();
    await act(async () => pending.resolve(task({ title: "Old workspace task" })));
    expect(screen.getByLabelText("Goal")).toHaveValue("");
    expect(screen.queryByText("Old workspace task")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(api.listTasks).toHaveBeenLastCalledWith(ws2, { offset: 0, limit: 25 });
    expect(api.listBots).toHaveBeenLastCalledWith(ws2);
  });

  it("does not regress a saved row when an older list refresh finishes", async () => {
    const { api } = setup();
    const list = vi.spyOn(api, "listTasks");
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    const pending = deferred<TaskListPage>();
    list.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh task list" }));
    fill("Goal", "Latest saved title");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Task saved.");
    await act(async () => pending.resolve(listPage([task()])));
    expect(
      within(screen.getByRole("complementary", { name: "Workspace tasks" })).getByText(
        "Latest saved title",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Goal")).toHaveValue("Latest saved title");
  });
});

describe("task triggers and execution (ADR-0021 amendment 3)", () => {
  it("defaults to a valid Manual task and saves the untouched choices", async () => {
    const { api } = setup();
    const create = vi.spyOn(api, "createTask");
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    fill("Goal", "Track it");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      title: "Track it",
      ownerBotId: null,
      trigger: "manual",
    });
  });

  it("shows an immediate-owner error at its field and sends a schedule only when Scheduled", async () => {
    const { api } = setup();
    const create = vi.spyOn(api, "createTask").mockResolvedValue(task({ title: "Later" }));
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    fill("Goal", "Later");
    await selectOption("When work starts", "Immediately");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    const error = await screen.findByText(/Choose a responsible Bot/);
    expect(error.closest('[data-task-field="owner"]')).not.toBeNull();
    // Validation focuses its field in the next animation frame, after the error renders.
    await waitFor(() =>
      expect(error.closest('[data-task-field="owner"]')).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
    expect(create).not.toHaveBeenCalled();
    await selectOption("Owner bot", "ops");
    await selectOption("When work starts", "Scheduled");
    await selectOption("Schedule", "Repeats");
    fill("Repeat pattern (minute hour day month weekday)", "0 9 * * 1");
    fill("Time zone", "Asia/Shanghai");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      title: "Later",
      trigger: "scheduled",
      schedule: { kind: "repeat", cron: "0 9 * * 1", timeZone: "Asia/Shanghai" },
    });
  });

  it("reads a one-time start as local time and offers no zone beside it (#63 L24)", async () => {
    const { api } = setup();
    const create = vi.spyOn(api, "createTask").mockResolvedValue(task({ title: "Once" }));
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    fill("Goal", "Once");
    await selectOption("Owner bot", "ops");
    await selectOption("When work starts", "Scheduled");
    await selectOption("Schedule", "Repeats");
    fill("Time zone", "Asia/Tokyo");
    await selectOption("Schedule", "Once");
    expect(screen.queryByLabelText("Time zone")).toBeNull();
    fill("Starts at (your local time)", "2099-01-02T09:00");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      trigger: "scheduled",
      schedule: {
        kind: "once",
        runAt: new Date("2099-01-02T09:00").toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  });

  it("shows measured execution beside the declared state and runs only on Run", async () => {
    const initial = task({
      ownerBotId: BOT_ID,
      runIds: [RUN_ID],
      schedule: {
        kind: "repeat",
        runAt: null,
        cron: "0 9 * * 1",
        timeZone: "UTC",
        enabled: true,
        version: 1,
        nextFireAt: "2026-10-19T09:00:00.000Z",
        lastFiredAt: null,
      },
    });
    const { api } = setup(initial);
    const run = {
      id: RUN_ID,
      botId: BOT_ID,
      status: "running" as const,
      attempt: 1,
      createdAt: deliveredAt,
      startedAt: deliveredAt,
      finishedAt: null,
      pendingApprovals: 1,
    };
    vi.spyOn(api, "getTaskDetail").mockResolvedValue({
      task: initial,
      execution: {
        observedAt: "2026-10-13T12:00:00.000Z",
        submissions: [
          {
            id: "tsub_1",
            taskId: initial.id,
            kind: "immediate",
            key: "create:k",
            scopeVersion: 1,
            actor: "human:web",
            dispatch: "posted",
            occurrenceAt: null,
            threadId: THREAD_ID,
            messageId: null,
            createdAt: deliveredAt,
            runs: [run],
            state: "running",
          },
        ],
        linkedRuns: [run],
        deliveries: [
          {
            id: "tdl_1",
            kind: "partial",
            runId: RUN_ID,
            attempt: 1,
            deliveredBy: "bot:b",
            scopeVersion: 1,
            summary: "Half done",
            outstanding: ["Illustrated report"],
            createdAt: deliveredAt,
            publications: [],
          },
        ],
        latestCheckpoint: null,
      },
    });
    const runTask = vi
      .spyOn(api, "runTask")
      .mockResolvedValue({ task: { ...initial, version: 2 } });
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    expect(
      await screen.findByText(/Linked work is active while the task is still Planned/),
    ).toBeVisible();
    expect(screen.getByText(/The latest delivery is partial: 1 item/)).toBeVisible();
    expect(screen.getAllByText("Working").some((item) => !item.closest("details"))).toBe(true);
    expect(screen.getByRole("link", { name: /1 approval\(s\) waiting/ })).toBeVisible();
    expect(screen.getByText(/Next occurrence/)).toBeVisible();
    expect(runTask).not.toHaveBeenCalled();
    openAdvanced();
    fill("Next action", "Edited without rerunning");
    expect(screen.getByRole("button", { name: "Start work" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Task saved.");
    fireEvent.click(screen.getByRole("button", { name: "Start work" }));
    await waitFor(() => expect(runTask).toHaveBeenCalledOnce());
    expect(runTask.mock.calls[0]?.slice(1, 3)).toEqual(["task_1", 2]);
    expect(String(runTask.mock.calls[0]?.[3])).toMatch(/^web-/);
  });

  it("deletes only after confirmation", async () => {
    const { api } = setup(task({ ownerBotId: BOT_ID }));
    const remove = vi.spyOn(api, "deleteTask").mockResolvedValue();
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fireEvent.click(await screen.findByText("Technical activity details"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete task" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/history, chats and published files are kept/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(WS_ID, "task_1", 1));
    expect(await screen.findByText("Task deleted.")).toBeVisible();
  });

  it("offers delivery preview of a published file in the file drawer (ADR-0014 A6 decision 40)", async () => {
    const initial = task({ ownerBotId: BOT_ID, runIds: [RUN_ID] });
    const { api } = setup(initial);
    vi.spyOn(api, "getTaskDetail").mockResolvedValue({
      task: initial,
      execution: {
        observedAt: "2026-10-13T12:00:00.000Z",
        submissions: [],
        linkedRuns: [],
        deliveries: [
          {
            id: "tdl_2",
            kind: "complete",
            runId: RUN_ID,
            attempt: 1,
            deliveredBy: "bot:b",
            scopeVersion: 1,
            summary: "Done",
            outstanding: [],
            createdAt: deliveredAt,
            publications: [
              {
                path: "/work/out/report.md",
                label: "Report",
                sizeBytes: 12,
                sha256: "a".repeat(64),
                checkedAt: deliveredAt,
              },
            ],
          },
        ],
        latestCheckpoint: null,
      },
    });
    const read = vi.spyOn(api, "readWorkspaceFileRange").mockResolvedValue({
      blob: new Blob(["# Report"]),
      fileSize: 8,
      start: 0,
      end: 7,
    });
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    expect(
      await screen.findByRole("button", { name: "Download /work/out/report.md" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview of /work/out/report.md" }));
    expect(await screen.findByRole("dialog", { name: "report.md" })).toBeVisible();
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(read.mock.calls[0]?.slice(0, 2)).toEqual([WS_ID, "/work/out/report.md"]);
  });
});

describe("task list pages (#113)", () => {
  // A page position lives in the history entry; each case starts from a clean one.
  beforeEach(() => window.history.replaceState(null, ""));
  /** 60 tasks: 52 planned, 6 blocked, 2 accepted; the Gateway filters, searches and pages. */
  function paged() {
    const all = Array.from({ length: 60 }, (_, i) =>
      task({
        id: `task_${String(i).padStart(2, "0")}`,
        title: `Task ${String(i).padStart(2, "0")}`,
        status: i < 6 ? "blocked" : i < 8 ? "accepted" : "planned",
        ...(i < 6 ? { blockedReason: "waiting", nextAction: "ask" } : {}),
      }),
    );
    const late = new Map<string, ReturnType<typeof deferred<TaskListPage>>>();
    const api = createApiClient({
      fetch: fakeFetch({ "GET /api/workspaces": { workspaces: [workspace] } }).fetch,
    });
    vi.spyOn(api, "listBots").mockResolvedValue([bot]);
    const list = vi.spyOn(api, "listTasks").mockImplementation(async (_ws, filters = {}) => {
      const rows = all.filter(
        (item) =>
          (!filters.status || item.status === filters.status) &&
          (!filters.q || item.title.includes(filters.q)),
      );
      const offset = filters.offset ?? 0;
      const page = listPage(rows.slice(offset, offset + 25), offset, rows.length);
      // The counts are the workspace's, never the page's.
      page.statusCounts = listPage(all).statusCounts;
      const hold = late.get(filters.status ?? "all");
      if (hold) {
        await hold.promise;
      }
      return page;
    });
    return { api, list, late };
  }

  const range = () => screen.getByRole("navigation", { name: "Task pages" });

  it("pages more than two pages and keeps the compact aggregate count", async () => {
    const { api, list } = paged();
    render(<TasksScreen api={api} />);
    await waitFor(() => expect(range()).toHaveTextContent("1–25 of 60"));
    expect(screen.getByText("60 tasks")).toBeVisible();
    fireEvent.click(within(range()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(range()).toHaveTextContent("26–50 of 60"));
    fireEvent.click(within(range()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(range()).toHaveTextContent("51–60 of 60"));
    expect(within(range()).getByRole("button", { name: "Next" })).toBeDisabled();
    expect(list).toHaveBeenLastCalledWith(WS_ID, { offset: 50, limit: 25 });
    // Back and Forward step between pages.
    act(() => window.history.back());
    await waitFor(() => expect(range()).toHaveTextContent("26–50 of 60"));
    act(() => window.history.forward());
    await waitFor(() => expect(range()).toHaveTextContent("51–60 of 60"));
    expect(screen.getByText("60 tasks")).toBeVisible();
  });

  it("retains list search and status when opening a task and returning", async () => {
    const { api, list } = paged();
    vi.spyOn(api, "getTask").mockResolvedValue(task());
    const view = render(<TasksScreen api={api} />);
    await screen.findByText("60 tasks");
    await selectOption("Filter by status", "Blocked");
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "Task 03" } });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(WS_ID, {
        status: "blocked",
        q: "Task 03",
        offset: 0,
        limit: 25,
      }),
    );
    view.rerender(<TasksScreen api={api} taskId={task().id} />);
    await screen.findByRole("link", { name: "Back to tasks" });
    expect(screen.getByLabelText("Search tasks")).toHaveValue("Task 03");
    view.rerender(<TasksScreen api={api} />);
    await screen.findByText("1 of 60 tasks");
    expect(screen.getByLabelText("Search tasks")).toHaveValue("Task 03");
    expect(list).toHaveBeenLastCalledWith(WS_ID, {
      status: "blocked",
      q: "Task 03",
      offset: 0,
      limit: 25,
    });
  });

  it("filters on the Gateway from the first page and drops a late answer for the old filter", async () => {
    const { api, list, late } = paged();
    render(<TasksScreen api={api} />);
    await waitFor(() => expect(range()).toHaveTextContent("1–25 of 60"));
    fireEvent.click(within(range()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(range()).toHaveTextContent("26–50 of 60"));
    // Hold the next unfiltered answer; it lands after the filter changed and must be ignored.
    const held = deferred<TaskListPage>();
    late.set("all", held);
    fireEvent.click(screen.getByRole("button", { name: "Refresh task list" }));
    late.delete("all");
    await selectOption("Filter by status", "Blocked");
    await screen.findByText("6 of 60 tasks");
    expect(screen.queryByRole("navigation", { name: "Task pages" })).not.toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(WS_ID, { status: "blocked", offset: 0, limit: 25 });
    expect(screen.getByText("6 of 60 tasks")).toBeVisible();
    await act(async () => held.resolve(listPage([])));
    expect(screen.queryByRole("navigation", { name: "Task pages" })).not.toBeInTheDocument();
    // Search goes to the Gateway after typing settles.
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "Task 03" } });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(WS_ID, {
        status: "blocked",
        q: "Task 03",
        offset: 0,
        limit: 25,
      }),
    );
    await screen.findByText("1 of 60 tasks");
    expect(screen.queryByRole("navigation", { name: "Task pages" })).not.toBeInTheDocument();
  });
});

describe("task recovery acceptance", () => {
  it("retries a transient detail failure without claiming the task was deleted", async () => {
    const { api } = setup();
    const get = vi
      .spyOn(api, "getTask")
      .mockRejectedValueOnce(new Error("Temporary task read failure"));
    render(<TasksScreen api={api} taskId="task_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary task read failure");
    expect(screen.queryByTestId("deleted-object")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Retry loading tasks$/ }));
    await ready();
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves a failed create draft and retries with the same request identity", async () => {
    const { api } = setup();
    const create = vi.spyOn(api, "createTask").mockRejectedValueOnce(new Error("Response lost"));
    render(<TasksScreen api={api} taskId="new" />);
    await ready();
    fill("Goal", "Keep this goal");
    fill("Details and success criteria", "Keep the success criteria too");
    fireEvent.click(screen.getByRole("button", { name: /^Create task$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
    expect(screen.getByLabelText("Goal")).toHaveValue("Keep this goal");
    expect(screen.getByLabelText("Details and success criteria")).toHaveValue(
      "Keep the success criteria too",
    );
    fireEvent.click(screen.getByRole("button", { name: /^Create task$/ }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/task_1"));
  });
});

it("retries unavailable related items without resetting a new task draft", async () => {
  const { api } = setup();
  const threads = vi.spyOn(api, "listThreads").mockRejectedValueOnce(new Error("Unavailable"));
  const create = vi.spyOn(api, "createTask");
  render(<TasksScreen api={api} taskId="new" />);
  await ready();
  fill("Goal", "Preserved goal");
  fill("Details and success criteria", "Preserved criteria");
  openAdvanced();
  expect(screen.getByRole("alert")).toHaveTextContent("Could not load: Related chats");
  expect(screen.getByRole("checkbox", { name: /^waiting to start/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry related items" }));
  expect(await screen.findByRole("checkbox", { name: /^Morning check chat/ })).toBeInTheDocument();
  expect(screen.getByLabelText("Goal")).toHaveValue("Preserved goal");
  expect(screen.getByLabelText("Details and success criteria")).toHaveValue("Preserved criteria");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(threads).toHaveBeenCalledTimes(2);
  expect(create).not.toHaveBeenCalled();
});
