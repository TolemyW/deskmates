// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Avatar, getAvatarColor } from "./avatar.js";

afterEach(cleanup);

it("keeps name colors stable across case, whitespace and equivalent Unicode", () => {
  expect(getAvatarColor("  Atlas   Research ")).toBe(getAvatarColor("atlas research"));
  expect(getAvatarColor("Ａｌｉｃｅ")).toBe(getAvatarColor("Alice"));
  expect(getAvatarColor("Jose\u0301")).toBe(getAvatarColor("José"));
  const names = ["Alice", "Bob", "李明", "Atlas Research", "Operations", "Market watch"];
  const palette = names.map(getAvatarColor);
  expect(names.map(getAvatarColor)).toEqual(palette);
  expect(new Set(palette).size).toBeGreaterThan(1);
  expect(
    palette.every((color) => ["accent", "success", "warning", "danger", "default"].includes(color)),
  ).toBe(true);
});

it("keeps the same color at each size and preserves accessible Unicode initials", () => {
  const { rerender } = render(<Avatar name="李明" />);
  const avatar = screen.getByRole("img", { name: "李明" });
  const color = avatar.getAttribute("data-color");
  expect(avatar.textContent).toBe("李明");
  rerender(<Avatar name="李明" size="sm" />);
  expect(avatar.getAttribute("data-color")).toBe(color);
  rerender(<Avatar name="Atlas Research" />);
  expect(screen.getByRole("img", { name: "Atlas Research" }).textContent).toBe("AR");
  rerender(<Avatar name="   " />);
  expect(screen.getByRole("img", { name: "Unknown user" }).textContent).toBe("?");
  expect(getAvatarColor("")).toBe("default");
});

it("shows an image source when given one and returns to the name fallback when it fails", () => {
  const { container, rerender } = render(<Avatar name="Mia Member" src="/auth/avatar?v=1" />);
  const avatar = screen.getByRole("img", { name: "Mia Member" });
  const image = container.querySelector("img");
  expect(image?.getAttribute("src")).toBe("/auth/avatar?v=1");
  expect(image?.getAttribute("alt")).toBe("");
  expect(avatar.textContent).toBe("");
  act(() => {
    image?.dispatchEvent(new Event("error"));
  });
  expect(container.querySelector("img")).toBeNull();
  expect(avatar.textContent).toBe("MM");
  // A new source is tried again.
  rerender(<Avatar name="Mia Member" src="/auth/avatar?v=2" size="lg" />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/auth/avatar?v=2");
  expect(avatar.getAttribute("data-size")).toBe("lg");
  rerender(<Avatar name="Mia Member" src={null} />);
  expect(container.querySelector("img")).toBeNull();
  expect(avatar.textContent).toBe("MM");
});
