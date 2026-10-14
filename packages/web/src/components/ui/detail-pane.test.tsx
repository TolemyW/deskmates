// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { DetailPane, DetailPaneContent, DetailPaneLayout } from "./detail-pane.js";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";
afterEach(cleanup);
function Example() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <DetailPaneLayout>
      <main>
        <input aria-label="Draft" defaultValue="kept" />
        <button type="button" onClick={() => setOpen(true)}>
          Inspect
        </button>
        <button type="button" onClick={() => setConfirm(true)}>
          Confirm action
        </button>
      </main>
      <DetailPane open={open} onOpenChange={setOpen}>
        <DetailPaneContent placement="right" aria-describedby={undefined}>
          <DialogTitle>Details</DialogTitle>
          <input aria-label="Detail notes" defaultValue="initial" />
        </DetailPaneContent>
      </DetailPane>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Confirmation</DialogTitle>
        </DialogContent>
      </Dialog>
    </DetailPaneLayout>
  );
}
it("docks inspectable details without making chat inert, while confirmations remain modal", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  render(<Example />);
  fireEvent.click(screen.getByText("Inspect"));
  await waitFor(() => expect(document.querySelector(".docked-detail")).toBeTruthy());
  expect(screen.getByRole("dialog").getAttribute("aria-modal")).not.toBe("true");
  fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), {
    target: { value: "still editable" },
  });
  fireEvent.pointerDown(screen.getByRole("textbox", { name: "Draft" }));
  expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();
  fireEvent.click(screen.getByText("Confirm action"));
  expect(screen.getByRole("dialog", { name: "Confirmation" })).toBeTruthy();
  expect(document.querySelector("main")?.closest('[aria-hidden="true"]')).toBeTruthy();
});
it("uses the existing modal fallback below the layout breakpoint", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1279 });
  render(<Example />);
  fireEvent.click(screen.getByText("Inspect"));
  expect(document.querySelector(".docked-detail")).toBeNull();
  expect(document.querySelector("main")?.closest('[aria-hidden="true"]')).toBeTruthy();
});

it("preserves detail-local input across the responsive portal and modality transition", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  render(<Example />);
  fireEvent.click(screen.getByText("Inspect"));
  fireEvent.change(screen.getByRole("textbox", { name: "Detail notes" }), {
    target: { value: "Unsent detail draft" },
  });
  for (const width of [1279, 1280, 1440]) {
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Detail notes" }) as HTMLInputElement).value,
      ).toBe("Unsent detail draft"),
    );
  }
});
