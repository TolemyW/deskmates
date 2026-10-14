// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.js";

afterEach(cleanup);
it("preserves named table semantics, column headers, and independently operable cell controls", () => {
  const action = vi.fn();
  render(
    <Table aria-label="Members">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Alex</TableCell>
          <TableCell>
            <button type="button" onClick={action}>
              View Alex
            </button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
  const table = screen.getByRole("table", { name: "Members" });
  expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Members" }).tabIndex).toBe(0);
  fireEvent.click(within(table).getByRole("button", { name: "View Alex" }));
  expect(action).toHaveBeenCalledOnce();
});
it("supports one semantic empty row spanning the table columns", () => {
  render(
    <Table aria-label="Files">
      <TableBody>
        <TableRow>
          <TableCell colSpan={4}>No files yet.</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
  expect(screen.getByRole("cell").getAttribute("colspan")).toBe("4");
});
