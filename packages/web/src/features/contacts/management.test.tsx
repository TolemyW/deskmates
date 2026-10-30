// @vitest-environment jsdom
// The bot settings editor on a bot's profile (`BotEditor`): model overrides, approval rules, SOUL
// drafts and the test conversation. Rendered on its own it shows every section, as the tune view
// does (docs/use-and-tune-views.md).
import type { BotDefinition, OperatorConfig } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../../api/client.js";
import { InterfaceViewProvider } from "../../lib/interface-view.js";
import { BotEditor } from "./management.js";

afterEach(cleanup);

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
} as unknown as BotDefinition;

const CONFIG = {
  defaultModel: "deploy/main",
  cheapModel: "deploy/cheap",
  cronTimeZone: "UTC",
} as unknown as OperatorConfig;

function editor(api: ApiClient, shown: BotDefinition = bot, config: OperatorConfig = CONFIG) {
  return (
    <BotEditor
      api={api}
      bot={shown}
      config={config}
      timeZone="UTC"
      workspaceName="Operations"
      onSaved={() => undefined}
    />
  );
}

it("shows effective defaults and clears overrides with null", async () => {
  const patches: unknown[] = [];
  const overridden = { ...bot, model: "old/main", cheapModel: "old/cheap" } as BotDefinition;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method !== "PATCH") {
      if (path.endsWith("/soul"))
        return Response.json({ soul: { body: "Be useful.", version: "1" } });
      if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
      return Response.json({ bots: [overridden] });
    }
    const patch = JSON.parse(String(init?.body));
    patches.push(patch);
    return Response.json({ bot: { ...bot, model: patch.model, cheapModel: undefined } });
  });
  render(editor(createApiClient({ fetch: fetcher }), overridden));

  const card = (await screen.findByText("triage")).closest("article");
  expect(card).not.toBeNull();
  const scope = within(card as HTMLElement);
  expect(scope.getByText(/Operations/)).toBeTruthy();
  expect(scope.getByText(/Effective model:/).textContent).toContain("old/main");
  fireEvent.change(scope.getByLabelText("Model"), { target: { value: "custom" } });
  fireEvent.change(scope.getByLabelText("AI model"), {
    target: { value: "provider/free-form" },
  });
  fireEvent.change(scope.getByLabelText("AI model for side work"), { target: { value: "" } });
  fireEvent.click(scope.getByRole("button", { name: "Save model settings" }));

  await scope.findByText("Model settings saved.");
  expect(patches).toEqual([{ model: "provider/free-form", cheapModel: null }]);
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
    if (path === "/api/bots" || path.startsWith("/api/bots?"))
      return Response.json({ bots: [bot] });
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
    return Response.json({});
  });
  render(editor(createApiClient({ fetch: fetcher })));

  await screen.findByText(/git push/);
  const rules = screen.getByLabelText("Approval rules for triage");
  fireEvent.click(within(rules).getByRole("button", { name: "Remove rule" }));
  expect(requests).toEqual([]);
  fireEvent.click(within(rules).getByRole("button", { name: "Confirm rule removal" }));
  await waitFor(() => expect(screen.queryByText(/git push/)).toBeNull());

  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "browser_click" } });
  fireEvent.change(screen.getByLabelText("Website"), {
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
    if (method === "GET") return Response.json({ bots: [bot] });
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(editor(createApiClient({ fetch: fetcher })));

  const soul = await screen.findByLabelText("SOUL.md for triage");
  fireEvent.change(soul, { target: { value: "My local draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save SOUL.md" }));

  await screen.findByText("Remote");
  expect((soul as HTMLTextAreaElement).value).toBe("My local draft");
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
      if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
      if (path.endsWith("/soul")) {
        if (init?.method === "PATCH")
          return Response.json(
            { code: "invalid_transition", message, details: {} },
            { status: 409 },
          );
        return Response.json({ soul: { body: "Original", version: "1" } });
      }
      return Response.json({ bots: [bot] });
    });
    render(editor(createApiClient({ fetch: fetcher })));
    const soul = await screen.findByLabelText("SOUL.md for triage");
    fireEvent.change(soul, { target: { value: "Keep my local instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SOUL.md" }));
    await screen.findByText(message);
    expect((soul as HTMLTextAreaElement).value).toBe("Keep my local instructions");
    expect(screen.queryByText(/SOUL.md changed since it was loaded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep draft and use latest as base" })).toBeNull();
  },
);

it("retains a dirty SOUL draft across in-app unmount and remount for the same session", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    if (path.endsWith("/soul")) return Response.json({ soul: { body: "Original", version: "1" } });
    return Response.json({ bots: [bot] });
  });
  const api = createApiClient({ fetch: fetcher });
  const first = render(editor(api));
  const soul = await screen.findByLabelText("SOUL.md for triage");
  fireEvent.change(soul, { target: { value: "Retained draft" } });
  first.unmount();

  render(editor(api));
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
    if (path.endsWith("/soul")) return Response.json({ soul: { body: "", version: "1" } });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    if (path === "/api/threads" && init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ thread: { id: "thr_test" }, members: [] });
    }
    return Response.json({ bots: [bot] });
  });
  render(editor(createApiClient({ fetch: fetcher })));
  await screen.findByText(/Needs instructions/);
  fireEvent.click(screen.getByRole("button", { name: "Start test chat" }));
  await waitFor(() =>
    expect(requests).toEqual([
      { workspaceId: bot.workspaceId, botIds: [bot.id], title: "Test triage" },
    ]),
  );
  expect(window.location.hash).toBe("#/threads/thr_test");
});

it("keeps instructions reachable in the use view while advanced operations stay hidden", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/soul"))
      return Response.json({ soul: { body: "Be useful.", version: "1" } });
    if (path.includes("/approval-rules?")) return Response.json({ rules: [], total: 0 });
    return Response.json({ bots: [bot] });
  });
  render(
    <InterfaceViewProvider view="use">
      {editor(createApiClient({ fetch: fetcher }))}
    </InterfaceViewProvider>,
  );
  expect(await screen.findByRole("button", { name: "Start test chat" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add schedule" })).toBeTruthy();
  expect(await screen.findByLabelText("SOUL.md for triage")).toBeTruthy();
  const instructions = screen.getByText("Instructions", { selector: "summary" });
  expect(instructions.parentElement?.hasAttribute("open")).toBe(false);
  fireEvent.click(instructions);
  expect(instructions.parentElement?.hasAttribute("open")).toBe(true);
  expect(screen.queryByRole("button", { name: "Save model settings" })).toBeNull();
  expect(screen.queryByLabelText("Approval rules for triage")).toBeNull();
  expect(screen.queryByText("Connectors")).toBeNull();
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
    if (path.endsWith("/soul"))
      return Response.json({ soul: { body: "Be useful.", version: "1" } });
    if (path.endsWith("/rule-versions/soul")) return Response.json({ file: "soul", versions: [] });
    if (path.startsWith("/api/bots/bot_1/approval-rules?") && method === "GET")
      return Response.json({ rules: [stored], offset: 0, limit: 25, total: 1 });
    if (path === "/api/approval-rules/rul_1" && method === "PATCH") {
      stored = { ...stored, ...body };
      return Response.json({ rule: stored });
    }
    if (method === "GET") return Response.json({ bots: [bot] });
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(editor(createApiClient({ fetch: fetcher })));
  await screen.findByText(/git push/);
  const rules = screen.getByLabelText("Approval rules for triage");
  fireEvent.click(within(rules).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(rules).getByLabelText("Details pattern"), {
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
