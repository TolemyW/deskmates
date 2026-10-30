// @vitest-environment jsdom
// T1, ADR-0047: Connections › Chat channels lists several connections of an ABI-2 plugin, renders
// the capability matrix from the manifest without provider branches, and drives rebind, credential
// replacement, the blocklist and a further connection through the connection-addressed routes.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ChannelsTab } from "./channels-tab.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const manifest = {
  apiVersion: 2,
  id: "fakechat",
  version: "1.0.0",
  displayName: "Fakechat",
  description: "A provider with one bot per connection",
  multipleConnections: true,
  capabilities: {
    directMessages: "available",
    groups: "unavailable",
    inboundImages: "available",
    inboundOtherMedia: "disabled",
    outboundReply: "available",
    proactiveMessages: "unavailable",
    streaming: "disabled",
    approvals: "available",
    testMessage: "unavailable",
  },
  methods: [
    {
      id: "token",
      label: "Bot token",
      description: "Paste the token",
      fields: [
        { key: "token", label: "Bot token", kind: "password", secret: true, required: true },
      ],
    },
  ],
  statusVocabulary: ["connected"],
};

const bot = (id: string, name: string) => ({
  id,
  workspaceId: "ws_1",
  name,
  role: "Assistant",
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-10-17T00:00:00.000Z",
});

const connection = (id: string, label: string, botId: string, phase = "connected") => ({
  id,
  workspaceId: "ws_1",
  pluginId: "fakechat",
  pluginVersion: "1.0.0",
  method: "token",
  botId,
  config: {},
  status: { phase },
  apiVersion: 2,
  identityKey: `fakechat:bot:${id}`,
  identityLabel: label,
  bindingGeneration: 1,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
});

