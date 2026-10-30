// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { DatabasesTab } from "./databases-tab.js";

afterEach(cleanup);

it("retries an unavailable database list without reporting zero connections", async () => {
  const onCount = vi.fn();
  const listConnectors = vi
    .fn()
    .mockRejectedValueOnce(new Error("Database list unavailable"))
    .mockResolvedValue({ connectors: [], total: 0 });
  const api = { listConnectors } as unknown as ApiClient;
  render(<DatabasesTab api={api} workspaceId="ws_db" onCount={onCount} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Database list unavailable");
  expect(onCount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(onCount).toHaveBeenCalledWith(0));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(listConnectors).toHaveBeenCalledTimes(2);
});

it("clears canceled database credentials and fields on reopening", async () => {
  const registerConnector = vi.fn();
  const api = {
    listConnectors: vi.fn().mockResolvedValue({ connectors: [], total: 0 }),
    registerConnector,
  } as unknown as ApiClient;
  render(<DatabasesTab api={api} workspaceId="ws_db" />);
  fireEvent.click(screen.getByRole("button", { name: "Register a database" }));
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "test-db" } });
  fireEvent.change(screen.getByLabelText("Connector URL"), {
    target: { value: "http://connector.test" },
  });
  fireEvent.change(screen.getByLabelText("Credential"), {
    target: { value: "test-only-canceled" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Register a database" }));
  expect(await screen.findByLabelText("Name")).toHaveValue("");
  expect(screen.getByLabelText("Connector URL")).toHaveValue("");
  expect(screen.getByLabelText("Credential")).toHaveValue("");
  expect(registerConnector).not.toHaveBeenCalled();
});
