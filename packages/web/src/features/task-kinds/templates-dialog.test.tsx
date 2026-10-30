// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { type RecordedCall, WS_ID, fakeFetch } from "../../test-support/fixtures.js";
import { TaskTemplatesDialog } from "./templates-dialog.js";

afterEach(cleanup);

it("loads templates on demand and discards the editor when closed", async () => {
  const wire = fakeFetch({
    [`GET /api/workspaces/${WS_ID}/task-templates`]: { templates: [] },
  });
  render(<TaskTemplatesDialog api={createApiClient({ fetch: wire.fetch })} workspaceId={WS_ID} />);
  expect(wire.calls).toHaveLength(0);
  const trigger = screen.getByRole("button", { name: "Templates" });
  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog", { name: "Templates" })).toBeInTheDocument();
  await waitFor(() => expect(wire.calls).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved draft" } });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  fireEvent.click(trigger);
  expect(screen.queryByRole("form", { name: "New template" })).not.toBeInTheDocument();
  expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
});

it("lets Members read but not edit and hides the entry from Guests", async () => {
  const wire = fakeFetch({
    [`GET /api/workspaces/${WS_ID}/task-templates`]: { templates: [] },
  });
  const api = createApiClient({ fetch: wire.fetch });
  const view = (role: "member" | "guest") => (
    <SessionRolesProvider
      roles={{ platformMaintainer: false, tenantRole: role, workspaceRoles: { [WS_ID]: role } }}
    >
      <TaskTemplatesDialog api={api} workspaceId={WS_ID} />
    </SessionRolesProvider>
  );
  const { rerender } = render(view("member"));
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New template" })).not.toBeInTheDocument();
  rerender(view("guest"));
  expect(screen.queryByRole("button", { name: "Templates" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("names its close control, keeps it out of the scrolling body and has one heading (#63)", async () => {
  const wire = fakeFetch({
    [`GET /api/workspaces/${WS_ID}/task-templates`]: { templates: [] },
  });
  render(<TaskTemplatesDialog api={createApiClient({ fetch: wire.fetch })} workspaceId={WS_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  const dialog = await screen.findByRole("dialog", { name: "Templates" });
  const close = within(dialog).getByRole("button", { name: "Close templates" });
  const body = within(dialog).getByRole("region", { name: "Task templates" }).parentElement;
  expect(body).toHaveClass("overflow-y-auto");
  expect(body?.contains(close)).toBe(false);
  expect(dialog).not.toHaveClass("overflow-y-auto");
  expect(within(dialog).getAllByRole("heading", { name: "Templates" })).toHaveLength(1);
});

it("clears a failed load once a later load succeeds and reports the change (#63)", async () => {
  let fail = true;
  const onChanged = vi.fn();
  const wire = fakeFetch({
    [`GET /api/workspaces/${WS_ID}/task-templates`]: () =>
      fail ? new Error("templates unavailable") : { templates: [] },
    [`POST /api/workspaces/${WS_ID}/task-templates`]: (call: RecordedCall) => ({
      template: { ...(call.body as object), id: "ttpl_1" },
    }),
  });
  render(
    <TaskTemplatesDialog
      api={createApiClient({ fetch: wire.fetch })}
      workspaceId={WS_ID}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("templates unavailable");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  const form = screen.getByRole("form", { name: "New template" });
  fireEvent.change(within(form).getByLabelText("Kind key"), { target: { value: "check" } });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Check" } });
  fireEvent.change(within(form).getByLabelText("Stages and done criteria"), {
    target: { value: "check | Check\n- Done" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Create template" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("retries a failed read without losing an open template draft", async () => {
  let fail = true;
  const wire = fakeFetch({
    [`GET /api/workspaces/${WS_ID}/task-templates`]: () =>
      fail ? new Error("templates unavailable") : { templates: [] },
  });
  render(<TaskTemplatesDialog api={createApiClient({ fetch: wire.fetch })} workspaceId={WS_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("templates unavailable");
  expect(screen.queryByText("No templates yet.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep this draft" } });
  expect(document.querySelector(".task-template-list")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Kind key")).toHaveFocus();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByLabelText("Name")).toHaveValue("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
  expect(screen.getByRole("button", { name: "New template" })).toHaveFocus();
  expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
});

it("closes an editor when workspace management permission is removed", async () => {
  const wire = fakeFetch({ [`GET /api/workspaces/${WS_ID}/task-templates`]: { templates: [] } });
  const api = createApiClient({ fetch: wire.fetch });
  const view = (role: "owner" | "member") => (
    <SessionRolesProvider
      roles={{ platformMaintainer: false, tenantRole: "owner", workspaceRoles: { [WS_ID]: role } }}
    >
      <TaskTemplatesDialog api={api} workspaceId={WS_ID} />
    </SessionRolesProvider>
  );
  const { rerender } = render(view("owner"));
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  fireEvent.click(await screen.findByRole("button", { name: "New template" }));
  expect(screen.getByRole("form", { name: "New template" })).toBeInTheDocument();
  rerender(view("member"));
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New template" })).not.toBeInTheDocument();
  expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
});
