// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChoiceGroup } from "./choice-group.js";
afterEach(cleanup);
it("keeps controlled selection, names, counts and disabled choices distinct", () => {
  const change = vi.fn();
  render(
    <ChoiceGroup
      label="Type"
      value="all"
      onChange={change}
      items={[
        { key: "all", label: "All", count: 12 },
        { key: "images", label: "Images", count: 3 },
        { key: "blocked", label: "Unavailable", disabled: true },
      ]}
    />,
  );
  expect(screen.getByRole("group", { name: "Type" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Images" }));
  expect(change).toHaveBeenCalledWith("images");
  fireEvent.click(screen.getByRole("button", { name: "Unavailable" }));
  expect(change).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("tab")).toBeNull();
});
it("gives icon-only choices accessible names and prevents form submission", () => {
  render(
    <ChoiceGroup
      label="View"
      value="list"
      onChange={() => {}}
      iconOnly
      items={[
        { key: "list", label: "List", icon: <svg /> },
        { key: "grid", label: "Grid", icon: <svg /> },
      ]}
    />,
  );
  const grid = screen.getByRole("button", { name: "Grid" });
  expect(grid.getAttribute("type")).toBe("button");
});