function gateway(phase = "connected", statusMessage?: string) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let blocks: { connectionId: string; senderId: string; createdBy: string; createdAt: string }[] =
    [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/channels")
      return Response.json({ plugins: [{ manifest, state: "available" }], failures: [] });
    if (path === "/api/workspaces/ws_1/channels")
      return Response.json({
        connections: [
          {
            ...connection("chn_a", "Alice's bot", "bot_1", phase),
            status: { phase, message: statusMessage },
          },
          connection("chn_b", "Support bot", "bot_2", phase),
        ],
      });
    if (path === "/api/workspaces/ws_1")
      return Response.json({
        workspace: { id: "ws_1", name: "ops" },
        bots: [bot("bot_1", "helper"), bot("bot_2", "writer")],
      });
    const base = "/api/workspaces/ws_1/channel-connections/chn_a";
    if (path === `${base}/rebind`)
      return Response.json({ connection: connection("chn_a", "Alice's bot", body.botId) });
    if (path === `${base}/commands/relink`)
      return Response.json({ connection: connection("chn_a", "Alice's bot", "bot_1") });
    if (path === `${base}/blocks` && method === "GET") return Response.json({ blocks });
    if (path === `${base}/blocks` && method === "POST") {
      blocks = [
        { connectionId: "chn_a", senderId: body.senderId, createdBy: "user:1", createdAt: "x" },
      ];
      return Response.json({ block: blocks[0] }, { status: 201 });
    }
    if (path.startsWith(`${base}/blocks/`) && method === "DELETE") {
      blocks = [];
      return Response.json({ removed: true });
    }
    if (path === "/api/workspaces/ws_1/channels/fakechat/connect")
      return Response.json({ connection: connection("chn_c", "Third", "bot_1") }, { status: 201 });
    return Response.json({ code: "not_found", message: "no" }, { status: 404 });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

async function renderAt(api: ReturnType<typeof createApiClient>, locale = "en") {
  render(
    <I18nProvider locale={locale as "en"}>
      <ChannelsTab
        api={api}
        workspaceId="ws_1"
        onOpenGuide={() => undefined}
        onOpenChats={() => undefined}
      />
    </I18nProvider>,
  );
  expect(screen.queryByLabelText("Bot token")).toBeNull();
}

/** Open the management dialog of one connection from its row. */
async function manage(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

it("lists each connection with its account and bot, and the capability matrix from the manifest", async () => {
  const { api } = gateway();
  await renderAt(api);
  expect(await screen.findByText("Answered by helper", { exact: false })).toBeTruthy();
  expect(screen.getByText("Answered by writer", { exact: false })).toBeTruthy();
  expect(screen.getByText("· Alice's bot")).toBeTruthy();
  expect(screen.getAllByText("2 connections").length).toBeGreaterThan(0);
  const groups = screen.getByText("Groups, channels and threads").closest("li");
  expect(groups?.textContent).toContain("Not supported");
  const media = screen.getByText("Other files and media").closest("li");
  expect(media?.textContent).toContain("Off in this version");
  await manage(/Manage Fakechat Alice's bot/);
  const first = await screen.findByTestId("channel-connection-chn_a");
  expect(within(first).getByText("Account: Alice's bot")).toBeTruthy();
});

it("switches the answering bot, replaces credentials and manages the blocklist by connection id", async () => {
  const { api, calls } = gateway();
  await renderAt(api);
  await manage(/Manage Fakechat Alice's bot/);
  const first = await screen.findByTestId("channel-connection-chn_a");

  fireEvent.change(within(first).getByLabelText("New Bot"), { target: { value: "bot_2" } });
  fireEvent.click(within(first).getByRole("button", { name: "Switch Bot" }));
  expect(await within(first).findByText("Now answered by writer.")).toBeTruthy();
  expect(calls.find((call) => call.path.endsWith("/chn_a/rebind"))?.body).toEqual({
    botId: "bot_2",
  });

  fireEvent.change(within(first).getByLabelText("Bot token"), { target: { value: "new-token" } });
  fireEvent.click(within(first).getByRole("button", { name: "Save credentials" }));
  await waitFor(() =>
    expect(calls.find((call) => call.path.endsWith("/chn_a/commands/relink"))?.body).toEqual({
      config: { token: "new-token" },
    }),
  );

  const blocklist = within(first).getByText("Blocked people").closest("details") as HTMLElement;
  blocklist.setAttribute("open", "");
  fireEvent(blocklist, new Event("toggle"));
  expect(await within(blocklist).findByText("Nobody is blocked.")).toBeTruthy();
  fireEvent.change(within(blocklist).getByLabelText("Person's ID on this channel"), {
    target: { value: "spammer-1" },
  });
  fireEvent.click(within(blocklist).getByRole("button", { name: "Block" }));
  expect(await within(blocklist).findByText("spammer-1")).toBeTruthy();
  expect(
    calls.find((call) => call.method === "POST" && call.path.endsWith("/chn_a/blocks"))?.body,
  ).toEqual({ senderId: "spammer-1" });
  fireEvent.click(within(blocklist).getByRole("button", { name: "Unblock" }));
  expect(await within(blocklist).findByText("Nobody is blocked.")).toBeTruthy();
  expect(
    calls.some((call) => call.method === "DELETE" && call.path.endsWith("/chn_a/blocks/spammer-1")),
  ).toBe(true);
});

it("adds another connection of the same plugin through the guided setup", async () => {
  const { api, calls } = gateway();
  await renderAt(api);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Fakechat" }));
  fireEvent.change(screen.getByLabelText("Bot that answers"), { target: { value: "bot_2" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  const form = screen.getByRole("form", { name: "Connection details" });
  fireEvent.change(within(form).getByLabelText("Bot token"), { target: { value: "tok-3" } });
  fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(
      calls.find((call) => call.path === "/api/workspaces/ws_1/channels/fakechat/connect")?.body,
    ).toEqual({ method: "token", botId: "bot_2", config: { token: "tok-3" } }),
  );
});

it("renders the connection controls in every locale", async () => {
  const { api } = gateway();
  await renderAt(api, "zh-CN");
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Fakechat Alice's bot/ }))[0] as HTMLElement,
  );
  const first = await screen.findByTestId("channel-connection-chn_a");
  expect(within(first).getByText("账号：Alice's bot")).toBeTruthy();
  expect(within(first).getByText("已屏蔽的人")).toBeTruthy();
  expect(within(first).getByText("改由其他 Bot 回复")).toBeTruthy();
});

it("shows the connections of a workspace in Trash as stopped, without lifecycle controls (ADR-0017 amendment 1 P6)", async () => {
  const { api } = gateway("archived");
  await renderAt(api);
  expect((await screen.findAllByText("Stopped (in Trash)")).length).toBe(2);
  await manage(/Manage Fakechat Alice's bot/);
  const first = await screen.findByTestId("channel-connection-chn_a");
  expect(within(first).getByText("Stopped (in Trash)")).toBeTruthy();
  expect(within(first).getByText(/restoring the workspace starts it again/)).toBeTruthy();
  for (const name of ["Reconnect", "Disconnect"])
    expect(within(first).queryByRole("button", { name })).toBeNull();
});

it("shows a partial-delivery warning on a connected account with the recovery control", async () => {
  const message = "A reply was partially delivered. Use Reconnect to retry the remaining chunks.";
  const { api } = gateway("connected", message);
  await renderAt(api);
  await manage(/Manage Fakechat Alice's bot/);
  const card = await screen.findByTestId("channel-connection-chn_a");
  expect(within(card).getByRole("status").textContent).toBe(message);
  expect(within(card).getByRole("button", { name: "Reconnect" })).toBeTruthy();
});
