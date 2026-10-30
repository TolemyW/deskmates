// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { RUN_ERROR_NO_REPLY } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CompactRunError } from "./compact-run-error.js";
afterEach(cleanup);

it("keeps the model failure visible while retaining the exact SDK error behind details", () => {
  const error =
    "Error: Claude Code returned an error result: There's an issue with the selected model (unavailable-model). It may not exist or you may not have access to it.\n    at sS.readMessages (file:///sdk.mjs:127:26507)";
  const { container } = render(<CompactRunError error={error} />);
  expect(screen.getByText(/selected model is unavailable/)).toBeVisible();
  expect(container.textContent).not.toContain("sdk.mjs");
  expect(container.textContent).not.toContain("unavailable-model");
  fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
  expect(container.querySelector("pre")?.textContent).toBe(error);
});

it("retains actionable known reasons and does not expose unknown stacks by default", () => {
  const { rerender, container } = render(<CompactRunError error={RUN_ERROR_NO_REPLY} />);
  expect(screen.getByText(/No reply was sent/)).toBeVisible();
  rerender(<CompactRunError error="TypeError: internal implementation detail\n at broken.ts:1" />);
  expect(screen.getByText(/could not be completed/)).toBeVisible();
  expect(container.textContent).not.toContain("broken.ts");
});
