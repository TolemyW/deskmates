// @vitest-environment jsdom
import type { Approval } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCard } from "./approval-card.js";

const base = {
  id: "approval_1",
  runId: "run_1",
  botId: "bot_1",
  action: { toolName: "Bash", input: {}, argumentSummary: "git push origin main" },
  riskLevel: "L2",
  waitMode: "deferred",
  createdAt: "2026-09-30T00:00:00.000Z",
} as Approval;

afterEach(cleanup);

describe("approval scope and continuation controls", () => {
  it("offers Continue and Stop without an Always rule for a turn continuation", () => {
    render(<ApprovalCard approval={{ ...base, kind: "continuation" }} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Always" })).toBeNull();
  });

  it("previews the effective wildcard scope before confirming Always", () => {
    render(<ApprovalCard approval={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(screen.getByText("Any origin")).toBeTruthy();
    expect(screen.getAllByText("git push origin main")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Confirm Always" })).toBeTruthy();
  });
});

it("labels generated summaries and initially collapses the full unchanged source", () => {
  const instruction = "Original long instruction. ".repeat(100);
  const { container } = render(
    <ApprovalCard
      approval={{
        ...base,
        instruction,
        displaySummary: {
          text: "Publishes the current branch to the remote repository.",
          runId: base.runId,
        },
        action: { ...base.action, input: { command: "git push origin main" } },
      }}
    />,
  );
  expect(screen.getByText("AI summary")).toBeTruthy();
  expect(screen.getByText("Publishes the current branch to the remote repository.")).toBeTruthy();
  const details = container.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain(instruction);
  expect(container.querySelector(".approval-input")?.textContent).toContain(
    '"command": "git push origin main"',
  );
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
});

describe("tier labels on the card (ADR-0002 amendment 3, A5)", () => {
  it("names an unclassified tool and the subagent that asked", () => {
    render(
      <ApprovalCard
        approval={{
          ...base,
          action: {
            ...base.action,
            toolName: "BrandNewTool",
            unclassified: true,
            agentType: "Explore",
          },
        }}
      />,
    );
    const unclassified = screen.getByText("Unclassified tool");
    expect(unclassified.getAttribute("title")).toBe(
      "No tier table names this tool, so it asks by default.",
    );
    expect(screen.getByText("Inside subagent: Explore")).toBeTruthy();
  });

  it("shows neither label for an ordinary request", () => {
    render(<ApprovalCard approval={base} />);
    expect(screen.queryByText("Unclassified tool")).toBeNull();
    expect(screen.queryByText(/Inside subagent/)).toBeNull();
  });
});

describe("an expired request (ADR-0002 amendment 3, A7)", () => {
  it("says nobody decided in time instead of naming a denier", () => {
    const expired = {
      ...base,
      decision: "deny",
      decidedBy: "system:expiry",
      decidedAt: "2026-09-30T00:15:00.000Z",
    } as Approval;
    render(<ApprovalCard approval={expired} />);
    expect(screen.getByText("Expired: nobody decided in time")).toBeTruthy();
    expect(screen.queryByText(/Denied by/)).toBeNull();
  });
});
