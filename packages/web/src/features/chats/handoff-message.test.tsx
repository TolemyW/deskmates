// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { THREAD_LINK_ATTACHMENT_MIME, wrapUntrusted } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { message } from "../../test-support/fixtures.js";
import { HandoffMessage, handoffPresentation } from "./handoff-message.js";

const link = { name: "Open conversation", mimeType: THREAD_LINK_ATTACHMENT_MIME, ref: "thr_bus" };
const reply = 'Independent result: 76.43%. <script>alert("no")</script>';
const body = `Delegation outcome: analyst finished the work handed off with message_bot (message #1 in conversation thr_bus) (succeeded). Its reply is in this thread.\nReply:\n${wrapUntrusted("bot:analyst", reply)}`;
const receipt = () => message(3, "system", body, { attachments: [link] });
afterEach(cleanup);

it("shows the attributed result and one usable conversation link, preserving raw protocol on demand", () => {
  const source = receipt();
  const view = handoffPresentation(source);
  expect(view?.state).toBe("returned");
  if (!view) throw new Error("missing handoff");
  const original = source.body;
  const { container } = render(<HandoffMessage message={source} presentation={view} />);
  expect(screen.getByText("analyst returned a result")).toBeVisible();
  expect(screen.getByText(reply)).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).not.toContain("Delegation outcome:");
  expect(container.textContent).not.toContain("<untrusted source=");
  expect(screen.getByRole("link", { name: "Open collaboration" })).toHaveAttribute(
    "href",
    "#/threads/thr_bus",
  );
  fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
  expect(container.querySelector("pre")?.textContent).toBe(original);
  expect(source.body).toBe(original);
});

it.each(["bot", "human"] as const)(
  "never presents %s-authored protocol-like prose as a handoff",
  (author) => {
    expect(handoffPresentation(message(1, author, body, { attachments: [link] }))).toBeUndefined();
  },
);

it("requires the durable link and does not unwrap a different bot or a malformed envelope", () => {
  expect(handoffPresentation(message(1, "system", body))).toBeUndefined();
  for (const bad of [
    body.replace("bot:analyst", "bot:another"),
    body.replace("</untrusted>", ""),
  ]) {
    expect(
      handoffPresentation(message(1, "system", bad, { attachments: [link] }))?.reply,
    ).toBeUndefined();
  }
});

it.each([
  ["failed the work delegated in message #1: bad upstream. No reply was posted.", "failed"],
  ["ended the work delegated in message #1 without posting a reply (silent).", "silent"],
  ["ended the work delegated in message #1 after handing it on; no reply was posted.", "forwarded"],
  ["was stopped after exhausting its turn budget on the work delegated in message #1.", "stopped"],
])("keeps the actual outcome for %s", (tail, state) => {
  expect(
    handoffPresentation(
      message(1, "system", `Delegation outcome: analyst ${tail}`, { attachments: [link] }),
    )?.state,
  ).toBe(state);
});

it("does not let a quoted claim of success override a failed outcome", () => {
  const source = receipt();
  source.body = source.body.replace("finished the work", "failed the work");
  expect(handoffPresentation(source)?.state).toBe("failed");
});

it("recognizes a same-chat Gateway failure and suppresses only that run's duplicate", async () => {
  const { hasHandoffOutcome } = await import("./handoff-message.js");
  const failed = message(
    4,
    "system",
    "Delegation outcome: analyst failed the work delegated in message #2: upstream unavailable. No reply was posted.",
    { runId: "run_delegate" as NonNullable<ReturnType<typeof message>["runId"]> },
  );
  expect(handoffPresentation(failed)?.state).toBe("failed");
  expect(hasHandoffOutcome({ id: "run_delegate", status: "failed" }, [failed])).toBe(true);
  expect(hasHandoffOutcome({ id: "run_supervisor", status: "failed" }, [failed])).toBe(false);
  expect(hasHandoffOutcome({ id: "run_delegate", status: "stopped" }, [failed])).toBe(false);
  expect(
    hasHandoffOutcome({ id: "run_delegate", status: "failed" }, [{ ...failed, authorKind: "bot" }]),
  ).toBe(false);
});
