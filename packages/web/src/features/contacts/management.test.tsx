// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { ManagementScreen } from "./management.js";

afterEach(cleanup);

const workspace = {
  id: "ws_1",
  name: "Operations",
  sandboxProvider: "docker",
  status: "running",
  egressAllowlist: [],
  createdAt: "2026-09-23T00:00:00.000Z",
};
const bot = {
  id: "bot_1",
  workspaceId: "ws_1",
  name: "triage",
  role: "Support",
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-09-23T00:00:00.000Z",
};

it("requires the exact archived name before permanent deletion", async () => {
  const archived = { ...workspace, archivedAt: "2026-10-11T00:00:00.000Z" };
  const deletes: Array<{ path: string; body: unknown }> = [];
  let deleted = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "default-model", cheapModel: "cheap-default" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [] });
    if (path === "/api/bots") return Response.json({ bots: [] });
    if (path === "/api/trash")
      return Response.json({ workspaces: deleted ? [] : [archived], bots: [] });
    if (path === "/api/workspaces/ws_1" && init?.method === "DELETE") {
      deletes.push({ path, body: JSON.parse(String(init.body)) });
      deleted = true;
      return Response.json({ deleted: true });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  const name = await screen.findByLabelText("Type Operations to confirm permanent deletion");
  const remove = screen.getByRole("button", { name: "Delete permanently" });
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "Operation" } });
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "Operations" } });
  expect((remove as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(remove);
  await waitFor(() =>
    expect(deletes).toEqual([{ path: "/api/workspaces/ws_1", body: { name: "Operations" } }]),
  );
});

