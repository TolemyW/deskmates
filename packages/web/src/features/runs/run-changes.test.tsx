// @vitest-environment jsdom
// Issue #11, ADR-0042 decision 4: "What this run changed" renders from a fixture run with learned
// items, memory written and given, approvals and task checkpoints, with exactly the two requests
// the section adds (`changes` and `memory-versions`); a terminal run offers the replay export.

import "@testing-library/jest-dom/vitest";
import type { Approval, ApprovalId, BotId, RunChanges, RunId } from "@deskmates/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approval, run } from "../../test-support/fixtures.js";
import { RunChangesSection, replayExportCommand } from "./run-changes.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fixtureRun = run({
  id: "run_audit" as RunId,
  status: "failed",
  error: "egress_blocked: shop.example.net is not in the workspace allowlist",
  failureClass: "egress_blocked",
  config: {
    model: "model-main",
    canonicalSoulVersion: 7,
    systemPromptSha256: "abcdef0123456789abcdef",
    skills: {
      version: 1,
      set: [{ skillId: "skl_1", name: "invoices", version: 3, sha256: "x" }],
    },
  },
  summary: {
    done: "tried the shop",
    reply: "",
    filesChanged: ["reports/week.md"],
    sitesVisited: ["https://shop.example.net/cart"],
    pendingApprovals: [],
    memorySuggestions: [],
    learned: [
      {
        body: "Invoices go out on Fridays",
        proposedScope: "workspace",
        authority: "fact",
        turn: 2,
        trust: "trusted",
      },
      {
        body: "The shop sells widgets",
        proposedScope: "bot",
        authority: "fact",
        turn: 5,
        trust: "untrusted",
      },
    ],
  },
});

const decided: Approval = approval({
  id: "apr_decided" as ApprovalId,
  runId: "run_audit" as RunId,
  decision: "deny",
  decidedBy: "human:usr_1",
  decidedAt: "2026-10-14T09:00:00.000Z",
});
const pending: Approval = approval({
  id: "apr_pending" as ApprovalId,
  runId: "run_audit" as RunId,
});

const CHANGES: RunChanges = {
  approvals: [decided, pending],
  checkpoints: [
    { id: "chk_1", taskId: "tsk_1", attempt: 2, body: {}, createdAt: "2026-10-14T09:05:00.000Z" },
  ],
  artifacts: [{ taskId: "tsk_1", ordinal: 0, path: "out/report.pdf", label: "Weekly report" }],
  memoryWritten: [
    {
      entryId: "mem_1",
      scope: "workspace",
      kind: "note",
      botId: "bot_1" as BotId,
      body: "Invoices go out on Fridays",
      authority: "fact",
      trust: "trusted",
      version: 1,
      tombstoned: false,
    },
  ],
};

function stubApi(changes: RunChanges = CHANGES) {
  return {
    getRunChanges: vi.fn(async () => changes),
    listRunMemoryVersions: vi.fn(async () => [
      { entryId: "mem_0", version: 4, via: "index", suppliedAt: "2026-10-14T08:59:00.000Z" },
    ]),
    markRun: vi.fn(),
    unmarkRun: vi.fn(),
  };
}

describe("RunChangesSection", () => {
  it("renders what the run changed from the run row and the two audit reads", async () => {
    const api = stubApi();
    render(<RunChangesSection api={api} run={fixtureRun} />);
    const section = screen.getByTestId("run-changes");
    await waitFor(() => expect(within(section).getByText("mem_0@4")).toBeInTheDocument());
    expect(within(section).getByText("Egress blocked")).toBeInTheDocument();
    // Learned items with their trust marks.
    expect(within(section).getAllByText("trusted").length).toBeGreaterThan(0);
    expect(within(section).getByText("untrusted")).toBeInTheDocument();
    expect(within(section).getByText("The shop sells widgets")).toBeInTheDocument();
    expect(within(section).getByText("reports/week.md")).toBeInTheDocument();
    expect(within(section).getByText("https://shop.example.net/cart")).toBeInTheDocument();
    // Memory written, approvals with decisions, task checkpoints and artifacts.
    expect(within(section).getByText("workspace · note · v1")).toBeInTheDocument();
    expect(within(section).getByText(/deny by human:usr_1/)).toBeInTheDocument();
    expect(within(section).getByText(/pending/)).toBeInTheDocument();
    expect(within(section).getByText(/Checkpoint of task tsk_1, attempt 2/)).toBeInTheDocument();
    expect(within(section).getByText("out/report.pdf")).toBeInTheDocument();
    // The configuration frozen at start.
    expect(within(section).getByText("model-main")).toBeInTheDocument();
    expect(within(section).getByText("invoices@3")).toBeInTheDocument();
    expect(within(section).getByText("v7")).toBeInTheDocument();
    expect(within(section).getByText("abcdef012345")).toBeInTheDocument();
    // Exactly the two reads, once each.
    expect(api.getRunChanges).toHaveBeenCalledTimes(1);
    expect(api.getRunChanges).toHaveBeenCalledWith("run_audit");
    expect(api.listRunMemoryVersions).toHaveBeenCalledTimes(1);
    expect(api.markRun).not.toHaveBeenCalled();
  });

  it("offers the replay export command for a terminal run only", async () => {
    const api = stubApi();
    const { rerender } = render(<RunChangesSection api={api} run={fixtureRun} />);
    const command = replayExportCommand("run_audit", window.location.origin);
    expect(command).toBe(
      `npm run replay -- export --gateway ${window.location.origin} --run run_audit`,
    );
    expect(screen.getByTestId("run-replay")).toHaveTextContent(command);
    rerender(<RunChangesSection api={api} run={{ ...fixtureRun, status: "running" }} />);
    expect(screen.queryByTestId("run-replay")).toBeNull();
    await waitFor(() => expect(api.getRunChanges).toHaveBeenCalledTimes(1));
  });

  it("says when retention pruned the run's ledger", async () => {
    render(
      <RunChangesSection
        api={stubApi({ ...CHANGES, prunedAt: "2026-10-15T00:00:00.000Z" })}
        run={fixtureRun}
      />,
    );
    expect(await screen.findByText(/Retention removed this run's events/)).toBeInTheDocument();
  });
});
