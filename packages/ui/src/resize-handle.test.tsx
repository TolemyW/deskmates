// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResizeHandle } from "./resize-handle.js";
afterEach(cleanup);
it("supports keyboard bounds and reversed drawer movement", () => {
  const change = vi.fn();
  render(
    <ResizeHandle label="Panel width" value={300} min={220} max={480} onChange={change} reverse />,
  );
  const handle = screen.getByRole("separator", { name: "Panel width" });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(change).toHaveBeenLastCalledWith(316, "keyboard");
  fireEvent.keyDown(handle, { key: "Home" });
  expect(change).toHaveBeenLastCalledWith(220, "keyboard");
  fireEvent.keyDown(handle, { key: "End" });
  expect(change).toHaveBeenLastCalledWith(480, "keyboard");
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");
});
