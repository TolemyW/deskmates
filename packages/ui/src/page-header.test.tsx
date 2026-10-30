// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Button, PageHeader } from "./index.js";

afterEach(cleanup);

it("gives every product page one heading, context line and action area", () => {
  render(
    <PageHeader
      title="Tasks"
      description="Plan and review work."
      action={<Button variant="primary">New task</Button>}
    >
      <span>3 open</span>
    </PageHeader>,
  );
  expect(screen.getByRole("heading", { level: 1, name: "Tasks" })).toBeTruthy();
  expect(screen.getByText("Plan and review work.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
  expect(screen.getByText("3 open")).toBeTruthy();
});
