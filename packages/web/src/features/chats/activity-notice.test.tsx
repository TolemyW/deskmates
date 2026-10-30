// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EMPTY_THREAD_VIEW, transcriptTimeline } from "../../state/thread-view.js";
import { message } from "../../test-support/fixtures.js";
import { ActivityNoticeRow, activityNotice } from "./activity-notice.js";
import { everydayHistory } from "./everyday-history.js";
afterEach(cleanup);
const memory = message(
  1,
  "system",
  "Memory update: 1 item(s) need human confirmation. 2 item(s) were not applied as current memory. 3 item(s) were saved as untrusted and are excluded from automatic context. These items are not confirmed saved preferences or facts.",
);
it("keeps the receipt in Use and accurately distinguishes pending, unapplied and untrusted memory", () => {
  const notice = activityNotice(memory);
  expect(notice).toEqual({ kind: "memory", gated: 1, excluded: 2, untrusted: 3 });
  if (!notice) throw new Error("missing notice");
  const state = { ...EMPTY_THREAD_VIEW, messages: [memory] };
  expect(everydayHistory(transcriptTimeline(state), state)).toHaveLength(1);
  const { container } = render(
    <ActivityNoticeRow message={memory} notice={notice} bots={undefined} reveal />,
  );
  expect(screen.getByText("Memory needs review")).toBeVisible();
  expect(container.textContent).toContain("unverified and excluded from automatic context");
  expect(container.textContent).not.toContain("Memory updated");
  expect(screen.getByRole("link", { name: "Review observations" })).toHaveAttribute(
    "href",
    "#/knowledge/observations",
  );
  expect(memory.body).toContain("Memory update:");
});
it("never treats human or bot prose, unknown system text or an attached approval as a routine receipt", () => {
  for (const author of ["human", "bot"] as const)
    expect(activityNotice({ ...memory, authorKind: author })).toBeUndefined();
  expect(activityNotice(message(2, "system", "Memory update: something failed"))).toBeUndefined();
  expect(
    activityNotice({
      ...memory,
      attachments: [{ name: "approval", ref: "apr_1", mimeType: "application/json" }],
    }),
  ).toBeUndefined();
});
it("shows created teammate's role as escaped text in a compact disclosure", () => {
  const source = message(2, "system", "@assistant created @researcher (<script>bad()</script>).");
  const notice = activityNotice(source);
  if (!notice) throw new Error("missing creation");
  const { container } = render(
    <ActivityNoticeRow message={source} notice={notice} bots={undefined} reveal />,
  );
  expect(screen.getByText("Created researcher")).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("<script>bad()</script>")).toBeVisible();
});
