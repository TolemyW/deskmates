// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageComposer } from "./message-composer.js";

afterEach(cleanup);

it("sends once on Enter and clears the controlled draft", () => {
  const send = vi.fn();
  function Harness() {
    const [value, setValue] = useState("");
    return <MessageComposer value={value} onChange={setValue} onSend={send} />;
  }
  render(<Harness />);
  const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "  Review the brief  " } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(send).toHaveBeenCalledExactlyOnceWith("Review the brief");
  expect(field.value).toBe("");
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("leaves Shift+Enter and IME confirmation to the textarea", () => {
  const send = vi.fn();
  render(<MessageComposer value="研究" onChange={vi.fn()} onSend={send} />);
  const field = screen.getByRole("textbox");
  expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "Enter", isComposing: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "Enter", keyCode: 229 })).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

it("blocks empty and disabled drafts, and sends multiline text by button", () => {
  const send = vi.fn();
  const change = vi.fn();
  const { rerender } = render(<MessageComposer value={" \n "} onChange={change} onSend={send} />);
  fireEvent.submit(screen.getByRole("textbox").closest("form") as HTMLFormElement);
  rerender(<MessageComposer value="Draft" disabled onChange={change} onSend={send} />);
  fireEvent.submit(screen.getByRole("textbox").closest("form") as HTMLFormElement);
  expect(send).not.toHaveBeenCalled();
  rerender(<MessageComposer value={"First line\nSecond line"} onChange={change} onSend={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(send).toHaveBeenCalledExactlyOnceWith("First line\nSecond line");
  expect(change).toHaveBeenCalledWith("");
});
