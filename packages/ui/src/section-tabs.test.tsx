// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SectionTabs, TabNavigation } from "./section-tabs.js";
afterEach(cleanup);

it("supports arrow/Home/End navigation, skips disabled tabs and relates panels", async () => {
  function Example() {
    const [value, setValue] = useState("first");
    return (
      <SectionTabs
        label="Sections"
        value={value}
        onChange={setValue}
        items={[
          { key: "first", label: "First" },
          { key: "disabled", label: "Unavailable", disabled: true },
          { key: "last", label: "Long-term instructions" },
        ]}
        renderPanel={(key) => <p>{key} content</p>}
      />
    );
  }
  render(<Example />);
  const first = screen.getByRole("tab", { name: "First" });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  const last = screen.getByRole("tab", { name: "Long-term instructions" });
  await waitFor(() => expect(document.activeElement).toBe(last));
  expect(last.getAttribute("aria-selected")).toBe("true");
  expect(
    document.getElementById(last.getAttribute("aria-controls") ?? "")?.getAttribute("role"),
  ).toBe("tabpanel");
  fireEvent.keyDown(last, { key: "Home" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.keyDown(first, { key: "End" });
  await waitFor(() => expect(document.activeElement).toBe(last));
});

it("mounts editors lazily and retains drafts on later visits", () => {
  const mounted = vi.fn();
  function Example() {
    const [value, setValue] = useState("first");
    return (
      <SectionTabs
        label="Editors"
        value={value}
        onChange={setValue}
        keepMounted
        items={[
          { key: "first", label: "First" },
          { key: "second", label: "Second" },
        ]}
        renderPanel={(key) => {
          mounted(key);
          return <input aria-label={`${key} draft`} />;
        }}
      />
    );
  }
  render(<Example />);
  expect(mounted.mock.calls.some(([key]) => key === "second")).toBe(false);
  const input = screen.getByRole("textbox", { name: "first draft" });
  fireEvent.change(input, { target: { value: "unsaved" } });
  fireEvent.click(screen.getByRole("tab", { name: "Second" }));
  expect(screen.queryByRole("textbox", { name: "first draft" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "First" }));
  expect(screen.getByRole("textbox", { name: "first draft" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("unsaved");
});

it("keeps route navigation as links with a single current destination", () => {
  render(
    <TabNavigation
      label="Pages"
      value="a"
      items={[
        { key: "a", label: "Account", href: "#/account" },
        { key: "b", label: "Workspaces", href: "#/workspaces" },
      ]}
    />,
  );
  expect(screen.getByRole("link", { name: "Account" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Workspaces" }).getAttribute("href")).toBe(
    "#/workspaces",
  );
  expect(screen.queryByRole("tab")).toBeNull();
});
