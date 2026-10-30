import { fireEvent, screen } from "@testing-library/react";

/** Exercise the visible menu rather than changing React Aria's autofill select. */
export async function selectOption(label: string | HTMLElement, option: string) {
  const trigger = typeof label === "string" ? screen.getByLabelText(label) : label;
  if (trigger instanceof HTMLSelectElement) {
    const selected = [...trigger.options].find((item) => item.textContent === option);
    if (!selected) throw new Error(`Missing select option: ${option}`);
    fireEvent.change(trigger, { target: { value: selected.value } });
    return;
  }
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
