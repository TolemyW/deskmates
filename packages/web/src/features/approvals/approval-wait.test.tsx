// @vitest-environment jsdom
// T1 (in-process), issue #9: a pending approval card counts down to the end of the short wait,
// says plainly when the run is parked and will resume on a decision, and shows the run's latest
// screenshot as a thumbnail. A decided card shows none of it.

import type { RunEvent } from "@deskmates/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { RUN_ID, approval, fakeFetch } from "../../test-support/fixtures.js";
import { ApprovalCard } from "./approval-card.js";
import { approvalWaitState } from "./approval-wait.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CREATED = "2026-10-15T10:00:00.000Z";
const at = (seconds: number) => Date.parse(CREATED) + seconds * 1000;
const pending = approval({ createdAt: CREATED, waitMode: "live" });

describe("approval wait state (issue #9)", () => {
  it("is live until the short wait ends, then parked; the run's status wins when known", () => {
    expect(approvalWaitState(pending, undefined, at(78))).toEqual({
      kind: "live",
      remainingMs: 222_000,
    });
    expect(approvalWaitState(pending, undefined, at(300))).toEqual({ kind: "parked" });
    expect(approvalWaitState(pending, "waiting_approval_live", at(301))).toEqual({
      kind: "live",
      remainingMs: 0,
    });
    expect(approvalWaitState(pending, "waiting_approval", at(10))).toEqual({ kind: "parked" });
    expect(approvalWaitState({ ...pending, waitMode: "deferred" }, undefined, at(10))).toEqual({
      kind: "parked",
    });
    expect(approvalWaitState(pending, "cancelled", at(10))).toBeUndefined();
    expect(approvalWaitState({ ...pending, decision: "deny" }, undefined, at(10))).toBeUndefined();
  });
});

describe("approval card wait and thumbnail (issue #9)", () => {
  const shot: RunEvent = {
    runId: RUN_ID,
    seq: 7,
    kind: "screenshot",
    payload: { mimeType: "image/jpeg", base64: "AAAA", action: 2, toolUseId: "t2" },
    ts: CREATED,
  };

  function api(screenshot: RunEvent | null = shot) {
    return createApiClient({
      fetch: fakeFetch({ [`GET /api/runs/${RUN_ID}/screenshot`]: { screenshot } }).fetch,
    });
  }

  it("counts down the live wait and shows the latest screenshot", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(at(78));
    render(<ApprovalCard approval={pending} runStatus="waiting_approval_live" api={api()} />);
    const wait = screen.getByTestId("approval-wait");
    expect(wait.getAttribute("data-wait")).toBe("live");
    expect(wait.textContent).toContain("the run parks in 3 min 42 s unless someone decides");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(wait.textContent).toContain("parks in 3 min 40 s");
    vi.useRealTimers();
    const img = await screen.findByAltText("The run's latest screenshot");
    expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(img.closest("a")?.getAttribute("href")).toBe(`#/runs/${RUN_ID}`);
  });

  it("labels a parked run and shows no thumbnail when the run took none", async () => {
    render(<ApprovalCard approval={pending} runStatus="waiting_approval" api={api(null)} />);
    const wait = screen.getByTestId("approval-wait");
    expect(wait.getAttribute("data-wait")).toBe("parked");
    expect(wait.textContent).toBe("Parked: the run has stopped and resumes when someone decides.");
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  });

  it("shows nothing of the wait once decided", () => {
    render(<ApprovalCard approval={{ ...pending, decision: "allow_once" }} api={api()} />);
    expect(screen.queryByTestId("approval-wait")).toBeNull();
  });
});
