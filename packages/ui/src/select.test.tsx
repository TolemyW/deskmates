// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./select.js";

afterEach(cleanup);
const options = [
  { value: "", label: "All bots" },
  { value: "chief", label: "Chief" },
  { value: "locked", label: "Unavailable", disabled: true },
];
it("selects through the visible menu, preserves empty options and named form values", async () => {
  function Form() {
    const [value, setValue] = useState("");
    return (
      <form aria-label="Filters">
        <Select label="Bot" name="bot" value={value} onValueChange={setValue} options={options} />
      </form>
    );
  }
  render(<Form />);
  const trigger = screen.getByRole("button", { name: "All bots Bot" });
  fireEvent.click(trigger);
  const unavailable = await screen.findByRole("option", { name: "Unavailable" });
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(unavailable);
  expect(trigger.textContent).toContain("All bots");
  fireEvent.click(screen.getByRole("option", { name: "Chief" }));
  expect(trigger.textContent).toContain("Chief");
  expect(new FormData(screen.getByRole("form") as HTMLFormElement).get("bot")).toBe("chief");
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: "All bots" }));
  expect(trigger.textContent).toContain("All bots");
  expect(new FormData(screen.getByRole("form") as HTMLFormElement).get("bot")).toBe("");
});
it("does not open or change a disabled selector", () => {
  const changed = vi.fn();
  render(<Select label="Bot" value="" disabled options={options} onValueChange={changed} />);
  const trigger = screen.getByRole("button", { name: "All bots Bot" }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  fireEvent.click(trigger);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

// jsdom lacks CSS.escape; React Aria uses it for generated option IDs.
if (!globalThis.CSS?.escape) {
  globalThis.CSS = {
    ...globalThis.CSS,
    escape: (value: string) =>
      Array.from(value, (char) => `\\${char.codePointAt(0)?.toString(16)} `).join(""),
  };
}
