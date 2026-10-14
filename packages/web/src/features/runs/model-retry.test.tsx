// @vitest-environment jsdom
// ADR-0033 decision 8: a model retry is read as attempt, count, reason and wait; the raw JSON is
// behind a closed disclosure.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ModelRetryLine, retryReason } from "./model-retry.js";

afterEach(cleanup);

it("words the retry and keeps the raw payload closed", () => {
  render(
    <ModelRetryLine
      payload={{
        attempt: 2,
        maxRetries: 10,
        retryDelayMs: 4200,
        errorStatus: 529,
        error: { type: "overloaded_error" },
      }}
    />,
  );
  const line = screen.getByTestId("model-retry");
  expect(line.textContent).toContain("Model retry 2 of 10: HTTP 529 · overloaded_error");
  expect(line.textContent).toContain("waits 4.2 s");
  const raw = line.querySelector("details") as HTMLDetailsElement;
  expect(raw.open).toBe(false);
  expect(raw.textContent).toContain('"retryDelayMs": 4200');
});

it("says when the reason is unknown", () => {
  expect(retryReason({})).toBeUndefined();
  render(<ModelRetryLine payload={{ attempt: 1 }} />);
  expect(screen.getByTestId("model-retry").textContent).toContain(
    "Model retry 1 of ?: reason not given",
  );
});
