// @vitest-environment jsdom
// The Vault page (ADR-0045 decisions 2, 4, 8 and 9): the shared-workspace boundary is stated; the
// approve_all notice shows in that mode only, in every locale; a saved value is never on the page;
// a typed value is cleared after every submission and never written to browser storage; a Member
// reads without the forms; a token without a request definition is labelled unusable.

import "@testing-library/jest-dom/vitest";

import type {
  ApprovalMode,
  VaultEntry,
  VaultView,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import en from "./messages/en.json";
import es from "./messages/es.json";
import ja from "./messages/ja.json";
import zhCN from "./messages/zh-CN.json";
import zhTW from "./messages/zh-TW.json";
import { VaultScreen, formatParams, parseParams } from "./vault.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SECRET = "synthetic-canary-password-7f3a";
const workspace: Workspace = {
  id: "ws_1" as WorkspaceId,
  name: "ops",
  sandboxProvider: "docker",
  status: "ready",
  egressAllowlist: [],
  createdAt: "2026-10-17T00:00:00.000Z",
};

function entry(extra: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: "vlt_1",
    workspaceId: "ws_1",
    name: "Console",
    type: "browser_login",
    targetOrigin: "https://console.example.test",
    enabled: true,
    revision: 1,
    hasUsername: true,
    usable: true,
    requests: [],
    createdAt: "2026-10-17T00:00:00.000Z",
    createdBy: "user:u1",
    updatedAt: "2026-10-17T00:00:00.000Z",
    updatedBy: "user:u1",
    ...extra,
  };
}

function gateway(mode: ApprovalMode, entries: VaultEntry[] = [entry()]) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/workspaces/ws_1/vault" && method === "GET") {
      const vault: VaultView = {
        workspaceId: "ws_1",
        available: true,
        approvalMode: mode,
        entries,
      };
      return Response.json({ vault });
    }
    if (method === "POST" || method === "PUT")
      return Response.json(
        { code: "validation", message: "refused", details: { field: "name" } },
        { status: 400 },
      );
    return Response.json({ entry: entries[0] });
  });
  return { calls, api: createApiClient({ fetch: fetcher }) };
}

function renderAs(role: "admin" | "member", api: ReturnType<typeof gateway>["api"]) {
  return render(
    <SessionRolesProvider
      roles={{ tenantRole: role, platformMaintainer: false, workspaceRoles: { ws_1: role } }}
    >
      <VaultScreen api={api} />
    </SessionRolesProvider>,
  );
}

it("states the shared-workspace boundary and that a fill is not a sign-in", async () => {
  renderAs("admin", gateway("automatic").api);
  expect(await screen.findByText("Console")).toBeInTheDocument();
  expect(screen.getByText(en["vault.sharedNote"])).toBeInTheDocument();
  expect(screen.queryByLabelText(en["vault.field.password"])).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en["vault.about"] }));
  expect(screen.getByText(en["vault.boundary"])).toBeInTheDocument();
  expect(screen.getByText(en["vault.filledNote"])).toBeInTheDocument();
  expect(screen.getByText(en["vault.mode.automatic"])).toBeInTheDocument();
  expect(screen.queryByText(en["vault.mode.approveAll"])).toBeNull();
});

it("warns in approve_all that credential uses are allowed without asking anyone", async () => {
  renderAs("member", gateway("approve_all").api);
  expect(await screen.findByRole("alert")).toHaveTextContent("mode:approve_all");
});

it("says approve_all and the boundary in every locale, with the same keys", () => {
  for (const messages of [en, es, ja, zhCN, zhTW]) {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    expect(messages["vault.mode.approveAll"]).toContain("mode:approve_all");
    expect(messages["vault.boundary"]).toContain("ADR-0045");
  }
});

it("lets a Member read without forms, and labels a token without definitions unusable", async () => {
  renderAs(
    "member",
    gateway("manual", [
      entry({
        type: "http_header_token",
        usable: false,
        unusableReason: "no_request_definition",
        hasUsername: false,
      }),
    ]).api,
  );
  expect(await screen.findByText(/no request definition yet/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Console/ }));
  expect(screen.queryByText(en["vault.create.title"])).toBeNull();
  expect(screen.queryByText(en["vault.replace"])).toBeNull();
});

it("clears typed values after a refused submission and stores nothing in the browser", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const { api, calls } = gateway("automatic", []);
  renderAs("admin", api);
  fireEvent.click(await screen.findByRole("button", { name: en["vault.create.title"] }));
  fireEvent.change(await screen.findByLabelText(en["vault.field.name"]), {
    target: { value: "Console" },
  });
  fireEvent.change(screen.getByLabelText(en["vault.field.origin"]), {
    target: { value: "https://console.example.test" },
  });
  const password = screen.getByLabelText(en["vault.field.password"]) as HTMLInputElement;
  fireEvent.change(password, { target: { value: SECRET } });
  expect(password.type).toBe("password");
  fireEvent.click(screen.getByText(en["vault.create.submit"]));
  await waitFor(() => expect(screen.getByText("refused")).toBeInTheDocument());
  expect(password.value).toBe("");
  expect(calls.find((c) => c.method === "POST")?.body?.password).toBe(SECRET);
  expect(calls.every((c) => !c.path.includes(SECRET))).toBe(true);
  expect(setItem.mock.calls.flat().join(" ")).not.toContain(SECRET);
  expect(document.body.innerHTML).not.toContain(SECRET);
});

