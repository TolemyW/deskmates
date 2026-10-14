// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatViewport } from "./chat-viewport.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
