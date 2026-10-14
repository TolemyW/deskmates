import { fireEvent, screen } from "@testing-library/react";

/** Exercise the visible menu rather than changing React Aria's autofill select. */
export async function selectOption(label: string | HTMLElement, option: string) {
  const trigger = typeof label === "string" ? screen.getByLabelText(label) : label;
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

// jsdom lacks CSS.escape; React Aria uses it for generated option IDs.
if (!globalThis.CSS?.escape) {
  globalThis.CSS = {
    ...globalThis.CSS,
    escape: (value: string) =>
      Array.from(value, (char) => `\\${char.codePointAt(0)?.toString(16)} `).join(""),
  };
}
