// @vitest-environment jsdom
import type { Approval, ApprovalId, BotId, IsoTimestamp, RunId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ApprovalCard } from "./approval-card.js";
afterEach(cleanup);
it("renders the Drive target and outgoing content in the actual approval card as inert text", () => {
  const content = '<img src=x onerror="alert(1)">';
  const approval: Approval = {
    id: "approval_1" as ApprovalId,
    runId: "run_1" as RunId,
    botId: "bot_1" as BotId,
    riskLevel: "L2",
    waitMode: "deferred",
    createdAt: "2026-10-05T00:00:00Z" as IsoTimestamp,
    action: {
      toolName: "mcp__deskmates__integration_execute",
      input: {
        service: "googledrive",
        connectionName: "scratch",
        preview: {
          target: { parents: ["dedicated-folder"], name: "acceptance.txt" },
          proposedInput: content,
          complete: false,
        },
      },
    },
  };
  const { container } = render(<ApprovalCard approval={approval} />);
  fireEvent.click(screen.getByText("Details", { selector: "summary" }));
  const preview = screen.getByRole("region", { name: "Proposed Drive action" });
  expect(preview).toBeTruthy();
  expect(within(preview).getByText(/dedicated-folder/)).toBeTruthy();
  expect(screen.getByText(content)).toBeTruthy();
  expect(screen.getByText(/Preview truncated/)).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
});