it("creates another workspace and bot when the registry is already populated", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const requestBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") requests.push({ path, body: requestBody });
    if (path === "/api/config")
      return Response.json({ defaultModel: "default-model", cheapModel: "cheap-default" });
    if (path === "/api/workspaces" && init?.method === "POST")
      return Response.json({
        workspace: { ...workspace, id: "ws_2", name: requestBody.name },
      });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/bots" && init?.method === "POST")
      return Response.json({ bot: { ...bot, id: "bot_2", ...requestBody } });
    if (path.endsWith("/soul"))
      return Response.json({ soul: { body: "Be useful.", version: "1" } });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    return Response.json({ bots: [bot] });
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  await screen.findByText("triage");
  fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Research" } });
  fireEvent.change(screen.getByLabelText("Allowed domains"), {
    target: { value: "docs.example.com, api.example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  await screen.findByText("Workspace created.");

  fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "analyst" } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Researcher" } });
  const createModel = screen.getAllByLabelText("Model override")[0];
  if (!createModel) throw new Error("Create bot model input was not rendered");
  fireEvent.change(createModel, {
    target: { value: "vendor/custom-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await screen.findByText("Bot created.");

  expect(requests).toContainEqual({
    path: "/api/workspaces",
    body: {
      name: "Research",
      egressAllowlist: ["docs.example.com", "api.example.com"],
    },
  });
  expect(requests).toContainEqual({
    path: "/api/bots",
    body: {
      name: "analyst",
      role: "Researcher",
      workspaceId: "ws_2",
      model: "vendor/custom-model",
    },
  });
});

it("shows effective defaults and clears overrides with null", async () => {
  const patches: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/bots" && init?.method !== "PATCH")
      return Response.json({ bots: [{ ...bot, model: "old/main", cheapModel: "old/cheap" }] });
    if (path.endsWith("/soul"))
      return Response.json({ soul: { body: "Be useful.", version: "1" } });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    const patch = JSON.parse(String(init?.body));
    patches.push(patch);
    return Response.json({ bot: { ...bot, model: patch.model, cheapModel: undefined } });
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  const card = (await screen.findByText("triage")).closest("article");
  expect(card).not.toBeNull();
  const editor = within(card as HTMLElement);
  expect(editor.getByText(/Operations/)).toBeTruthy();
  expect(editor.getByText(/Effective model:/).textContent).toContain("old/main");
  fireEvent.change(editor.getByLabelText("Model"), { target: { value: "custom" } });
  fireEvent.change(editor.getByLabelText("Model override"), {
    target: { value: "provider/free-form" },
  });
  fireEvent.change(editor.getByLabelText("Cheap model override"), { target: { value: "" } });
  fireEvent.click(editor.getByRole("button", { name: "Save model settings" }));

  await editor.findByText("Model settings saved.");
  expect(patches).toEqual([{ model: "provider/free-form", cheapModel: null }]);
  await waitFor(() =>
    expect(editor.getByText(/Effective cheap model:/).textContent).toContain("deploy/cheap"),
  );
});

it("requires inline confirmation before removing an egress domain", async () => {
  const patched: unknown[] = [];
  const withEgress = { ...workspace, egressAllowlist: ["keep.example.com", "remove.example.com"] };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces" && init?.method !== "PATCH")
      return Response.json({ workspaces: [withEgress] });
    if (path === "/api/workspaces/ws_1" && init?.method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      patched.push(body);
      return Response.json({ workspace: { ...withEgress, egressAllowlist: body.egressAllowlist } });
    }
    if (path === "/api/bots") return Response.json({ bots: [] });
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  const operations = (
    await screen.findByRole("heading", { level: 3, name: /^Operations/ })
  ).closest("article") as HTMLElement;
  const input = within(operations).getByRole("textbox");
  fireEvent.change(input, { target: { value: "keep.example.com\nnew.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save egress allowlist" }));

  expect(patched).toEqual([]);
  expect(screen.getByText(/Remove remove\.example\.com/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm egress removal" }));
  await screen.findByText("Egress allowlist saved.");
  expect(patched).toEqual([{ egressAllowlist: ["keep.example.com", "new.example.com"] }]);
});

it("marks a workspace as open internet exactly when its allowlist is ['*'] (ADR-0010)", async () => {
  const patched: unknown[] = [];
  const restricted = { ...workspace, egressAllowlist: ["docs.example.com"] };
  const open = { ...workspace, id: "ws_2", name: "Trial", egressAllowlist: ["*"] };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces" && init?.method !== "PATCH")
      return Response.json({ workspaces: [restricted, open] });
    if (path === "/api/workspaces/ws_1" && init?.method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      patched.push(body);
      return Response.json({ workspace: { ...restricted, egressAllowlist: body.egressAllowlist } });
    }
    if (path === "/api/bots") return Response.json({ bots: [] });
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  const operations = (
    await screen.findByRole("heading", { level: 3, name: /^Operations/ })
  ).closest("article") as HTMLElement;
  const trial = screen
    .getByRole("heading", { level: 3, name: /^Trial/ })
    .closest("article") as HTMLElement;
  expect(within(trial).getByText("Open internet")).toBeTruthy();
  expect(within(operations).queryByText("Open internet")).toBeNull();

  // The operator opens a restricted workspace by choosing the open-internet mode, which saves
  // the lone `*`; the badge follows the saved list, not the draft.
  fireEvent.click(within(operations).getByLabelText(/Open public internet/));
  expect(within(operations).queryByText("Open internet")).toBeNull();
  fireEvent.click(within(operations).getByRole("button", { name: "Save egress allowlist" }));
  fireEvent.click(within(operations).getByRole("button", { name: "Confirm egress removal" }));
  await within(operations).findByText("Egress allowlist saved.");
  expect(patched).toEqual([{ egressAllowlist: ["*"] }]);
  expect(within(operations).getByText("Open internet")).toBeTruthy();
});

it("creates rules and requires inline confirmation before deleting one", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const existing = {
    id: "rul_1",
    botId: bot.id,
    matcher: { toolName: "Bash", argumentPattern: "git push*" },
    decision: "deny",
    createdBy: "human:web",
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  let stored = [existing];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") requests.push({ method, path, body });
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/bots") return Response.json({ bots: [bot] });
    if (path.endsWith("/soul"))
      return Response.json({ soul: { body: "Be useful.", version: "1" } });
    // The rules page is read again after each change (#113 slice B), so the fake keeps state.
    if (path.startsWith("/api/bots/bot_1/approval-rules?") && method === "GET")
      return Response.json({ rules: stored, offset: 0, limit: 25, total: stored.length });
    if (path === "/api/bots/bot_1/approval-rules" && method === "POST") {
      const rule = { ...existing, id: "rul_2", matcher: body.matcher, decision: body.decision };
      stored = [...stored, rule];
      return Response.json({ rule }, { status: 201 });
    }
    if (path === "/api/approval-rules/rul_1" && method === "DELETE") {
      stored = stored.filter((rule) => rule.id !== "rul_1");
      return Response.json({ deleted: true });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  await screen.findByText(/git push/);
  const rules = screen.getByLabelText("Approval rules for triage");
  fireEvent.click(within(rules).getByRole("button", { name: "Remove rule" }));
  expect(requests).toEqual([]);
  fireEvent.click(within(rules).getByRole("button", { name: "Confirm rule removal" }));
  await waitFor(() => expect(screen.queryByText(/git push/)).toBeNull());

  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "browser_click" } });
  fireEvent.change(screen.getByLabelText("Target origin"), {
    target: { value: "https://shop.example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await screen.findByText(/on https:\/\/shop\.example\.com/);
  expect(requests).toContainEqual({
    method: "DELETE",
    path: "/api/approval-rules/rul_1",
    body: undefined,
  });
  expect(requests).toContainEqual({
    method: "POST",
    path: "/api/bots/bot_1/approval-rules",
    body: {
      matcher: { toolName: "browser_click", targetOrigin: "https://shop.example.com" },
      decision: "allow_always",
    },
  });
});

it("preserves a dirty SOUL draft through a version conflict", async () => {
  const writes: unknown[] = [];
  let soulReads = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/bots") return Response.json({ bots: [bot] });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    if (path === "/api/bots/bot_1/soul" && method === "GET") {
      soulReads += 1;
      return Response.json({
        soul:
          soulReads === 1 ? { body: "Original", version: "1" } : { body: "Remote", version: "2" },
      });
    }
    if (path === "/api/bots/bot_1/soul" && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      if (writes.length === 1) {
        return Response.json(
          { code: "invalid_transition", message: "version conflict", details: {} },
          { status: 409 },
        );
      }
      return Response.json({ soul: { body: body.body, version: "3" } });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);

  const editor = await screen.findByLabelText("SOUL.md for triage");
  fireEvent.change(editor, { target: { value: "My local draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save SOUL.md" }));

  await screen.findByText("Remote");
  expect((editor as HTMLTextAreaElement).value).toBe("My local draft");
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and use latest as base" }));
  fireEvent.click(screen.getByRole("button", { name: "Save SOUL.md" }));
  await screen.findByText(/SOUL\.md saved/);
  expect(writes).toEqual([
    { body: "My local draft", expectedVersion: "1" },
    { body: "My local draft", expectedVersion: "2" },
  ]);
});

it.each([
  "Finish or cancel this bot's parked run before editing SOUL",
  "Wait for this bot's current run before editing SOUL",
])(
  "shows the actual SOUL save refusal when its saved version is unchanged: %s",
  async (message) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/config")
        return Response.json({ defaultModel: "main", cheapModel: "cheap" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
      if (path === "/api/bots") return Response.json({ bots: [bot] });
      if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
      if (path.endsWith("/soul")) {
        if (init?.method === "PATCH")
          return Response.json(
            { code: "invalid_transition", message, details: {} },
            { status: 409 },
          );
        return Response.json({ soul: { body: "Original", version: "1" } });
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);
    const editor = await screen.findByLabelText("SOUL.md for triage");
    fireEvent.change(editor, { target: { value: "Keep my local instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SOUL.md" }));
    await screen.findByText(message);
    expect((editor as HTMLTextAreaElement).value).toBe("Keep my local instructions");
    expect(screen.queryByText(/SOUL.md changed since it was loaded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep draft and use latest as base" })).toBeNull();
  },
);

it("retains a dirty SOUL draft across in-app unmount and remount for the same session", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/bots") return Response.json({ bots: [bot] });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    if (path.endsWith("/soul")) return Response.json({ soul: { body: "Original", version: "1" } });
    throw new Error(`unexpected ${path}`);
  });
  const api = createApiClient({ fetch: fetcher });
  const first = render(<ManagementScreen api={api} />);
  const editor = await screen.findByLabelText("SOUL.md for triage");
  fireEvent.change(editor, { target: { value: "Retained draft" } });
  first.unmount();

  render(<ManagementScreen api={api} />);
  await waitFor(() =>
    expect((screen.getByLabelText("SOUL.md for triage") as HTMLTextAreaElement).value).toBe(
      "Retained draft",
    ),
  );
});

it("shows instruction readiness and opens a one-bot test conversation", async () => {
  const requests: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "main", cheapModel: "cheap", cronTimeZone: "UTC" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/bots") return Response.json({ bots: [bot] });
    if (path.endsWith("/soul")) return Response.json({ soul: { body: "", version: "1" } });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    if (path === "/api/threads" && init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ thread: { id: "thr_test" }, members: [] });
    }
    throw new Error(`unexpected ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);
  await screen.findByText(/Needs instructions/);
  expect(screen.getAllByText(/Role is a display description/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Start test conversation" }));
  await waitFor(() =>
    expect(requests).toEqual([
      { workspaceId: bot.workspaceId, botIds: [bot.id], title: "Test triage" },
    ]),
  );
  expect(window.location.hash).toBe("#/threads/thr_test");
});

it("shows the workspace restoration requirement without offering automatic certificate trust", async () => {
  const warning = {
    ...workspace,
    restorationRequirements: [
      {
        code: "volatile_nss_database",
        path: "/root/.pki/nssdb",
        sourceProviderRef: "previous-exact-runtime",
        status: "restoration_required",
      },
    ],
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/config")
      return Response.json({ defaultModel: "default-model", cheapModel: "cheap-default" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [warning] });
    if (path === "/api/bots") return Response.json({ bots: [] });
    if (path === "/api/trash") return Response.json({ workspaces: [], bots: [] });
    if (path.startsWith("/api/approval-rules")) return Response.json({ rules: [] });
    if (path.startsWith("/api/connectors")) return Response.json({ connectors: [] });
    throw new Error(`unexpected GET ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);
  expect(await screen.findByText("Temporary access restoration")).toBeTruthy();
  expect(screen.getByText(/Changed peers or expired grants need new authorization/)).toBeTruthy();
  expect(screen.getByText("/root/.pki/nssdb")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /trust|restore certificate/i })).toBeNull();
});

it("edits an approval rule in place (ADR-0043 decision 6)", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let stored = {
    id: "rul_1",
    botId: bot.id,
    matcher: { toolName: "Bash", argumentPattern: "git push*" },
    decision: "deny",
    createdBy: "human:web",
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") requests.push({ method, path, body });
    if (path === "/api/config")
      return Response.json({ defaultModel: "deploy/main", cheapModel: "deploy/cheap" });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path.startsWith("/api/bots?") || path === "/api/bots")
      return Response.json({ bots: [bot] });
    if (path.endsWith("/soul"))
      return Response.json({ soul: { body: "Be useful.", version: "1" } });
    if (path.endsWith("/rule-versions/soul")) return Response.json({ file: "soul", versions: [] });
    if (path.startsWith("/api/bots/bot_1/approval-rules?") && method === "GET")
      return Response.json({ rules: [stored], offset: 0, limit: 25, total: 1 });
    if (path === "/api/approval-rules/rul_1" && method === "PATCH") {
      stored = { ...stored, ...body };
      return Response.json({ rule: stored });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(<ManagementScreen api={createApiClient({ fetch: fetcher })} />);
  await screen.findByText(/git push/);
  const rules = screen.getByLabelText("Approval rules for triage");
  fireEvent.click(within(rules).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(rules).getByLabelText("Argument pattern"), {
    target: { value: "git push --force*" },
  });
  fireEvent.click(within(rules).getByRole("button", { name: "Save rule" }));
  await screen.findByText(/git push --force/);
  expect(requests).toEqual([
    {
      method: "PATCH",
      path: "/api/approval-rules/rul_1",
      body: {
        decision: "deny",
        matcher: { toolName: "Bash", argumentPattern: "git push --force*" },
      },
    },
  ]);
});