it("round-trips the parameter line format of the definition editor", () => {
  const params = parseParams("id path string\nq query string required\nlimit query integer");
  expect(params).toEqual([
    { name: "id", in: "path", type: "string", required: true },
    { name: "q", in: "query", type: "string", required: true },
    { name: "limit", in: "query", type: "integer" },
  ]);
  expect(parseParams(formatParams(params))).toEqual(params);
});

it("discards an unsent credential when its dialog closes and returns focus to Add", async () => {
  const { api, calls } = gateway("automatic", []);
  renderAs("admin", api);
  const add = await screen.findByRole("button", { name: en["vault.create.title"] });
  fireEvent.click(add);
  fireEvent.change(screen.getByLabelText(en["vault.field.password"]), {
    target: { value: SECRET },
  });
  fireEvent.click(screen.getByRole("button", { name: en["vault.cancel"] }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(add));
  fireEvent.click(add);
  expect((screen.getByLabelText(en["vault.field.password"]) as HTMLInputElement).value).toBe("");
  expect(calls.some((call) => call.method === "POST")).toBe(false);
});

it("dates the last use in the UI's language, not the browser default (#63 L23)", async () => {
  const at = "2026-10-17T09:30:00.000Z";
  const lastUse = { at, operation: "fill", status: "filled", botId: "bot_1", runId: "run_1" };
  const { api } = gateway("automatic", [entry({ lastUse } as Partial<VaultEntry>)]);
  render(
    <I18nProvider locale="ja">
      <SessionRolesProvider
        roles={{
          tenantRole: "admin",
          platformMaintainer: false,
          workspaceRoles: { ws_1: "admin" },
        }}
      >
        <VaultScreen api={api} />
      </SessionRolesProvider>
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Console/ }));
  expect(
    await screen.findByText(new RegExp(new Date(at).toLocaleString("ja").replace(/[/:]/g, "\\$&"))),
  ).toBeInTheDocument();
});

it("preserves a refused request definition for correction and discards it on cancel", async () => {
  const { api } = gateway("manual", [entry({ type: "http_header_token", hasUsername: false })]);
  renderAs("admin", api);
  fireEvent.click(await screen.findByRole("button", { name: /Console/ }));
  fireEvent.click(screen.getByRole("button", { name: en["vault.requests.add"] }));
  fireEvent.change(screen.getByLabelText(en["vault.field.name"]), {
    target: { value: "Read ticket" },
  });
  fireEvent.change(screen.getByLabelText(en["vault.requests.path"]), {
    target: { value: "/tickets/{id}" },
  });
  fireEvent.change(screen.getByLabelText(en["vault.requests.params"]), {
    target: { value: "id path string required" },
  });
  fireEvent.click(screen.getByRole("button", { name: en["vault.requests.save"] }));
  expect(await screen.findByRole("alert")).toHaveTextContent("refused");
  expect(screen.getByLabelText(en["vault.field.name"])).toHaveValue("Read ticket");
  expect(screen.getByLabelText(en["vault.requests.path"])).toHaveValue("/tickets/{id}");
  expect(screen.getByLabelText(en["vault.requests.params"])).toHaveValue("id path string required");
  // The inline Cancel is distinct from the dialog's close control.
  fireEvent.click(
    screen
      .getAllByRole("button", { name: en["vault.cancel"] })
      .find((button) => button.closest(".vault-form")) as HTMLElement,
  );
  fireEvent.click(screen.getByRole("button", { name: en["vault.requests.add"] }));
  expect(screen.getByLabelText(en["vault.field.name"])).toHaveValue("");
  expect(screen.getByLabelText(en["vault.requests.path"])).toHaveValue("/");
});

it("recovers a failed catalog read without writing credentials", async () => {
  const { api, calls } = gateway("manual");
  vi.spyOn(api, "getWorkspaceVault").mockRejectedValueOnce(new Error("Read unavailable"));
  renderAs("admin", api);
  expect(await screen.findByRole("alert")).toHaveTextContent("Read unavailable");
  fireEvent.click(screen.getByRole("button", { name: en["vault.retry"] }));
  expect(await screen.findByText("Console")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("drops an old workspace catalog when its read finishes after switching", async () => {
  const { api } = gateway("manual");
  const second = { ...workspace, id: "ws_2", name: "Research" } as Workspace;
  vi.spyOn(api, "listWorkspaces").mockResolvedValue([workspace as Workspace, second]);
  let finishOld!: (value: VaultView) => void;
  const read = vi.spyOn(api, "getWorkspaceVault").mockImplementation((id) =>
    id === "ws_1"
      ? new Promise((resolve) => {
          finishOld = resolve;
        })
      : Promise.resolve({
          workspaceId: "ws_2",
          available: true,
          approvalMode: "manual",
          entries: [entry({ id: "vlt_2", workspaceId: "ws_2", name: "Research login" })],
        }),
  );
  function Switcher() {
    const scope = useWorkspaceScope(api);
    return (
      <button type="button" onClick={() => scope.select(second.id)}>
        Switch workspace
      </button>
    );
  }
  render(
    <WorkspaceScopeProvider api={api} initialWorkspaceId={"ws_1" as WorkspaceId}>
      <Switcher />
      <VaultScreen api={api} />
    </WorkspaceScopeProvider>,
  );
  await waitFor(() => expect(read).toHaveBeenCalledWith("ws_1"));
  fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
  expect(await screen.findByText("Research login")).toBeInTheDocument();
  await act(async () =>
    finishOld({ workspaceId: "ws_1", available: true, approvalMode: "manual", entries: [entry()] }),
  );
  expect(screen.queryByText("Console")).toBeNull();
  expect(screen.getByText("Research login")).toBeInTheDocument();
});
