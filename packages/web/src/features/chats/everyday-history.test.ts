import type { RunId } from "@deskmates/contracts";
import { expect, it } from "vitest";
import { EMPTY_THREAD_VIEW, transcriptTimeline } from "../../state/thread-view.js";
import { approval, approvalMessage, message, run } from "../../test-support/fixtures.js";
import { currentFailure, everydayHistory } from "./everyday-history.js";

const failed = run({ status: "failed", roundMessageIds: ["msg_1"] });
const state = { ...EMPTY_THREAD_VIEW, runs: { [failed.id]: failed } };
const next = (extra: Parameters<typeof run>[0] = {}) =>
  run({ id: "run_next" as RunId, createdAt: "2026-09-21T10:01:00.000Z", ...extra });

it("keeps an unresolved failure, but a retry's current progress replaces its old attempt", () => {
  expect(currentFailure(failed, state)).toBe(true);
  for (const status of ["running", "waiting_approval", "succeeded"] as const) {
    const retry = next({ status });
    expect(currentFailure(failed, { ...state, runs: { ...state.runs, [retry.id]: retry } })).toBe(
      false,
    );
  }
});

it("never equates another bot, unrelated success, silent exit or model job with recovery", () => {
  for (const changed of [
    { botId: "bot_other" as typeof failed.botId },
    { triggerRef: "msg_other" },
    { status: "silent" as const },
    { config: { runType: "activity_summary" } },
  ]) {
    const successor = next({ status: "succeeded", ...changed });
    expect(
      currentFailure(failed, { ...state, runs: { ...state.runs, [successor.id]: successor } }),
    ).toBe(true);
  }
  const sharedRound = next({
    triggerRef: "msg_system",
    status: "succeeded",
    roundMessageIds: ["msg_1"],
  });
  expect(
    currentFailure(failed, { ...state, runs: { ...state.runs, [sharedRound.id]: sharedRound } }),
  ).toBe(false);
});

it("moves prior-request errors and system history to Tune without changing source records", () => {
  const messages = [
    message(1, "system", "Memory updated"),
    message(2, "human", "Next request", { ts: "2026-09-21T10:02:00.000Z" }),
  ];
  const original = { ...state, messages };
  const full = transcriptTimeline(original);
  expect(full).toHaveLength(3);
  expect(everydayHistory(full, original).map((item) => item.kind)).toEqual(["message"]);
  expect(everydayHistory(full, original, "msg_1")).toHaveLength(2);
  expect(original.runs[failed.id]?.status).toBe("failed");
  expect(original.messages).toBe(messages);
});

it("keeps approvals for compact receipts, hides elsewhere activity", () => {
  const approvalRow = approval();
  const original = {
    ...EMPTY_THREAD_VIEW,
    messages: [approvalMessage(1, "Needs decision", approvalRow.id)],
  };
  const full = transcriptTimeline(original, false, [next({ status: "succeeded" })]);
  expect(everydayHistory(full, original)).toHaveLength(1);
  expect(
    everydayHistory(full, { ...original, approvals: { [approvalRow.id]: approvalRow } }),
  ).toHaveLength(1);
  expect(
    everydayHistory(full, {
      ...original,
      approvals: { [approvalRow.id]: { ...approvalRow, decision: "allow_once" } },
    }),
  ).toHaveLength(1);
});

it("keeps a current routing blocker, then removes the old reminder after work progresses", () => {
  for (const body of [
    "No member replied to message #1: ops ended without a reply. Mention a member to assign it.",
    "ops is paused and was not woken by message #1. A paused bot reads what it missed.",
    "@analyst was not delivered: recipient is not configured in this bot's message allowlist.",
    "assistant's handoff to analyst was not delivered: the recipient bot is paused.",
  ]) {
    const blocked = {
      ...EMPTY_THREAD_VIEW,
      messages: [message(1, "human", "Report"), message(2, "system", body)],
    };
    expect(everydayHistory(transcriptTimeline(blocked), blocked)).toHaveLength(2);
    const advanced = {
      ...blocked,
      messages: [...blocked.messages, message(3, "bot", "The report is ready")],
    };
    expect(everydayHistory(transcriptTimeline(advanced), advanced)).toHaveLength(2);
  }
});

it("keeps a Guest's failed status answer, which is their work, not an internal job", () => {
  const inquiry = run({ status: "failed", config: { runType: "status_inquiry" } });
  expect(currentFailure(inquiry, { ...EMPTY_THREAD_VIEW, runs: { [inquiry.id]: inquiry } })).toBe(
    true,
  );
  const job = run({ status: "failed", config: { runType: "activity_summary" } });
  expect(currentFailure(job, { ...EMPTY_THREAD_VIEW, runs: { [job.id]: job } })).toBe(false);
});
