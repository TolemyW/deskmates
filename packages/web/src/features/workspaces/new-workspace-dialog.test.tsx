// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { NewWorkspaceDialog } from "./new-workspace-dialog.js";

afterEach(cleanup);

it("locks creation while pending, preserves a failed draft, and resets after closing", async () => {
  let rejectCreate: (reason: Error) => void = () => {};
  const createWorkspace = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      }),
  );
  const created = vi.fn();
  function Preview() {
    const [open, setOpen] = useState(true);
    const opener = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={opener} type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <NewWorkspaceDialog
          api={{ createWorkspace } as unknown as ApiClient}
          open={open}
          onClose={() => setOpen(false)}
          onCreated={created}
          onReturnFocus={() => opener.current?.focus()}
        />
      </>
    );
  }
  render(<Preview />);
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "research" } });
  fireEvent.click(screen.getByRole("radio", { name: /Only these sites/ }));
  fireEvent.change(screen.getByLabelText("Allowed websites (one per line)"), {
    target: { value: "example.test" },
  });
  const form = screen.getByRole("form", { name: "New workspace" });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(createWorkspace).toHaveBeenCalledOnce();
  expect(createWorkspace).toHaveBeenCalledWith({
    name: "research",
    egressAllowlist: ["example.test"],
  });
  expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  expect(screen.getByRole("radio", { name: /Open public internet/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close new workspace" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(async () => {
    rejectCreate(new Error("Create unavailable"));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Create unavailable");
  expect(screen.getByLabelText(/^Name/)).toHaveValue("research");
  expect(screen.getByLabelText("Allowed websites (one per line)")).toHaveValue("example.test");
  fireEvent.click(screen.getByRole("button", { name: "Close new workspace" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByLabelText(/^Name/)).toHaveValue("");
  expect(screen.getByRole("radio", { name: /Open public internet/ })).toBeChecked();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(created).not.toHaveBeenCalled();
});
