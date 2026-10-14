// @vitest-environment jsdom
import { ResizeHandle } from "@deskmates/ui";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useNavigationWidth } from "./navigation-width.js";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("snaps with hysteresis and restores the expanded width through keyboard and reload", () => {
  localStorage.setItem("deskmates.panel.navigation", "260");
  const { result, unmount } = renderHook(useNavigationWidth);
  act(() => result.current.setWidth(180, "pointer"));
  expect(result.current.width).toBe(200);
  act(() => result.current.setWidth(179, "pointer"));
  expect(result.current.width).toBe(64);
  act(() => result.current.setWidth(199, "pointer"));
  expect(result.current.width).toBe(64);
  act(() => result.current.setWidth(200, "pointer"));
  expect(result.current.width).toBe(200);
  act(() => result.current.setWidth(280, "pointer"));
  act(() => result.current.setWidth(64, "keyboard"));
  expect(result.current.width).toBe(64);
  unmount();
  const reloaded = renderHook(useNavigationWidth);
  expect(reloaded.result.current.width).toBe(64);
  act(() => reloaded.result.current.setWidth(80, "keyboard"));
  expect(reloaded.result.current.width).toBe(280);
});

function NavigationSeparator() {
  const width = useNavigationWidth();
  return (
    <ResizeHandle
      label="Resize navigation"
      value={width.width}
      min={width.min}
      max={width.max}
      onChange={width.setWidth}
    />
  );
}
it("collapses through repeated ArrowLeft presses and expands again without losing focus", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  localStorage.setItem("deskmates.panel.navigation", "240");
  localStorage.setItem("deskmates.navigation.compact", "false");
  render(<NavigationSeparator />);
  const handle = screen.getByRole("separator", { name: "Resize navigation" });
  handle.focus();
  for (const width of [224, 208, 200, 64]) {
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(width));
    expect(document.activeElement).toBe(handle);
  }
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle.getAttribute("aria-valuenow")).toBe("200");
  expect(document.activeElement).toBe(handle);
});
