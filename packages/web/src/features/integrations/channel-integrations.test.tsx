// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ChannelIntegrations } from "./channel-integrations.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const manifest = {
  apiVersion: 1,
  id: "whatsapp",
  version: "1.0.0",
  displayName: "WhatsApp",
  description: "WhatsApp direct messages",
  capabilities: { directMessages: true, groups: false, testMessage: true },
  methods: [
    {
      id: "cloud",
      label: "Cloud API",
      description: "Meta Cloud API",
      fields: [
        { key: "phoneNumberId", label: "Phone number ID", kind: "text", required: true },
        {
          key: "accessToken",
          label: "Access token",
          kind: "password",
          secret: true,
          required: true,
        },
      ],
    },
  ],
  statusVocabulary: ["connected"],
};

const bot = {
  id: "bot_1",
  workspaceId: "ws_1",
  name: "helper",
  role: "Assistant",
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-10-11T00:00:00.000Z",
};

function channelGateway() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let connection: Record<string, unknown> | undefined;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/channels")
      return Response.json({ plugins: [{ manifest, state: "available" }], failures: [] });
    if (path === "/api/workspaces/ws_1/channels")
      return Response.json({ connections: connection ? [connection] : [] });
    if (path === "/api/workspaces/ws_1")
      return Response.json({ workspace: { id: "ws_1", name: "ops" }, bots: [bot] });
    if (path.endsWith("/connect")) {
      connection = {
        id: "chn_1",
        workspaceId: "ws_1",
        pluginId: "whatsapp",
        pluginVersion: "1.0.0",
        method: "cloud",
        botId: "bot_1",
        config: { phoneNumberId: body.config.phoneNumberId },
        status: { phase: "connected", account: "+15550001111" },
        createdAt: "2026-10-11T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:00.000Z",
      };
      return Response.json({ connection }, { status: 201 });
    }
    if (path.endsWith("/commands/test")) return Response.json({ connection });
    return Response.json({ code: "not_found", message: "no" }, { status: 404 });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

it("localizes product fields and drives the generic connect and test-message lifecycle", async () => {
  const { api, calls } = channelGateway();
  render(
    <I18nProvider locale="zh-CN">
      <ChannelIntegrations api={api} workspaceId="ws_1" />
    </I18nProvider>,
  );

  expect(await screen.findByText("WhatsApp")).toBeTruthy();
  expect(screen.getByLabelText("电话号码 ID")).toBeTruthy();
  expect(screen.getByLabelText("访问令牌")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("电话号码 ID"), { target: { value: "pn_1" } });
  fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "连接" }));

  expect(await screen.findByText("账号：+15550001111")).toBeTruthy();
  expect(calls.find((call) => call.path.endsWith("/connect"))?.body).toEqual({
    method: "cloud",
    botId: "bot_1",
    config: { phoneNumberId: "pn_1", accessToken: "secret" },
  });

  fireEvent.change(screen.getByLabelText("收件人手机号"), { target: { value: "+15551112222" } });
  fireEvent.click(screen.getByRole("button", { name: "发送测试消息" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/commands/test"))).toBe(true),
  );
});

const qrManifest = {
  ...manifest,
  methods: [{ id: "qr", label: "QR linked device", description: "Scan a QR code", fields: [] }],
  statusVocabulary: ["idle", "qr", "connected", "logged_out", "degraded"],
};

