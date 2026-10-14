// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useHashLocation } from "./router.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "#/threads");
});

it("keeps a route paired with its hash until navigation is delivered, even during unrelated renders", () => {
  window.history.replaceState(null, "", "#/threads/thr_1?message=msg_2");
  const { result, rerender } = renderHook(() => useHashLocation());
  window.history.replaceState(null, "", "#/runs/run_1");
  rerender();
  expect(result.current).toEqual({
    route: { name: "threads", id: "thr_1", messageId: "msg_2" },
    hash: "#/threads/thr_1?message=msg_2",
  });
  act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(result.current).toEqual({ route: { name: "runs", id: "run_1" }, hash: "#/runs/run_1" });
});
