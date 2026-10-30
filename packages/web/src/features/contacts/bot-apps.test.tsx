// @vitest-environment jsdom
// T0, ADR-0055 decisions 5 and 6: a bot's "Apps this Bot may use" saves every app (null) or a
// chosen list, is read-only for a Member, says it is not a boundary between bots, and is absent
// where no integration runtime is configured.

import "@testing-library/jest-dom/vitest";
import type { BotDefinition } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { bot as fixtureBot } from "../../test-support/fixtures.js";
import { BotApps } from "./bot-apps.js";

afterEach(cleanup);

function fakeApi(configured = true) {
  const updateBot = vi.fn(async (_id: string, patch: { integrationApps?: string[] | null }) => ({
    ...fixtureBot,
    ...(patch.integrationApps ? { integrationApps: patch.integrationApps } : {}),
  }));
  const api = {
    getIntegrations: vi.fn(async () => ({
      configured,
      oauthAvailable: true,
      providers: [
        { service: "gmail", displayName: "Gmail", authKinds: ["oauth"], adoptedAt: "x" },
        { service: "github", displayName: "GitHub", authKinds: ["oauth"], adoptedAt: "x" },
      ],
    })),
    getIntegrationCatalog: vi.fn(async () => ({
      configured,
      complete: true,
      providers: [
        { service: "gmail", displayName: "Gmail", authKinds: ["oauth"], adopted: true },
        { service: "github", displayName: "GitHub", authKinds: ["oauth"], adopted: true },
        { service: "jira", displayName: "Jira", authKinds: ["oauth"], adopted: false },
      ],
    })),
    listIntegrationConnections: vi.fn(async () => ({
      connections: [],
      offset: 0,
      limit: 1,
      total: 1,
      liveByService: [{ service: "gmail", count: 1 }],
    })),
    updateBot,
  } as unknown as ApiClient;
  return { api, updateBot };
}

it("saves a chosen list, then every app again", async () => {
  const { api, updateBot } = fakeApi();
  const onSaved = vi.fn();
  render(<BotApps api={api} bot={fixtureBot as BotDefinition} onSaved={onSaved} />);
  expect(await screen.findByRole("heading", { name: "Apps this Bot may use" })).toBeTruthy();
  expect(screen.getByLabelText("All connected apps")).toBeChecked();
  expect(screen.getByRole("button", { name: "Save apps" })).toBeDisabled();
  expect(screen.getByText(/A teammate that may use an app can still be asked to act/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Only these apps"));
  // Connected apps first; an enabled app not connected yet says so; a disabled one is absent.
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
    " Gmail",
    " GitHub · not connected yet",
  ]);
  expect(screen.getByText(/this Bot will not be offered any app/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Gmail"));
  fireEvent.click(screen.getByRole("button", { name: "Save apps" }));
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(fixtureBot.id, { integrationApps: ["gmail"] }),
  );
  expect(await screen.findByText("Saved. The next run uses these apps.")).toBeTruthy();
  expect(onSaved).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save apps" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("All connected apps"));
  fireEvent.click(screen.getByRole("button", { name: "Save apps" }));
  await waitFor(() =>
    expect(updateBot).toHaveBeenLastCalledWith(fixtureBot.id, { integrationApps: null }),
  );
});

it("is read-only for a Member, with the role that can change it", async () => {
  const { api } = fakeApi();
  render(
    <SessionRolesProvider roles={{ tenantRole: "member", platformMaintainer: false }}>
      <BotApps api={api} bot={fixtureBot as BotDefinition} onSaved={vi.fn()} />
    </SessionRolesProvider>,
  );
  expect(await screen.findByLabelText("All connected apps")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save apps" })).toBeDisabled();
  expect(
    screen.getByText(/Only an Admin or Owner can choose which apps a Bot may use/),
  ).toBeTruthy();
});

it("shows nothing where no integration runtime is configured", async () => {
  const { api } = fakeApi(false);
  const { container } = render(
    <BotApps api={api} bot={fixtureBot as BotDefinition} onSaved={vi.fn()} />,
  );
  await waitFor(() => expect(api.getIntegrations).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.textContent).toBe("");
});

it("shows a failed app read and retries without changing bot configuration", async () => {
  const { api, updateBot } = fakeApi();
  vi.spyOn(api, "listIntegrationConnections").mockRejectedValueOnce(new Error("Apps unavailable"));
  render(<BotApps api={api} bot={fixtureBot as BotDefinition} onSaved={vi.fn()} />);
  expect(screen.getByText("Loading apps…")).toBeTruthy();
  expect(await screen.findByRole("alert")).toHaveTextContent("Apps unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry apps" }));
  await screen.findByLabelText("All connected apps");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(updateBot).not.toHaveBeenCalled();
});
