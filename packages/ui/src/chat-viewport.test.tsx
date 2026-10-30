// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatViewport } from "./chat-viewport.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("anchors an asynchronously loaded message once without interrupting subsequent reading", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const view = (loaded: boolean, target = "message-old") => (
    <ChatViewport conversationKey="one" scrollTargetId={target} composer={<textarea />}>
      {loaded && <p id="message-old">Earlier message</p>}
      <p id="message-new">Latest message</p>
    </ChatViewport>
  );
  const { rerender } = render(view(false));
  expect(scroll).not.toHaveBeenCalled();
  rerender(view(true));
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  rerender(view(true));
  expect(scroll).toHaveBeenCalledTimes(1);
  rerender(view(true, "message-new"));
  expect(scroll).toHaveBeenCalledTimes(2);
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("releases following before a disclosure changes height and resumes only through the latest control", () => {
  let resize: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const { container } = render(
    <ChatViewport conversationKey="one" composer={<textarea />}>
      <button type="button" data-chat-disclosure>
        Read full reply
      </button>
    </ChatViewport>,
  );
  const viewport = container.querySelector(".gb-chat-viewport") as HTMLElement;
  let height = 1000;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 400 },
    scrollHeight: { get: () => height },
  });
  act(() => resize?.());
  viewport.scrollTop = 600;
  fireEvent.click(container.querySelector("[data-chat-disclosure]") as HTMLElement);
  height = 1800;
  act(() => resize?.());
  expect(viewport.scrollTop).toBe(600);
  fireEvent.click(container.querySelector(".gb-chat-latest button") as HTMLElement);
  expect(viewport.scrollTop).toBe(1800);
});

it("shows the scrollbar during reading and hides it after inactivity without changing scroll position", () => {
  vi.useFakeTimers();
  try {
    const { container } = render(
      <ChatViewport conversationKey="one" composer={<textarea />}>
        <p>Messages</p>
      </ChatViewport>,
    );
    const viewport = container.querySelector(".gb-chat-viewport") as HTMLElement;
    fireEvent.scroll(viewport);
    expect(viewport.dataset.scrolling).toBe("true");
    act(() => vi.advanceTimersByTime(600));
    fireEvent.scroll(viewport);
    act(() => vi.advanceTimersByTime(600));
    expect(viewport.dataset.scrolling).toBe("true");
    act(() => vi.advanceTimersByTime(301));
    expect(viewport.dataset.scrolling).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
