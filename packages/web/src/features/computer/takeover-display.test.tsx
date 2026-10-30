// @vitest-environment jsdom
import type { BotId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { rfbOpenings } from "../../test-support/fake-rfb.js";
import { BOT_ID, WS_ID, fakeFetch, screenTicket } from "../../test-support/fixtures.js";
import { TakeoverDisplay } from "./takeover-display.js";

vi.mock("@novnc/novnc", async () => {
  const { FakeRfb } = await import("../../test-support/fake-rfb.js");
  return {
    default: class extends FakeRfb {
      constructor(target: HTMLElement, url: string, options?: Record<string, unknown>) {
        super(target, url, options);
        const canvas = document.createElement("canvas");
        canvas.width = options?.wsProtocols?.toString() === "shared" ? 3840 : 1280;
        canvas.height = 720;
        target.append(canvas);
      }
    },
  };
});
afterEach(() => {
  cleanup();
  rfbOpenings.length = 0;
  vi.restoreAllMocks();
});
const second = "bot_2" as BotId;
function fixture(state = "ready") {
  return fakeFetch({
    "GET /api/bots/bot_1/screen": { botId: BOT_ID, workspaceId: WS_ID, state, humanHeld: true },
    "GET /api/bots/bot_2/screen": {
      botId: second,
      workspaceId: WS_ID,
      state: "ready",
      humanHeld: true,
    },
    "POST /api/bots/bot_1/screen/access": screenTicket({ protocol: "first" }),
    "POST /api/bots/bot_2/screen/access": screenTicket({ protocol: "second" }),
    "POST /api/workspaces/ws_1/takeover/open-screen": screenTicket({ protocol: "shared" }),
    "POST /api/screen-access/acc_1/close": { closed: true },
  });
}
it("switches bot regions and the explicit overview without retaking or releasing the workspace", async () => {
  const { fetch, calls } = fixture();
  const { container } = render(
    <TakeoverDisplay
      api={createApiClient({ fetch })}
      workspaceId={WS_ID}
      members={[
        { botId: BOT_ID, name: "Assistant" },
        { botId: second, name: "Analyst" },
      ]}
    />,
  );
  await waitFor(() => expect(rfbOpenings).toHaveLength(1));
  expect(rfbOpenings[0]?.options).toEqual({ wsProtocols: ["first"] });
  expect(rfbOpenings[0]?.viewOnly).toBe(false);
  const picker = screen.getByRole("combobox", { name: "Screen" });
  fireEvent.change(picker, { target: { value: second } });
  await waitFor(() => expect(rfbOpenings).toHaveLength(2));
  expect(rfbOpenings[0]?.disconnected).toBe(true);
  expect(rfbOpenings[1]?.options).toEqual({ wsProtocols: ["second"] });
  fireEvent.change(picker, { target: { value: "workspace" } });
  await waitFor(() => expect(rfbOpenings).toHaveLength(3));
  expect(rfbOpenings[1]?.disconnected).toBe(true);
  expect(rfbOpenings[2]?.options).toEqual({ wsProtocols: ["shared"] });
  await waitFor(() =>
    expect(
      container
        .querySelector<HTMLElement>(".desktop-frame")
        ?.style.getPropertyValue("--desktop-ratio"),
    ).toBe(String(3840 / 720)),
  );
  // A legacy/custom framebuffer resize changes only local layout, never the remote desktop.
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("missing framebuffer");
  canvas.height = 1600;
  await waitFor(() =>
    expect(
      container
        .querySelector<HTMLElement>(".desktop-frame")
        ?.style.getPropertyValue("--desktop-ratio"),
    ).toBe("2.4"),
  );
  expect(calls.some((call) => /\/(takeover|handback)$/.test(call.path))).toBe(false);
  expect(
    calls.filter((call) => call.path.endsWith("/screen/access")).map((call) => call.body),
  ).toEqual([{ mode: "control" }, { mode: "control" }]);
});
it("labels a legacy region fallback without silently allocating or starting a desktop", async () => {
  const { fetch, calls } = fixture("legacy");
  render(
    <TakeoverDisplay
      api={createApiClient({ fetch })}
      workspaceId={WS_ID}
      members={[{ botId: BOT_ID, name: "Assistant" }]}
    />,
  );
  await screen.findByText(/This Bot’s region is not ready/);
  await waitFor(() => expect(rfbOpenings[0]?.options).toEqual({ wsProtocols: ["shared"] }));
  expect(
    calls.some((call) => call.path.endsWith("/start") || call.path.endsWith("/screen/access")),
  ).toBe(false);
});
it("shows status errors instead of opening a different screen, and supports retry", async () => {
  const { fetch, calls } = fixture();
  let first = true;
  const api = createApiClient({ fetch });
  const original = api.getBotScreen;
  vi.spyOn(api, "getBotScreen").mockImplementation(async (id) => {
    if (first) {
      first = false;
      throw new Error("screen status unavailable");
    }
    return original(id);
  });
  render(
    <TakeoverDisplay
      api={api}
      workspaceId={WS_ID}
      members={[{ botId: BOT_ID, name: "Assistant" }]}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain("screen status unavailable");
  expect(rfbOpenings).toHaveLength(0);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(rfbOpenings[0]?.options).toEqual({ wsProtocols: ["first"] }));
});
