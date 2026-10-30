// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskOutput } from "./task-output.js";
afterEach(cleanup);

it("uses schema labels and descriptions without guessing units or rounding delivered values", () => {
  render(
    <TaskOutput
      output={{
        completion_percent: 77.271828,
        limitations: ["Synthetic data"],
        note: "<img src=x onerror=alert(1)>",
      }}
      schema={{
        properties: {
          completion_percent: {
            title: "Completion rate",
            description: "Percent of the revised target",
          },
        },
      }}
    />,
  );
  expect(screen.getByText("Completion rate")).toBeTruthy();
  expect(screen.getByText("Percent of the revised target")).toBeTruthy();
  expect(screen.getByText("77.271828")).toBeTruthy();
  expect(screen.queryByText("77.27%")).toBeNull();
  expect(screen.getAllByRole("term")[0]?.textContent).toBe("limitations");
  expect(screen.getByText("<img src=x onerror=alert(1)>").querySelector("img")).toBeNull();
});
