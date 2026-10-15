// @vitest-environment jsdom
// Issue #11, ADR-0042 decision 3: marking a run wrong with an optional note calls the Gateway and
// shows the mark at once; unmarking removes it. The Activity card shows a standing mark and, when
// its panel is given the actions, the same control one disclosure away.

import "@testing-library/jest-dom/vitest";
import type { RunId, RunMark } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../test-support/fixtures.js";
import { ActivityPanel } from "./activity.js";
import { type RunMarkActions, RunMarkControl } from "./run-mark.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MARK: RunMark = {
  runId: "run_1" as RunId,
  verdict: "wrong",
  note: "wrong customer",
  markedBy: "user:usr_1",
  markedAt: "2026-10-14T08:00:00.000Z",
};

function actions(): RunMarkActions & {
  mark: ReturnType<typeof vi.fn>;
  unmark: ReturnType<typeof vi.fn>;
} {
  return {
    mark: vi.fn(async (_id: RunId, note?: string) => ({ ...MARK, ...(note ? { note } : {}) })),
    unmark: vi.fn(async () => true),
  };
}

/** The control with its mark held the way the drawer and the card hold it. */
function Harness({ acts }: { acts: RunMarkActions }) {
  const [mark, setMark] = useState<RunMark | undefined>();
  return (
    <RunMarkControl
      runId={"run_1" as RunId}
      mark={mark}
      actions={acts}
      onChange={setMark}
      canMark
    />
  );
}

describe("RunMarkControl", () => {
  it("marks with a note, shows the badge, and unmarking restores", async () => {
    const acts = actions();
    render(<Harness acts={acts} />);
    expect(screen.queryByTestId("run-mark-badge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark as wrong" }));
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "  booked the wrong flight " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mark" }));
    expect(await screen.findByTestId("run-mark-badge")).toHaveTextContent("Marked wrong");
    expect(acts.mark).toHaveBeenCalledWith("run_1", "booked the wrong flight");
    expect(screen.getByText("booked the wrong flight")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    await waitFor(() => expect(screen.queryByTestId("run-mark-badge")).toBeNull());
    expect(acts.unmark).toHaveBeenCalledWith("run_1");
    expect(screen.getByRole("button", { name: "Mark as wrong" })).toBeInTheDocument();
  });

  it("marks without a note when none is given", async () => {
    const acts = actions();
    render(<Harness acts={acts} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark as wrong" }));
    fireEvent.click(screen.getByRole("button", { name: "Save mark" }));
    await screen.findByTestId("run-mark-badge");
    expect(acts.mark).toHaveBeenCalledWith("run_1", undefined);
  });

  it("offers no action to a role that may not mark, and says who may change a mark", () => {
    const acts = actions();
    const { rerender } = render(
      <RunMarkControl
        runId={"run_1" as RunId}
        mark={undefined}
        actions={acts}
        onChange={() => {}}
        canMark={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Mark as wrong" })).toBeNull();
    rerender(
      <RunMarkControl
        runId={"run_1" as RunId}
        mark={MARK}
        actions={acts}
        onChange={() => {}}
        canMark={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Unmark" })).toBeNull();
    expect(screen.getByTestId("run-mark-badge")).toBeInTheDocument();
  });
});

describe("Activity card mark", () => {
  const failed = run({
    status: "failed",
    error: "no_reply",
    createdAt: "2026-10-14T07:00:00.000Z",
  });

  it("shows a standing mark on the card", () => {
    render(<ActivityPanel runs={[{ ...failed, mark: MARK }]} botName={() => "ann"} />);
    expect(screen.getByTestId("run-mark-badge")).toHaveTextContent("Marked wrong");
  });

  it("marks from the card when the panel has the actions", async () => {
    const acts = actions();
    render(<ActivityPanel runs={[failed]} botName={() => "ann"} markRun={acts} />);
    expect(screen.queryByTestId("run-mark-badge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark as wrong" }));
    fireEvent.click(screen.getByRole("button", { name: "Save mark" }));
    await waitFor(() => expect(screen.getAllByTestId("run-mark-badge").length).toBeGreaterThan(0));
    expect(acts.mark).toHaveBeenCalledWith("run_1", undefined);
  });

  it("offers no mark action without the actions", () => {
    render(<ActivityPanel runs={[failed]} botName={() => "ann"} />);
    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(screen.queryByRole("button", { name: "Mark as wrong" })).toBeNull();
  });
});
