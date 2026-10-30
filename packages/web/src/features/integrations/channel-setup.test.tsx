// @vitest-environment jsdom
// T0, ADR-0047 amendment 2 G1 to G3 in the Web: the guided setup shows the manifest's steps with
// their links and copy values, field help, the workspace's default bot first, and after connecting
// the verified account with its open link.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  id: "telegram",
  version: "1.0.0",
  displayName: "Telegram",
  description: "One Telegram bot per connection.",
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
      description: "Paste a token.",
      setup: {
        steps: [
          {
            id: "botfather",
            text: "In Telegram, open @BotFather and send /newbot.",
            link: { label: "Open BotFather", url: "https://t.me/BotFather" },
          },
          {
            id: "hook",
            text: "Paste this path in the provider.",
            copy: { label: "Webhook path", value: "{webhookPath}" },
          },
        ],
      },
      open: { label: "Open in Telegram", url: "https://t.me/{handle}" },
      fields: [
        {
          key: "token",
          label: "Bot token",
          kind: "password",
          secret: true,
          required: true,
          help: "The token BotFather sent.",
        },
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
  createdAt: "2026-10-22T00:00:00.000Z",
});

function gateway() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let connections: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/channels")
      return Response.json({ plugins: [{ manifest, state: "available" }], failures: [] });
    if (path === "/api/workspaces/ws_1/channels") return Response.json({ connections });
    if (path === "/api/workspaces/ws_1")
      return Response.json({
        workspace: { id: "ws_1", name: "ops", defaultBotId: "bot_2" },
        bots: [bot("bot_1", "helper"), bot("bot_2", "assistant")],
      });
    if (path.endsWith("/connect")) {
      const connection = {
        id: "chn_1",
        workspaceId: "ws_1",
        pluginId: "telegram",
        pluginVersion: "1.0.0",
        method: "token",
        botId: body.botId,
        config: {},
        status: { phase: "connected" },
        apiVersion: 2,
        identityKey: "telegram:bot:42",
        identityLabel: "@ops_bot",
        bindingGeneration: 1,
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:00:00.000Z",
      };
      connections = [connection];
      return Response.json({ connection }, { status: 201 });
    }
    return Response.json({ code: "not_found", message: "no" }, { status: 404 });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

it("walks who answers, the provider's steps and the verified account", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const onOpenChats = vi.fn();
  const { api, calls } = gateway();
  render(
    <I18nProvider locale="en">
      <ChannelsTab api={api} workspaceId="ws_1" onOpenGuide={vi.fn()} onOpenChats={onOpenChats} />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
  const dialog = screen.getByRole("dialog", { name: "Connect Telegram" });
  // The default bot is preselected and says so.
  expect(within(dialog).getByLabelText("Bot that answers")).toHaveValue("bot_2");
  expect(within(dialog).getByRole("option", { name: "assistant (default Bot)" })).toBeTruthy();
  expect(within(dialog).getByText("Who answers").closest("li")).toHaveAttribute(
    "aria-current",
    "step",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));

  const steps = within(dialog).getByRole("list", { name: "Steps on the channel's side" });
  expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
  const link = within(steps).getByRole("link", { name: /Open BotFather/ });
  expect(link).toHaveAttribute("href", "https://t.me/BotFather");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(within(steps).getByText("/api/channel-webhooks/ws_1/telegram")).toBeTruthy();
  fireEvent.click(within(steps).getByRole("button", { name: "Copy Webhook path" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("/api/channel-webhooks/ws_1/telegram"),
  );

  const token = within(dialog).getByLabelText("Bot token");
  expect(token).toHaveAccessibleDescription("The token BotFather sent.");
  fireEvent.change(token, { target: { value: "123:abc" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

  expect(await within(dialog).findByText("Connected as @ops_bot.")).toBeTruthy();
  expect(within(dialog).getByText("Answered by assistant")).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: /Open in Telegram/ })).toHaveAttribute(
    "href",
    "https://t.me/ops_bot",
  );
  expect(calls.find((call) => call.path.endsWith("/connect"))?.body).toEqual({
    method: "token",
    botId: "bot_2",
    config: { token: "123:abc" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Go to Chats" }));
  expect(onOpenChats).toHaveBeenCalled();
});

it("keeps typed details and says nothing was saved when the provider refuses", async () => {
  const { api } = gateway();
  const refusing = {
    ...api,
    connectChannel: vi.fn(async () => {
      throw new Error("that is not a Telegram bot token");
    }),
  };
  render(
    <I18nProvider locale="en">
      <ChannelsTab
        api={refusing as never}
        workspaceId="ws_1"
        onOpenGuide={vi.fn()}
        onOpenChats={vi.fn()}
      />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not connected: that is not a Telegram bot token. Check the details and try again; nothing was saved.",
  );
  expect(screen.getByLabelText("Bot token")).toHaveValue("wrong");
});

it("shows a translated step in another language", async () => {
  const { api } = gateway();
  render(
    <I18nProvider locale="zh-CN">
      <ChannelsTab api={api} workspaceId="ws_1" onOpenGuide={vi.fn()} onOpenChats={vi.fn()} />
    </I18nProvider>,
  );
  fireEvent.click((await screen.findAllByRole("button", { name: /Telegram/ }))[0] as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.queryByText("In Telegram, open @BotFather and send /newbot.")).toBeNull();
  expect(screen.getByText(/BotFather/, { selector: "p" })).toBeTruthy();
});

it("locks submitted channel details and prevents duplicate connection attempts", async () => {
  const { api } = gateway();
  let rejectConnect: (error: Error) => void = () => {};
  const connect = vi.spyOn(api, "connectChannel").mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
  );
  render(
    <I18nProvider locale="en">
      <ChannelsTab api={api} workspaceId="ws_1" onOpenGuide={vi.fn()} onOpenChats={vi.fn()} />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  const token = screen.getByLabelText("Bot token");
  fireEvent.change(token, { target: { value: "test-token" } });
  const form = token.closest("form") as HTMLFormElement;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(connect).toHaveBeenCalledOnce();
  expect(token).toBeDisabled();
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  await act(async () => {
    rejectConnect(new Error("Connection unavailable"));
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable");
  expect(token).toBeEnabled();
  expect(token).toHaveValue("test-token");
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("Connected as @ops_bot.");
  expect(connect).toHaveBeenCalledTimes(2);
});
