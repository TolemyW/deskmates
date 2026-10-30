// @vitest-environment jsdom
// A multi-account QR provider must retain the pairing surface after the setup dialog closes.
import "@testing-library/jest-dom/vitest";
import type {
  BotDefinition,
  ChannelConnection,
  ChannelPluginManifestV2,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ConnectionItem } from "./channel-connections.js";

afterEach(cleanup);
const plugin: ChannelPluginManifestV2 = {
  apiVersion: 2,
  id: "wechat",
  version: "1.0.0",
  displayName: "WeChat",
  description: "Private text",
  multipleConnections: true,
  capabilities: {
    directMessages: "available",
    groups: "unavailable",
    inboundImages: "disabled",
    inboundOtherMedia: "disabled",
    outboundReply: "available",
    proactiveMessages: "unavailable",
    streaming: "unavailable",
    approvals: "available",
    testMessage: "unavailable",
  },
  methods: [
    { id: "qr", identity: "link", label: "Scan with WeChat", description: "Scan", fields: [] },
  ],
  statusVocabulary: ["qr", "connected"],
};
const connection = {
  id: "chn_wechat",
  workspaceId: "ws_1",
  pluginId: "wechat",
  pluginVersion: "1.0.0",
  botId: "bot_1",
  method: "qr",
  config: {},
  status: { phase: "qr", qr: "data:image/png;base64,AAAA" },
} as ChannelConnection;

function show(canConnect: boolean) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ connection }),
  );
  render(
    <I18nProvider locale="en">
      <ul>
        <ConnectionItem
          api={createApiClient({ fetch: fetcher })}
          workspaceId={"ws_1" as WorkspaceId}
          plugin={plugin}
          connection={connection}
          bots={[{ id: "bot_1", name: "Helper" } as BotDefinition]}
          canConnect={canConnect}
          onChanged={async () => {}}
        />
      </ul>
    </I18nProvider>,
  );
  return fetcher;
}
it("shows the answering bot and QR after reconnect/relink without needing a token field", async () => {
  const fetcher = show(true);
  expect(screen.getByText("Answered by Helper")).toBeTruthy();
  expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
  const form = screen.getByRole("button", { name: "Link again" }).closest("form");
  expect(form).toBeTruthy();
  fireEvent.submit(form as HTMLFormElement);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("chn_wechat");
});
it("does not expose the pairing code to a read-only member", () => {
  show(false);
  expect(screen.queryByRole("img")).toBeNull();
});
