// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { approval, approvalMessage } from "../../test-support/fixtures.js";
import { ChatApproval } from "./chat-approval.js";

afterEach(cleanup);

it("opens both disclosures for a linked receipt, retaining its id and original text", () => {
  const receipt = approvalMessage(3, "Denied by human:operator: keep the original reason");
  const decided = approval({ decision: "deny", decidedBy: "human:operator" });
  const { container, rerender } = render(
    <ChatApproval approval={decided} receipts={[receipt]} reveal={false} />,
  );
  expect(container.querySelector(".chat-approval-receipt")).not.toHaveAttribute("open");
  expect(screen.getByText(receipt.body)).not.toBeVisible();
  rerender(<ChatApproval approval={decided} receipts={[receipt]} reveal={true} />);
  expect(container.querySelector(".chat-approval-receipt")).toHaveAttribute("open");
  expect(screen.getByText(receipt.body)).toBeVisible();
  expect(document.getElementById(`message-${receipt.id}`)).toBeTruthy();
  fireEvent.click(container.querySelector(".chat-approval-receipt > summary") as HTMLElement);
  expect(container.querySelector(".chat-approval-receipt")).not.toHaveAttribute("open");
});