function connection(phase: string, extra: Record<string, unknown> = {}) {
  return {
    id: "chn_1",
    workspaceId: "ws_1",
    pluginId: "whatsapp",
    pluginVersion: "1.0.0",
    method: "qr",
    botId: "bot_1",
    config: {},
    status: { phase, ...extra },
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

/** A scripted Gateway: each route answers from the current state, which a test may change. */
function scriptedGateway(state: {
  catalog?: unknown;
  connections?: unknown[];
  bots?: unknown[];
  commands?: Record<string, () => Response>;
}) {
  const calls: { method: string; path: string }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (path === "/api/channels")
      return Response.json(
        state.catalog ?? { plugins: [{ manifest: qrManifest, state: "available" }], failures: [] },
      );
    if (path === "/api/workspaces/ws_1/channels")
      return Response.json({ connections: state.connections ?? [] });
    if (path === "/api/workspaces/ws_1")
      return Response.json({ workspace: { id: "ws_1", name: "ops" }, bots: state.bots ?? [bot] });
    const command = path.match(/\/commands\/([a-z]+)$/)?.[1];
    if (command && state.commands?.[command]) return state.commands[command]();
    return Response.json({ code: "not_found", message: "no" }, { status: 404 });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

function renderChannels(api: ReturnType<typeof createApiClient>, locale = "en") {
  return render(
    <I18nProvider locale={locale as "en"}>
      <ChannelIntegrations api={api} workspaceId="ws_1" />
    </I18nProvider>,
  );
}

it("explains an unavailable channel runtime in plain words, with diagnostics behind details", async () => {
  const state = {
    catalog: { plugins: [], failures: [{ id: "whatsapp", message: "entry hash mismatch" }] },
  };
  const { api, calls } = scriptedGateway(state);
  renderChannels(api);

  const notice = await screen.findByTestId("channels-unavailable");
  expect(notice.textContent).toContain("Chat channels are not available on this server");
  expect(notice.textContent).not.toMatch(/CHANNEL_PLUGIN_MANIFEST|container|environment/i);
  const technical = screen.getByText(/entry hash mismatch/);
  expect(technical.closest("details")).not.toBeNull();

  const before = calls.filter((call) => call.path === "/api/channels").length;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === "/api/channels").length).toBeGreaterThan(before),
  );
});

it("says a saved connection is waiting for its channel when the release lacks that plugin", async () => {
  const { api } = scriptedGateway({
    catalog: { plugins: [], failures: [] },
    connections: [connection("degraded", { message: "release plugin unavailable" })],
  });
  renderChannels(api);
  const notice = await screen.findByTestId("channels-unavailable");
  expect(notice.textContent).toContain("saved connection");
});

it("tells the operator to add a bot before connecting and keeps Connect disabled", async () => {
  const { api } = scriptedGateway({ bots: [] });
  renderChannels(api);
  expect(await screen.findByText(/Add a bot to this workspace first/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("shows a not-connected card with the missing step instead of a generic setup failure", async () => {
  const { api } = scriptedGateway({});
  renderChannels(api);
  expect(await screen.findByText("Not connected")).toBeTruthy();
  expect(screen.getByText(/Choose how to connect and which bot answers/)).toBeTruthy();
});

it("asks to link again when the phone unlinked the device", async () => {
  const { api, calls } = scriptedGateway({
    connections: [connection("logged_out", { message: "connection closed (401)" })],
    commands: { relink: () => Response.json({ connection: connection("qr") }) },
  });
  renderChannels(api);
  expect(await screen.findByText(/The phone unlinked this device/)).toBeTruthy();
  expect(screen.getByText("Needs re-link")).toBeTruthy();
  expect(screen.getByText(/connection closed \(401\)/).closest("details")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Link again" }));
  await waitFor(() => expect(calls.some((call) => call.path.endsWith("/relink"))).toBe(true));
});

it("offers Retry for a disconnected account and drives reconnect", async () => {
  const { api, calls } = scriptedGateway({
    connections: [connection("degraded", { message: "socket timeout" })],
    commands: { reconnect: () => Response.json({ connection: connection("connected") }) },
  });
  renderChannels(api);
  expect(await screen.findByText(/cannot reach this account right now/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls.some((call) => call.path.endsWith("/reconnect"))).toBe(true));
});

it("claims a test message was sent only after the test command succeeds", async () => {
  let ok = false;
  const { api } = scriptedGateway({
    connections: [connection("connected", { account: "+15550001111" })],
    commands: {
      test: () =>
        ok
          ? Response.json({ connection: connection("connected") })
          : Response.json({ code: "validation", message: "recipient refused" }, { status: 400 }),
    },
  });
  renderChannels(api);
  fireEvent.change(await screen.findByLabelText("Recipient phone number"), {
    target: { value: "+15551112222" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));
  expect(await screen.findByText(/recipient refused/)).toBeTruthy();
  expect(screen.queryByText("Test message sent.")).toBeNull();

  ok = true;
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));
  expect(await screen.findByText("Test message sent.")).toBeTruthy();
});

it("localizes the recovery copy", async () => {
  const { api } = scriptedGateway({ connections: [connection("logged_out")] });
  renderChannels(api, "zh-CN");
  expect(await screen.findByRole("button", { name: "重新关联" })).toBeTruthy();
  expect(screen.queryByText(/The phone unlinked this device/)).toBeNull();
});
