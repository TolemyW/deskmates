// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionMenu } from "./action-menu.js";

afterEach(cleanup);

it("opens from a named trigger, runs the chosen item and skips disabled ones", async () => {
  const edit = vi.fn();
  const undo = vi.fn();
  render(
    <ActionMenu
      label="More actions for refund note"
      items={[
        { id: "edit", label: "Edit", onAction: edit },
        { id: "undo", label: "Undo", onAction: undo, disabled: true },
        false,
        { id: "forget", label: "Forget", onAction: vi.fn(), tone: "danger" },
      ]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More actions for refund note" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("true");
  fireEvent.click(trigger);
  const menu = await screen.findByRole("menu");
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Edit",
    "Undo",
    "Forget",
  ]);
  expect(screen.getByRole("menuitem", { name: "Undo" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("menuitem", { name: "Undo" }));
  expect(undo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(edit).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(menu.isConnected).toBe(false));
});

it("does not open when disabled", () => {
  render(
    <ActionMenu
      disabled
      label="More actions"
      items={[{ id: "a", label: "A", onAction: vi.fn() }]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More actions" }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  fireEvent.click(trigger);
  expect(screen.queryByRole("menu")).toBeNull();
});

// jsdom lacks CSS.escape; React Aria uses it for generated IDs.
if (!globalThis.CSS?.escape) {
  globalThis.CSS = {
    ...globalThis.CSS,
    escape: (value: string) =>
      Array.from(value, (char) => `\\${char.codePointAt(0)?.toString(16)} `).join(""),
  };
}
