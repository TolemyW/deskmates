// @vitest-environment jsdom
// T0: Connections › Chat channels for a single-account plugin: the connected list and its
// plain-language states, the management dialog, and the guided setup (ADR-0047 amendment 2).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { ChannelsTab } from "./channels-tab.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
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

function tab(api: ReturnType<typeof createApiClient>, locale = "en", onOpenGuide = vi.fn()) {
  return (
    <I18nProvider locale={locale as "en"}>
      <ChannelsTab
        api={api}
        workspaceId="ws_1"
        onOpenGuide={onOpenGuide}
        onOpenChats={() => undefined}
      />
    </I18nProvider>
  );
}

it("connects through the guided setup, then drives the test-message lifecycle from Manage", async () => {
  const { api, calls } = channelGateway();
  render(tab(api));
  fireEvent.click(await screen.findByRole("button", { name: "Connect WhatsApp" }));
  expect(screen.getByRole("dialog", { name: "Connect WhatsApp" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  // A manifest without a guide shows its description; nothing is invented.
  expect(screen.getByText("Meta Cloud API")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Phone number ID"), { target: { value: "pn_1" } });
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  expect(await screen.findByText("Connected as +15550001111.")).toBeTruthy();
  expect(calls.find((call) => call.path.endsWith("/connect"))?.body).toEqual({
    method: "cloud",
    botId: "bot_1",
    config: { phoneNumberId: "pn_1", accessToken: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(await screen.findByRole("button", { name: "Manage WhatsApp +15550001111" }));
  const webhook = await screen.findByText(/Cloud API webhook/);
  expect(webhook.closest("details")?.querySelector("summary")?.textContent).toBe(
    "Technical details",
  );
  fireEvent.change(screen.getByLabelText("Recipient phone number"), {
    target: { value: "+15551112222" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/commands/test"))).toBe(true),
  );
});

it("localizes the setup's fields from the catalog and keeps the manifest English otherwise", async () => {
  const { api } = channelGateway();
  render(tab(api, "zh-CN"));
  fireEvent.click((await screen.findAllByRole("button", { name: /WhatsApp/ }))[0] as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByLabelText("电话号码 ID")).toBeTruthy();
  expect(screen.getByLabelText("访问令牌")).toBeTruthy();
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
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path.endsWith("/blocks") && method === "GET") return Response.json({ blocks: [] });
    if (path.endsWith("/blocks") && method === "POST")
      return Response.json(
        { block: { connectionId: "chn_1", ...body, createdBy: "admin", createdAt: "t" } },
        { status: 201 },
      );
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

async function renderChannels(
  api: ReturnType<typeof createApiClient>,
  locale = "en",
  roles?: { tenantRole: "member"; platformMaintainer: false },
  manageConnection = true,
) {
  const page = tab(api, locale);
  const view = render(
    roles ? <SessionRolesProvider roles={roles}>{page}</SessionRolesProvider> : page,
  );
  if (manageConnection)
    fireEvent.click((await screen.findAllByRole("button", { name: /WhatsApp/ }))[0] as HTMLElement);
  return view;
}

it("explains an unavailable channel runtime in plain words, with diagnostics behind details", async () => {
  const state = {
    catalog: { plugins: [], failures: [{ id: "whatsapp", message: "entry hash mismatch" }] },
  };
  const { api, calls } = scriptedGateway(state);
  await renderChannels(api, "en", undefined, false);

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
  await renderChannels(api, "en", undefined, false);
  const notice = await screen.findByTestId("channels-unavailable");
  expect(notice.textContent).toContain("saved connection");
});

it("tells the operator to add a bot before connecting and keeps Connect disabled", async () => {
  const { api } = scriptedGateway({ bots: [] });
  await renderChannels(api, "en", undefined, false);
  expect(await screen.findByText(/Add a Bot to this workspace first/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Connect WhatsApp" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("lists each channel with one Connect action and a guide for its section", async () => {
  const onOpenGuide = vi.fn();
  const { api } = scriptedGateway({});
  render(tab(api, "en", onOpenGuide));
  expect(await screen.findByRole("button", { name: "Connect WhatsApp" })).toBeTruthy();
  expect(screen.queryByText("Connected", { selector: "h2" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Guide for WhatsApp" }));
  expect(onOpenGuide).toHaveBeenCalledWith("whatsapp");
  fireEvent.click(screen.getByRole("button", { name: "How chat channels work" }));
  expect(onOpenGuide).toHaveBeenLastCalledWith();
});

it("asks to link again when the phone unlinked the device", async () => {
  const { api, calls } = scriptedGateway({
    connections: [connection("logged_out", { message: "connection closed (401)" })],
    commands: { relink: () => Response.json({ connection: connection("qr") }) },
  });
  await renderChannels(api, "en", undefined, false);
  // The list already says what is wrong and what to do.
  expect(await screen.findByText("Needs re-link")).toBeTruthy();
  expect(screen.getByText(/The phone unlinked this device/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage WhatsApp" }));
  expect(screen.getByText(/connection closed \(401\)/).closest("details")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Link again" }));
  await waitFor(() => expect(calls.some((call) => call.path.endsWith("/relink"))).toBe(true));
});

it("offers Retry for a disconnected account and drives reconnect", async () => {
  const { api, calls } = scriptedGateway({
    connections: [connection("degraded", { message: "socket timeout" })],
    commands: { reconnect: () => Response.json({ connection: connection("connected") }) },
  });
  await renderChannels(api);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/cannot reach this account right now/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls.some((call) => call.path.endsWith("/reconnect"))).toBe(true));
});

it("shows a connection of a workspace in Trash as stopped and offers no command (ADR-0017 amendment 1 P6)", async () => {
  const { api } = scriptedGateway({
    connections: [connection("archived", { message: "Stopped while the workspace is in Trash." })],
  });
  await renderChannels(api);
  expect((await screen.findAllByText("Stopped (in Trash)")).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/restoring the workspace starts it again/).length).toBeGreaterThan(0);
  for (const name of ["Retry", "Reconnect", "Link again", "Disconnect"])
    expect(screen.queryByRole("button", { name })).toBeNull();
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
  await renderChannels(api);
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
  await renderChannels(api, "zh-CN");
  expect(await screen.findByRole("button", { name: "重新关联" })).toBeTruthy();
  expect(screen.queryByText(/The phone unlinked this device/)).toBeNull();
});

const abi2Manifest = {
  ...qrManifest,
  apiVersion: 2,
  version: "2.0.0",
  multipleConnections: false,
  senderAdmission: { mode: "blocklist" },
  capabilities: {
    directMessages: "available",
    groups: "unavailable",
    inboundImages: "disabled",
    inboundOtherMedia: "disabled",
    outboundReply: "available",
    proactiveMessages: "unavailable",
    streaming: "unavailable",
    approvals: "available",
    testMessage: "available",
  },
  methods: [{ ...qrManifest.methods[0], identity: "link" }],
};

function abi2Connection(extra: Record<string, unknown> = {}) {
  return {
    ...connection("qr", { qr: "data:image/png;base64,AAAA" }),
    pluginVersion: "2.0.0",
    apiVersion: 2,
    bindingGeneration: 1,
    ...extra,
  };
}

const NOTICE = /Every sender is now admitted\. WhatsApp no longer uses a list of allowed senders/;

it("keeps the one-connection card for an ABI-2 plugin without multipleConnections and offers its blocklist (ADR-0047 amendment 1)", async () => {
  const { api, calls } = scriptedGateway({
    catalog: { plugins: [{ manifest: abi2Manifest, state: "available" }], failures: [] },
    connections: [abi2Connection()],
  });
  await renderChannels(api);
  expect(await screen.findByAltText("WhatsApp linking QR code")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Link again" })).toBeTruthy();
  // No allowlist field anywhere, and no notice for a connection created after the change.
  expect(screen.queryByText(/Allowed phone numbers/)).toBeNull();
  expect(screen.queryByText(NOTICE)).toBeNull();
  fireEvent.click(screen.getByText("Blocked people"));
  expect(await screen.findByText("Nobody is blocked.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Person's ID on this channel"), {
    target: { value: "15559999999" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Block" }));
  await waitFor(() =>
    expect(
      calls.find((call) => call.method === "POST" && call.path.endsWith("/blocks")),
    ).toMatchObject({
      path: "/api/workspaces/ws_1/channel-connections/chn_1/blocks",
      body: { senderId: "15559999999" },
    }),
  );
});

it("says once that every sender is now admitted on a connection whose allowlist was dropped (ADR-0017 amendment 3)", async () => {
  const state = {
    catalog: { plugins: [{ manifest: abi2Manifest, state: "available" }], failures: [] },
    connections: [abi2Connection({ admissionChangedAt: "2026-10-17T14:54:00.000Z" })],
  };
  const first = await renderChannels(scriptedGateway(state).api);
  expect(await screen.findByText(NOTICE)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect(screen.queryByText(NOTICE)).toBeNull();
  first.unmount();
  // The same viewer does not see it again.
  await renderChannels(scriptedGateway(state).api);
  expect(await screen.findByAltText("WhatsApp linking QR code")).toBeTruthy();
  expect(screen.queryByText(NOTICE)).toBeNull();
});

it("localizes the admission notice in every locale", async () => {
  const state = {
    catalog: { plugins: [{ manifest: abi2Manifest, state: "available" }], failures: [] },
    connections: [abi2Connection({ admissionChangedAt: "2026-10-17T14:54:00.000Z" })],
  };
  const expected: Record<string, RegExp> = {
    "zh-CN": /现在所有发件人都会被接收。WhatsApp 不再使用允许的发件人列表/,
    "zh-TW": /現在所有發件人都會被接收。WhatsApp 不再使用允許的發件人清單/,
    ja: /すべての送信者が受け入れられるようになりました。WhatsApp は/,
    es: /Ahora se admite a todos los remitentes\. WhatsApp ya no usa/,
  };
  for (const [locale, text] of Object.entries(expected)) {
    const view = await renderChannels(scriptedGateway(state).api, locale);
    expect(await screen.findByText(text)).toBeTruthy();
    view.unmount();
  }
});

it("shows a Member neither the blocklist nor the admission notice", async () => {
  const { api } = scriptedGateway({
    catalog: { plugins: [{ manifest: abi2Manifest, state: "available" }], failures: [] },
    connections: [abi2Connection({ admissionChangedAt: "2026-10-17T14:54:00.000Z" })],
  });
  await renderChannels(api, "en", { tenantRole: "member", platformMaintainer: false });
  expect(await screen.findByAltText("WhatsApp linking QR code")).toBeTruthy();
  expect(screen.queryByText("Blocked people")).toBeNull();
  expect(screen.queryByText(NOTICE)).toBeNull();
});

it("opens setup only on request and discards unsent tokens when closed", async () => {
  const { api, calls } = channelGateway();
  render(tab(api));
  const connect = await screen.findByRole("button", { name: "Connect WhatsApp" });
  expect(screen.queryByLabelText("Access token")).toBeNull();
  fireEvent.click(connect);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "unsent-canary" } });
  fireEvent.click(screen.getByRole("button", { name: "Close connect" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(connect));
  fireEvent.click(connect);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect((screen.getByLabelText("Access token") as HTMLInputElement).value).toBe("");
  expect(calls.some((call) => call.path.endsWith("/connect"))).toBe(false);
});

it("does not overlap background reads or let an older response replace a manual retry", async () => {
  const interval = vi
    .spyOn(window, "setInterval")
    .mockReturnValue(42 as unknown as ReturnType<typeof window.setInterval>);
  vi.spyOn(window, "clearInterval").mockImplementation(() => {});
  const { api } = channelGateway();
  const original = api.getChannelCatalog.bind(api);
  let finishOld!: (value: Awaited<ReturnType<typeof api.getChannelCatalog>>) => void;
  const catalog = vi
    .spyOn(api, "getChannelCatalog")
    .mockResolvedValueOnce({ plugins: [], failures: [] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementation(original);
  render(tab(api));
  await screen.findByTestId("channels-unavailable");
  const poll = interval.mock.calls.find((call) => call[1] === 3000)?.[0];
  if (typeof poll !== "function") throw new Error("Missing refresh callback");
  await act(async () => {
    poll();
  });
  await act(async () => {
    poll();
  });
  expect(catalog).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Connect WhatsApp" });
  await act(async () => {
    finishOld({ plugins: [], failures: [] });
  });
  expect(screen.queryByTestId("channels-unavailable")).toBeNull();
  expect(screen.getByRole("button", { name: "Connect WhatsApp" })).toBeTruthy();
});

it("does not report a zero count before loading or update it after unmount", async () => {
  const { api } = channelGateway();
  const original = api.getChannelCatalog.bind(api);
  let finish!: (value: Awaited<ReturnType<typeof api.getChannelCatalog>>) => void;
  vi.spyOn(api, "getChannelCatalog").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onCount = vi.fn();
  const view = render(
    <ChannelsTab
      api={api}
      workspaceId="ws_1"
      onCount={onCount}
      onOpenGuide={() => {}}
      onOpenChats={() => {}}
    />,
  );
  expect(onCount).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => {
    finish(await original());
  });
  expect(onCount).not.toHaveBeenCalled();
});
