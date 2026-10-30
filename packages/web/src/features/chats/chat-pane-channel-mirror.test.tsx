// @vitest-environment jsdom
// T1 (in-process): ADR-0017 amendment 2 in the chat pane. A thread owned by an external chat
// channel is a read-only mirror: its history and channel identity show, but no composer, member
// controls or approval buttons; the page says replies are sent from that channel. A Web thread
// keeps its composer.

import type { Thread } from "@deskmates/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { type InterfaceView, InterfaceViewProvider } from "../../lib/interface-view.js";
import {
  type RouteTable,
  THREAD_ID,
  approval,
  approvalBody,
  approvalMessage,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";

const whatsappThread: Thread = {
  ...thread,
  channel: "whatsapp",
  externalKey: "15550001111@s.whatsapp.net",
  title: "WhatsApp 15550001111",
};

const catalog = {
  plugins: [
    {
      manifest: {
        apiVersion: 1,
        id: "whatsapp",
        version: "1.0.0",
        displayName: "WhatsApp",
        description: "",
        capabilities: { directMessages: true, groups: false, testMessage: true },
        methods: [],
        statusVocabulary: [],
      },
      state: "available",
    },
  ],
  failures: [],
};

function routes(subject: Thread, extra: RouteTable = {}): RouteTable {
  const pending = approval();
  return {
    "GET /api/threads/thr_1": { thread: subject, members },
    "GET /api/threads/thr_1/messages": {
      messages: [
        message(1, "human", "hi from my phone", { authorId: "whatsapp:15550001111" }),
        approvalMessage(2, approvalBody(pending)),
      ],
    },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [pending] },
    "GET /api/approvals?threadId=thr_1&ids=apr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/channels": catalog,
    ...extra,
  };
}

function renderPane(subject: Thread, locale: "en" | "ja" = "en", view: InterfaceView = "tune") {
  const { fetch } = fakeFetch(routes(subject));
  return render(
    <I18nProvider locale={locale}>
      <InterfaceViewProvider view={view}>
        <ChatPane
          threadId={THREAD_ID}
          api={createApiClient({ fetch })}
          infoShown={true}
          onToggleInfo={() => undefined}
        />
      </InterfaceViewProvider>
    </I18nProvider>,
  );
}

describe("a channel-bound thread is a read-only mirror", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => cleanup());

  it("shows the history and channel, no composer, member controls or approval buttons", async () => {
    renderPane(whatsappThread);

    expect(await screen.findByText("hi from my phone")).toBeTruthy();
    // The notice renders with the raw channel id first; the display name follows once the plugin
    // catalog loads, so wait for it rather than reading the first render.
    await waitFor(() =>
      expect(screen.getByTestId("channel-mirror-notice").textContent).toContain(
        "Replies are sent from WhatsApp",
      ),
    );
    expect(screen.getByTestId("thread-channel").textContent).toContain("WhatsApp");
    expect(screen.queryByRole("textbox", { name: "Message", hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send", hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add bot", hidden: true })).toBeNull();
    expect(await screen.findByTestId("approval-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once", hidden: true })).toBeNull();
    expect(screen.getByTestId("approval-read-only").textContent).toContain("Approvals");
  });

  it("explains the mirror in the selected locale", async () => {
    renderPane(whatsappThread, "ja");
    await waitFor(() =>
      expect(screen.getByTestId("channel-mirror-notice").textContent).toContain("WhatsApp"),
    );
    expect(screen.getByTestId("channel-mirror-notice").textContent).not.toContain(
      "Replies are sent from",
    );
  });

  it("keeps the composer and approval buttons on a Web thread", async () => {
    renderPane(thread);

    expect(await screen.findByRole("textbox", { name: "Message", hidden: true })).toBeTruthy();
    expect(screen.queryByTestId("channel-mirror-notice")).toBeNull();
    expect(screen.queryByTestId("thread-channel")).toBeNull();
    expect(await screen.findByRole("button", { name: "Allow once", hidden: true })).toBeTruthy();
  });

  it.each(["use", "tune"] as const)(
    "keeps internal bot collaboration and approvals read-only in %s",
    async (view) => {
      renderPane({ ...thread, kind: "bus", channel: "internal" }, "en", view);
      expect(await screen.findByText("A conversation between bots")).toBeTruthy();
      expect(screen.getByTestId("thread-channel").textContent).toBe("Bot collaboration");
      expect(screen.getByTestId("channel-mirror-notice").textContent).not.toContain("Integrations");
      expect(screen.getByTestId("channel-mirror-notice").textContent).toContain("private chat");
      expect(screen.queryByRole("textbox", { name: "Message", hidden: true })).toBeNull();
      expect(screen.queryByRole("button", { name: "Allow once", hidden: true })).toBeNull();
      const note = (await screen.findByTestId("approval-read-only")).textContent;
      expect(note).toContain("Approvals");
      expect(note).not.toContain("channel");
    },
  );
});
