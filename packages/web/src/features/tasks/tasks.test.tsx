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
  task,
  workspace,
} from "../../test-support/fixtures.js";
import type { RecordedCall } from "../../test-support/fixtures.js";
import { TasksScreen, acceptedByLabel, deliveredByLabel, taskReferenceIds } from "./tasks.js";

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
    [`GET ${base}${firstPage}`]: () => listPage([saved]),
    [`GET ${base}/${initial.id}`]: () => ({ task: saved }),
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
  await screen.findByLabelText("Title");
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
    const output = { note: "<img src=x onerror=alert(1)>", rows: [1, 2] };
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
    expect(
      screen.getByText(new RegExp(`bot:${BOT_ID} \\(bot, through task_deliver\\)`)),
    ).toBeVisible();
    const shownOutput = screen.getByRole("region", { name: "Delivered output" });
    expect(within(shownOutput).getByText(/onerror/).textContent).toBe(
      JSON.stringify(output, null, 2),
    );
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

describe("task reference links", () => {
  it("accepts copied links and raw IDs, deduplicates, and leaves malformed values for validation", () => {
    expect(
      taskReferenceIds("thr_1\n#/threads/thr_1 https://console.example/#/threads/thr_2", "threads"),
    ).toEqual(["thr_1", "thr_2"]);
    expect(taskReferenceIds("#/runs/run_1\nrun_2,run_3", "runs")).toEqual([
      "run_1",
      "run_2",
      "run_3",
    ]);
    expect(taskReferenceIds("#/runs/%bad", "runs")).toEqual(["#/runs/%bad"]);
  });
});

describe("operator task management", () => {
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
        roles={{ tenantRole: "member", platformMaintainer: false }}
        actorId="user:usr_self"
        displayName="Demo operator"
      >
        <TasksScreen api={api} taskId="task_1" />
      </SessionRolesProvider>,
    );
    await ready();
    expect(screen.getAllByText(/Demo operator/)).toHaveLength(2);
    for (const label of screen.getAllByText("user:usr_self"))
      expect(label.closest("details")).not.toBeNull();
  });

  it("creates a task with owner, links and artifacts, submitted immediately by default", async () => {
    const { api, calls } = setup();
    render(<TasksScreen api={api} />);
    await ready();
    expect(screen.getByText(/Operator-maintained tracking/)).toBeVisible();
    fill("Title", "Weekly findings");
    fill("Description", "Review the sources");
    await selectOption("Owner bot", "ops");
    fill("Conversation IDs", `#/threads/${THREAD_ID}\n${THREAD_ID}`);
    fill("Run IDs", `https://console.example/#/runs/${RUN_ID}`);
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));
    fill("Artifact 1 label", "Draft report");
    fill("Artifact 1 path", "/work/report.md");
    fill("Artifact 1 run ID (optional)", RUN_ID);
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
    expect(screen.getByRole("link", { name: `Open conversation · ${THREAD_ID}` })).toHaveAttribute(
      "href",
      `#/threads/${THREAD_ID}`,
    );
    expect(screen.getByRole("link", { name: `Open run · ${RUN_ID}` })).toHaveAttribute(
      "href",
      `#/runs/${RUN_ID}`,
    );
    expect(screen.getByRole("link", { name: `Artifact run · ${RUN_ID}` })).toHaveAttribute(
      "href",
      `#/runs/${RUN_ID}`,
    );
    expect(screen.getByRole("button", { name: "Preview file" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Download /work/report.md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept delivery" })).not.toBeInTheDocument();
  });

  it("edits owner/status, enforces blocker and next action, and shows blockers in the list", async () => {
    const { api, current } = setup();
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
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
    await selectOption("Status", "Delivered · awaiting acceptance");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Add at least one artifact before marking this task delivered.");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));
    fill("Artifact 1 label", "Report");
    fill("Artifact 1 path", "/work/report.md");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Accept delivery" });
    expect(current()).toMatchObject({ status: "delivered", version: 2, acceptedAt: null });
    expect(calls.some((call) => call.path.endsWith("/accept"))).toBe(false);
    fill("Description", "Unsaved description");
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
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
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
      expect(screen.getByLabelText("Title")).toBeDisabled();
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
      expect(screen.getByLabelText("Title")).toBeEnabled();
    },
  );

  it("refuses unsupported artifact paths without making a mutation", async () => {
    const { api } = setup();
    const create = vi.spyOn(api, "createTask");
    render(<TasksScreen api={api} />);
    await ready();
    fill("Title", "Report");
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));
    fill("Artifact 1 label", "File");
    fill("Artifact 1 path", "/work/../profile/Cookies");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText(/Each artifact needs a label and a valid/);
    expect(create).not.toHaveBeenCalled();
  });

  it("retains unsaved text after a version conflict and requires explicit reload", async () => {
    const { api } = setup();
    const update = vi
      .spyOn(api, "updateTask")
      .mockRejectedValueOnce(new ApiError("invalid_transition", "Task changed", 409));
    const get = vi.spyOn(api, "getTask");
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fill("Title", "My unsaved report title");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Your unsaved draft is still here/);
    expect(screen.getByLabelText("Title")).toHaveValue("My unsaved report title");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValueOnce(task({ title: "Their saved title", version: 7 }));
    fireEvent.click(screen.getByRole("button", { name: "Reload and discard draft" }));
    await screen.findByText("Latest task loaded.");
    expect(screen.getByLabelText("Title")).toHaveValue("Their saved title");
    fill("Title", "Reconciled title");
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
    expect(screen.getByRole("button", { name: "Reload latest task" })).toBeEnabled();
  });

  it("refreshes the list and owner choices without replacing an unsaved detail draft", async () => {
    const { api } = setup();
    const list = vi.spyOn(api, "listTasks");
    const owners = vi.spyOn(api, "listBots");
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fill("Title", "Local draft");
    list.mockResolvedValueOnce(listPage([task({ title: "New server title", version: 2 })]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh task list" }));
    await screen.findByText("New server title");
    expect(screen.getByLabelText("Title")).toHaveValue("Local draft");
    expect(owners).toHaveBeenCalledTimes(2);
    expect(owners).toHaveBeenLastCalledWith(WS_ID);
  });

  it("does not duplicate submissions even before disabled controls repaint", async () => {
    const { api } = setup();
    const pending = deferred<Task>();
    const create = vi.spyOn(api, "createTask").mockReturnValue(pending.promise);
    render(<TasksScreen api={api} />);
    await ready();
    fill("Title", "New report");
    await selectOption("When it runs", "Manual");
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
    expect(screen.getByRole("alert")).toHaveTextContent(
      `no route GET /api/workspaces/${ws2}/tasks/task_1`,
    );
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "#/tasks");
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
      expect(screen.getByLabelText("Title")).toHaveValue("Second task");
      await act(async () => {
        if (outcome === "resolve") old.resolve(task());
        else old.reject(new Error("Old task failed"));
      });
      expect(screen.getByLabelText("Title")).toHaveValue("Second task");
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
      fill("Title", "Saving first task");
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      view.rerender(<TasksScreen api={api} taskId="task_2" />);
      await ready();
      await act(async () => {
        if (outcome === "resolve") old.resolve(task({ title: "Saved first task" }));
        else old.reject(new ApiError("invalid_transition", "Old save conflict", 409));
      });
      expect(screen.getByLabelText("Title")).toHaveValue("Second task");
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
        <TasksScreen api={api} />
      </WorkspaceScopeProvider>,
    );
    await ready();
    fill("Title", "Old workspace task");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
    await screen.findByText("Other team");
    await ready();
    await act(async () => pending.resolve(task({ title: "Old workspace task" })));
    expect(screen.getByLabelText("Title")).toHaveValue("");
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
    fill("Title", "Latest saved title");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Task saved.");
    await act(async () => pending.resolve(listPage([task()])));
    expect(
      within(screen.getByRole("complementary", { name: "Workspace tasks" })).getByText(
        "Latest saved title",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Title")).toHaveValue("Latest saved title");
  });
});

