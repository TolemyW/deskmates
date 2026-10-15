// @vitest-environment jsdom
// ADR-0039 decision 8: the bot model pickers offer every registered model labelled with the
// upstream that serves it, keep the deployment default as the "no override" choice, and still
// accept another id typed by hand.

import type { RegisteredModel } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { selectOption } from "../../test-support/select.js";
import { ModelPicker, ModelSuggestions } from "./model-picker.js";

afterEach(cleanup);

const MODELS: RegisteredModel[] = [
  { model: "local-27b", upstream: "local" },
  { model: "local-vl", upstream: "vl" },
  { model: "main-model", upstream: "default" },
];

it("lists registered models with their upstream and picks one as the override", async () => {
  const onChange = vi.fn();
  render(
    <ModelPicker
      label="Model"
      overrideLabel="Model override"
      value=""
      onChange={onChange}
      deploymentModel="main-model"
      models={MODELS}
    />,
  );
  const trigger = screen.getByLabelText("Model");
  expect(trigger.textContent).toContain("Deployment default · main-model · via default");
  fireEvent.click(trigger);
  const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
  expect(options).toEqual([
    "Deployment default · main-model · via default",
    "local-27b · via local",
    "local-vl · via vl",
    "Another model id…",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "local-27b · via local" }));
  expect(onChange).toHaveBeenLastCalledWith("local-27b");
  await selectOption(
    screen.getByLabelText("Model"),
    "Deployment default · main-model · via default",
  );
  expect(onChange).toHaveBeenLastCalledWith("");
});

it("opens on the saved registered override and accepts another id by hand", async () => {
  const onChange = vi.fn();
  const { unmount } = render(
    <ModelPicker
      label="Cheap model"
      overrideLabel="Cheap model override"
      value="local-vl"
      onChange={onChange}
      deploymentModel="local-27b"
      models={MODELS}
    />,
  );
  expect(screen.getByLabelText("Cheap model").textContent).toContain("local-vl · via vl");
  expect(screen.queryByLabelText("Cheap model override")).toBeNull();
  await selectOption(screen.getByLabelText("Cheap model"), "Another model id…");
  fireEvent.change(screen.getByLabelText("Cheap model override"), {
    target: { value: "vendor/unlisted" },
  });
  expect(onChange).toHaveBeenLastCalledWith("vendor/unlisted");
  unmount();

  // An unlisted saved override opens on the free-text choice with its id filled in.
  render(
    <ModelPicker
      label="Model"
      overrideLabel="Model override"
      value="vendor/unlisted"
      onChange={onChange}
      deploymentModel="main-model"
      models={MODELS}
    />,
  );
  expect(screen.getByLabelText("Model").textContent).toContain("Another model id…");
  expect((screen.getByLabelText("Model override") as HTMLInputElement).value).toBe(
    "vendor/unlisted",
  );
});

it("suggests registered models for free-text fields", () => {
  const { container } = render(<ModelSuggestions id="models" models={MODELS} />);
  const options = [...container.querySelectorAll("datalist#models option")];
  expect(options.map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
    ["local-27b", "local-27b · via local"],
    ["local-vl", "local-vl · via vl"],
    ["main-model", "main-model · via default"],
  ]);
});
