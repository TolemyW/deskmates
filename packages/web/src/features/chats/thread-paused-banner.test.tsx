// @vitest-environment jsdom
// T1 (in-process): the paused state of a conversation (ADR-0005 amendment 3). A turn-budget
// pause shows when it resumes by itself (rewritten decisions 21 and 22), in every UI locale; an
// operator pause says so; Resume is offered to whoever may take it (decision 23), and the chat
// pane sends it and keeps a human message from ending an operator pause (decision 24).

import { type Thread, UI_LOCALES } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { formatTime } from "../../format.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { createI18n, englishI18n, setCurrentI18n } from "../../i18n/intl.js";
import {
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { ThreadPausedBanner, humanMessageResumes, minutesUntil } from "./thread-paused-banner.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const RESUME = "2026-10-17T12:30:00.000Z";

const budgetPaused: Thread = {
  ...thread,
  status: "paused",
  pauseReason: "turn_budget",
  pausedAt: "2026-10-17T11:30:00.000Z",
  resumeAt: RESUME,
};
const operatorPaused: Thread = { ...thread, status: "paused", pauseReason: "operator" };

/** The locale's formatter, also made current so `formatTime` speaks that locale. */
function inLocale(locale: (typeof UI_LOCALES)[number]) {
  const i18n = createI18n(locale);
  setCurrentI18n(i18n);
  return i18n.t;
}

describe("ThreadPausedBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    setCurrentI18n(englishI18n());
  });

  it.each(UI_LOCALES)("shows when a turn-budget pause resumes by itself (%s)", (locale) => {
    const t = inLocale(locale);
    const expected = t("chatPane.paused.turnBudget", { time: formatTime(RESUME), minutes: 30 });
    render(
      <I18nProvider locale={locale}>
        <ThreadPausedBanner thread={budgetPaused} />
      </I18nProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain(expected);
    // Nobody may Resume here: no button.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each(UI_LOCALES)("says an operator paused it, and offers Resume (%s)", (locale) => {
    const t = inLocale(locale);
    const onResume = vi.fn();
    render(
      <I18nProvider locale={locale}>
        <ThreadPausedBanner thread={operatorPaused} onResume={onResume} />
      </I18nProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain(t("chatPane.paused.operator"));
    fireEvent.click(screen.getByRole("button", { name: t("chatPane.resume") }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("says a pause past its resume time resumes within a minute, and nothing when active", () => {
    const { rerender } = render(
      <I18nProvider locale="en">
        <ThreadPausedBanner thread={{ ...budgetPaused, resumeAt: "2026-10-17T11:59:00.000Z" }} />
      </I18nProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain("resumes by itself within a minute");
    rerender(
      <I18nProvider locale="en">
        <ThreadPausedBanner thread={thread} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("knows which pauses a human message ends", () => {
    expect(humanMessageResumes(budgetPaused)).toBe(true);
    expect(humanMessageResumes(operatorPaused)).toBe(false);
    expect(humanMessageResumes(thread)).toBe(false);
    expect(minutesUntil(RESUME, NOW)).toBe(30);
    expect(minutesUntil(RESUME, NOW + 3_600_000)).toBe(0);
  });
});

describe("the chat pane with a paused conversation", () => {
  beforeEach(() => {
    installFakeEventSource();
  });
  afterEach(() => cleanup());

  function renderPane(subject: Thread) {
    const resumed: Thread = { ...thread, budgetResetSeq: 3 };
    const { fetch, calls } = fakeFetch({
      "GET /api/threads/thr_1": { thread: subject, members },
      "PATCH /api/threads/thr_1": { thread: resumed, members },
      "GET /api/threads/thr_1/messages": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/rounds": { rounds: [] },
    });
    render(
      <I18nProvider locale="en">
        <ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />
      </I18nProvider>,
    );
    return calls;
  }

  it("resumes an operator pause with Resume, and says a message will not wake anyone", async () => {
    const calls = renderPane(operatorPaused);
    expect(await screen.findByText(/An operator paused this chat\. Messages/)).toBeTruthy();
    expect(screen.getByTestId("operator-paused-notice").textContent).toContain(
      "will not wake any bot",
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            (c.body as { status?: string } | undefined)?.status === "active",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId("operator-paused-notice")).toBeNull());
  });

  it("shows the resume time of a turn-budget pause", async () => {
    renderPane({ ...budgetPaused, resumeAt: new Date(Date.now() + 20 * 60_000).toISOString() });
    expect(await screen.findByText(/It resumes by itself at .+ \(in about 20 min\)/)).toBeTruthy();
    expect(screen.queryByTestId("operator-paused-notice")).toBeNull();
  });
});
