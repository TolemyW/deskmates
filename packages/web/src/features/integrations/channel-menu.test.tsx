// @vitest-environment jsdom
import type { WorkspaceId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ChannelMenu } from "./channel-menu.js";
afterEach(cleanup);
it("previews commands and sends only the explicit target and button choice", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ commands: [{ command: "help", description: "Help" }], menuButton: "web_app" }),
  );
  const api = createApiClient({ fetch: fetcher });
  render(
    <I18nProvider locale="en">
      <ChannelMenu
        api={api}
        workspaceId={"ws_1" as WorkspaceId}
        connectionId="conn-1"
        commands={[{ command: "help", description: "Help" }]}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByText("Command menu"));
  expect(screen.getByText("/help")).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "chat" } });
  fireEvent.change(screen.getByLabelText("Private chat ID"), { target: { value: "42" } });
  fireEvent.change(screen.getByLabelText(/Language code/), { target: { value: "zh" } });
  fireEvent.click(screen.getByText("Synchronize this target"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const init = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]?.[1];
  expect(JSON.parse(String(init?.body))).toEqual({
    operation: "sync",
    scope: "chat",
    chatId: "42",
    languageCode: "zh",
    replaceMenuButton: false,
  });
  await waitFor(() => expect(screen.getByText(/Current menu; button type: web_app/)).toBeTruthy());
});