describe("task triggers and execution (ADR-0021 amendment 3)", () => {
  it("defaults to Immediately, needs an owner for it, and sends a schedule only when Scheduled", async () => {
    const { api } = setup();
    const create = vi.spyOn(api, "createTask").mockResolvedValue(task({ title: "Later" }));
    render(<TasksScreen api={api} />);
    await ready();
    fill("Title", "Later");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText(/Choose a responsible bot/)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    await selectOption("Owner bot", "ops");
    await selectOption("When it runs", "Scheduled");
    await selectOption("Schedule", "Repeating (cron)");
    fill("Cron expression (minute hour day month weekday)", "0 9 * * 1");
    fill("Time zone", "Asia/Shanghai");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      title: "Later",
      trigger: "scheduled",
      schedule: { kind: "repeat", cron: "0 9 * * 1", timeZone: "Asia/Shanghai" },
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
            threadId: null,
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
      await screen.findByText(/A linked run is active while the task is still Planned/),
    ).toBeVisible();
    expect(screen.getByText(/The latest delivery is partial: 1 item/)).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByText(/1 approval\(s\) waiting/)).toBeVisible();
    expect(screen.getByText(/Next occurrence/)).toBeVisible();
    expect(runTask).not.toHaveBeenCalled();
    fill("Next action", "Edited without rerunning");
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runTask).toHaveBeenCalledOnce());
    expect(runTask.mock.calls[0]?.slice(1, 3)).toEqual(["task_1", 1]);
    expect(String(runTask.mock.calls[0]?.[3])).toMatch(/^web-/);
  });

  it("deletes only after confirmation", async () => {
    const { api } = setup(task({ ownerBotId: BOT_ID }));
    const remove = vi.spyOn(api, "deleteTask").mockResolvedValue();
    render(<TasksScreen api={api} taskId="task_1" />);
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Delete task" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/history, chats and published files are kept/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(WS_ID, "task_1", 1));
    expect(await screen.findByText("Task deleted.")).toBeVisible();
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

  const metric = (label: string) =>
    screen
      .getAllByText(label)
      .map((node) => node.closest(".task-metric-card"))
      .find(Boolean);
  const range = () => screen.getByRole("navigation", { name: "Task pages" });

  it("pages more than two pages and counts the cards from the Gateway's aggregate", async () => {
    const { api, list } = paged();
    render(<TasksScreen api={api} />);
    await waitFor(() => expect(range()).toHaveTextContent("1–25 of 60"));
    expect(metric("Open tasks")).toHaveTextContent("58");
    expect(metric("Needs attention")).toHaveTextContent("6");
    expect(metric("Accepted")).toHaveTextContent("2");
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
    // The cards did not move with the page.
    expect(metric("Open tasks")).toHaveTextContent("58");
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
    await waitFor(() => expect(range()).toHaveTextContent("1–6 of 6"));
    expect(list).toHaveBeenLastCalledWith(WS_ID, { status: "blocked", offset: 0, limit: 25 });
    expect(screen.getByText("6 of 60 tasks")).toBeVisible();
    await act(async () => held.resolve(listPage([])));
    expect(range()).toHaveTextContent("1–6 of 6");
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
    await waitFor(() => expect(range()).toHaveTextContent("1–1 of 1"));
  });
});
