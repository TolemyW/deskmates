// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Pager } from "./pager.js";
afterEach(cleanup);

const labels = { label: "Pages", previousLabel: "Previous", nextLabel: "Next" };

it("names the navigation, announces the range and moves on click", () => {
  const previous = vi.fn();
  const next = vi.fn();
  render(
    <Pager
      {...labels}
      range="26–50 of 80"
      hasPrevious
      hasNext
      onPrevious={previous}
      onNext={next}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Pages" });
  expect(nav.textContent).toContain("26–50 of 80");
  expect(screen.getByText("26–50 of 80").getAttribute("aria-live")).toBe("polite");
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(previous).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
});

it("disables each boundary and both controls while busy", () => {
  const { rerender } = render(
    <Pager
      {...labels}
      range="1–25 of more"
      hasPrevious={false}
      hasNext
      onPrevious={() => {}}
      onNext={() => {}}
    />,
  );
  const previous = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
  const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);
  rerender(
    <Pager
      {...labels}
      range="1–25 of more"
      hasPrevious
      hasNext
      busy
      onPrevious={() => {}}
      onNext={() => {}}
    />,
  );
  expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps consumer layout classes", () => {
  render(
    <Pager
      {...labels}
      range="1–1 of 1"
      hasPrevious={false}
      hasNext={false}
      onPrevious={() => {}}
      onNext={() => {}}
      className="files-pager"
      rangeClassName="muted small"
    />,
  );
  expect(screen.getByRole("navigation").className).toContain("files-pager");
  expect(screen.getByText("1–1 of 1").className).toBe("muted small");
});
