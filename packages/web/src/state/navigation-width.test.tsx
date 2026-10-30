// @vitest-environment jsdom
import { ResizeHandle } from "@deskmates/ui";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useNavigationWidth } from "./navigation-width.js";
afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});
it("starts compact to reserve space for the conversation", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 850 });
  const { result } = renderHook(useNavigationWidth);
  expect(result.current.width).toBe(64);
  expect(result.current.compact).toBe(true);
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

it("keeps labels at an expanded width on narrow desktops and restores the preferred width", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  localStorage.setItem("deskmates.panel.navigation", "280");
  localStorage.setItem("deskmates.navigation.compact", "false");
  const { result } = renderHook(useNavigationWidth);
  expect(result.current.width).toBe(280);
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 850 });
    window.dispatchEvent(new Event("resize"));
  });
  expect(result.current.width).toBe(230);
  expect(result.current.compact).toBe(false);
  expect(localStorage.getItem("deskmates.navigation.compact")).toBe("false");
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    window.dispatchEvent(new Event("resize"));
  });
  expect(result.current.width).toBe(280);
  act(() => result.current.toggle());
  expect(result.current.width).toBe(64);
  act(() => result.current.toggle());
  expect(result.current.width).toBe(280);
});
