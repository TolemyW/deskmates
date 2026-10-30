// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ControlPopover, HelpTip } from "./auxiliary-controls.js";
afterEach(cleanup);
it("opens named help on activation and dismisses it with Escape", async () => {
  render(<HelpTip label="About uploads">Uploads do not start work.</HelpTip>);
  expect(screen.queryByRole("tooltip")).toBeNull();
  const trigger = screen.getByRole("button", { name: "About uploads" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(await screen.findByRole("tooltip")).toHaveProperty(
    "textContent",
    "Uploads do not start work.",
  );
  fireEvent.keyDown(trigger, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});
it("opens an accessible filter dialog and returns focus when dismissed", async () => {
  render(
    <ControlPopover label="Filters" trigger="Filters">
      <input aria-label="Source" />
    </ControlPopover>,
  );
  const trigger = screen.getByRole("button", { name: "Filters" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Filters" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
