import type { BotDefinition } from "@deskmates/contracts";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { BotSchedules } from "./bot-schedules.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const bot = {
  id: "bot_1",
  workspaceId: "ws_1",
  name: "triage",
  role: "Support",
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [{ schedule: "0 9 * * 1-5", prompt: "Check queue" }],
  createdAt: "2026-09-23T00:00:00.000Z",
} as unknown as BotDefinition;

it("edits schedules using the existing cron array and shows Gateway timezone", async () => {
  const updateBot = vi.fn(
    async (_id: string, patch: { cron?: { schedule: string; prompt: string }[] }) => ({
      ...bot,
      cron: patch.cron ?? bot.cron,
    }),
  );
  const onSaved = vi.fn();
  render(
    <BotSchedules
      api={{ updateBot } as unknown as ApiClient}
      bot={bot}
      timeZone="Asia/Taipei"
      onSaved={onSaved}
    />,
  );

  expect(screen.getByText("Asia/Taipei")).toBeTruthy();
  expect(screen.getByText(/Next occurrence:/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Scheduled instruction 1"), {
    target: { value: "Review issues" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save schedules" }));
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith("bot_1", {
      cron: [{ schedule: "0 9 * * 1-5", prompt: "Review issues" }],
    }),
  );
  expect(onSaved).toHaveBeenCalled();
});

it("rejects invalid drafts before an API mutation and removes entries through PATCH", async () => {
  const updateBot = vi.fn(
    async (_id: string, patch: { cron?: { schedule: string; prompt: string }[] }) => ({
      ...bot,
      cron: patch.cron ?? [],
    }),
  );
  render(
    <BotSchedules
      api={{ updateBot } as unknown as ApiClient}
      bot={bot}
      timeZone="UTC"
      onSaved={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Cron expression 1"), { target: { value: "bad cron" } });
  fireEvent.click(screen.getByRole("button", { name: "Save schedules" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(updateBot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove schedule 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Save schedules" }));
  await waitFor(() => expect(updateBot).toHaveBeenCalledWith("bot_1", { cron: [] }));
});

it("keeps an unsaved draft when the bot detail is closed and reopened", () => {
  const api = { updateBot: vi.fn() } as unknown as ApiClient;
  const first = render(<BotSchedules api={api} bot={bot} timeZone="UTC" onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Scheduled instruction 1"), {
    target: { value: "Draft" },
  });
  first.unmount();
  render(<BotSchedules api={api} bot={bot} timeZone="UTC" onSaved={vi.fn()} />);
  expect((screen.getByLabelText("Scheduled instruction 1") as HTMLTextAreaElement).value).toBe(
    "Draft",
  );
});

it("advances the next occurrence after a minute passes without discarding the draft", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T16:00:30Z"));
  render(
    <BotSchedules
      api={{ updateBot: vi.fn() } as unknown as ApiClient}
      bot={{ ...bot, cron: [{ schedule: "* * * * *", prompt: "Minute check" }] }}
      timeZone="Asia/Taipei"
      onSaved={vi.fn()}
    />,
  );
  const nextAt = (iso: string) =>
    `Next occurrence: ${new Date(iso).toLocaleString(undefined, {
      timeZone: "Asia/Taipei",
      timeZoneName: "short",
    })}`;
  fireEvent.change(screen.getByLabelText("Scheduled instruction 1"), {
    target: { value: "Retain this unsaved instruction" },
  });
  expect(screen.getByText(nextAt("2026-10-02T16:01:00Z"))).toBeTruthy();
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByText(nextAt("2026-10-02T16:02:00Z"))).toBeTruthy();
  expect((screen.getByLabelText("Scheduled instruction 1") as HTMLTextAreaElement).value).toBe(
    "Retain this unsaved instruction",
  );
});

it("refreshes the next occurrence when a suspended page becomes visible", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T16:00:30Z"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  render(
    <BotSchedules
      api={{ updateBot: vi.fn() } as unknown as ApiClient}
      bot={{ ...bot, cron: [{ schedule: "* * * * *", prompt: "Minute check" }] }}
      timeZone="UTC"
      onSaved={vi.fn()}
    />,
  );
  vi.setSystemTime(new Date("2026-10-02T16:07:30Z"));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const at = new Date("2026-10-02T16:08:00Z").toLocaleString(undefined, {
    timeZone: "UTC",
    timeZoneName: "short",
  });
  expect(screen.getByText(`Next occurrence: ${at}`)).toBeTruthy();
});
