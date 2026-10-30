// @vitest-environment jsdom
// ADR-0043 on the bot's pages: the profile fields and pause, SOUL/MEMORY versions with diff and
// restore and "last run used", the diary with line deletes, "Run now" on a saved schedule.

import type {
  BotDefinition,
  BotRuleVersion,
  BotRuleVersionList,
  CronEntry,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { BotDiary } from "./bot-diary.js";
import { BotIdentity } from "./bot-identity.js";
import { BotSchedules } from "./bot-schedules.js";
import { RuleVersions } from "./rule-versions.js";

afterEach(() => {
  cleanup();
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
  cron: [{ schedule: "0 9 * * 1-5", prompt: "Check queue" }] as CronEntry[],
  createdAt: "2026-09-23T00:00:00.000Z",
} as unknown as BotDefinition;
const peer = { ...bot, id: "bot_2", name: "ledger" } as BotDefinition;

describe("BotIdentity", () => {
  it("saves only the changed fields, allowlist from the workspace's bots", async () => {
    const updateBot = vi.fn(async (_id: string, patch: object) => ({ ...bot, ...patch }));
    const onSaved = vi.fn();
    render(
      <BotIdentity
        api={{ updateBot, listBots: async () => [bot, peer] } as unknown as ApiClient}
        bot={bot}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText("One-line job"), { target: { value: "Escalations" } });
    fireEvent.click(await screen.findByLabelText("ledger"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(updateBot).toHaveBeenCalledWith("bot_1", {
        role: "Escalations",
        messageAllowlist: ["ledger"],
      }),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByText("Saved. The Bot uses this when it starts its next work.")).toBeTruthy();
  });

  it("pauses and resumes with one switch, saying what pausing does", async () => {
    const updateBot = vi.fn(async (_id: string, patch: { paused?: boolean }) =>
      patch.paused ? { ...bot, pausedAt: "2026-10-15T09:00:00.000Z", pausedBy: "human:web" } : bot,
    );
    const { rerender } = render(
      <BotIdentity
        api={{ updateBot, listBots: async () => [] } as unknown as ApiClient}
        bot={bot}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText(/schedules, other apps and chat messages are skipped/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(updateBot).toHaveBeenCalledWith("bot_1", { paused: true }));
    rerender(
      <BotIdentity
        api={{ updateBot, listBots: async () => [] } as unknown as ApiClient}
        bot={{ ...bot, pausedAt: "2026-10-15T09:00:00.000Z", pausedBy: "human:web" }}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(updateBot).toHaveBeenCalledWith("bot_1", { paused: false }));
  });
});

describe("RuleVersions", () => {
  const versions: BotRuleVersion[] = [
    {
      file: "soul",
      version: 1,
      body: "You are terse.",
      bodySha256: "a",
      bytes: 14,
      createdBy: "human:web",
      createdAt: "2026-10-14T09:00:00.000Z",
    },
    {
      file: "soul",
      version: 2,
      body: "You are warm.",
      bodySha256: "b",
      bytes: 13,
      createdBy: "human:web",
      createdAt: "2026-10-15T09:00:00.000Z",
    },
  ];
  const list: BotRuleVersionList = {
    file: "soul",
    versions: [...versions].reverse().map(({ body: _b, ...rest }) => rest),
    lastRun: { runId: "run_1", version: 1 },
  };

  it("names the version the last run used, diffs two and restores as a new version", async () => {
    const restoreRuleVersion = vi.fn(async () => ({
      body: "You are terse.",
      version: "hash-3",
      revision: 3,
      appliesFromNextRun: true,
    }));
    const onRestored = vi.fn();
    render(
      <RuleVersions
        api={
          {
            listRuleVersions: async () => list,
            getRuleVersion: async (_bot: string, _file: string, n: number) =>
              versions.find((v) => v.version === n),
            restoreRuleVersion,
          } as unknown as ApiClient
        }
        bot={bot}
        file="soul"
        currentVersion="hash-2"
        refreshKey="hash-2"
        onRestored={onRestored}
      />,
    );
    expect(await screen.findByText("last work used v1")).toBeTruthy();
    const diff = await screen.findByLabelText("Changes from v1 to v2");
    expect(within(diff).getByText(/- You are terse\./)).toBeTruthy();
    expect(within(diff).getByText(/\+ You are warm\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore v1" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(restoreRuleVersion).toHaveBeenCalledWith("bot_1", "soul", 1, "hash-2"),
    );
    expect(onRestored).toHaveBeenCalled();
    expect(
      await screen.findByText(/Version 1 restored as version 3\. The Bot is busy/),
    ).toBeTruthy();
  });
});

describe("BotDiary", () => {
  it("shows the newest day and deletes one line with its text and the day's version", async () => {
    const day = { day: "2026-10-15", lines: ["- 09:00 one", "- 10:00 two"], version: "v1" };
    const deleteDiaryLine = vi.fn(async () => ({ ...day, lines: ["- 10:00 two"], version: "v2" }));
    render(
      <BotDiary
        api={
          {
            listDiaryDays: async () => [{ day: "2026-10-15", bytes: 24 }],
            readDiaryDay: async () => day,
            deleteDiaryLine,
          } as unknown as ApiClient
        }
        bot={bot}
      />,
    );
    expect(await screen.findByText("- 09:00 one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteDiaryLine).toHaveBeenCalledWith("bot_1", "2026-10-15", {
        line: 0,
        text: "- 09:00 one",
        version: "v1",
      }),
    );
    await waitFor(() => expect(screen.queryByText("- 09:00 one")).toBeNull());
  });
});

describe("Run now", () => {
  it("starts a saved schedule now, and waits for a save or a resume", async () => {
    const runCronNow = vi.fn(async () => ({ id: "run_1" }));
    const { rerender } = render(
      <BotSchedules
        api={{ runCronNow, updateBot: vi.fn() } as unknown as ApiClient}
        bot={bot}
        timeZone="UTC"
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start schedule 1 now" }));
    await waitFor(() => expect(runCronNow).toHaveBeenCalledWith("bot_1", 0));
    expect(await screen.findByText(/Schedule 1 started/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Scheduled instruction 1"), {
      target: { value: "Changed" },
    });
    expect(
      (screen.getByRole("button", { name: "Start schedule 1 now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(
      <BotSchedules
        api={{ runCronNow, updateBot: vi.fn() } as unknown as ApiClient}
        bot={{ ...bot, pausedAt: "2026-10-15T09:00:00.000Z" }}
        timeZone="UTC"
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText(/The Bot is paused/)).toBeTruthy();
  });
});
