// @vitest-environment jsdom
// Issue #87: the bot's model shows what the vision probe established; reading it never probes,
// and an unconfirmed result offers an explicit Retry.

import type { VisionProbeView, WorkspaceId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { VisionCapability } from "./model-capability.js";

afterEach(cleanup);

function server(vision: VisionProbeView) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === "/api/workspaces/ws_1/model-capabilities")
      return Response.json({ capabilities: [{ model: "model-a", vision }] });
    if (method === "POST" && path === "/api/workspaces/ws_1/model-capabilities/vision/probe")
      return Response.json(
        { probe: { ...vision, id: "probe_2", status: "pending", reason: null } },
        { status: 202 },
      );
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

const WS = "ws_1" as WorkspaceId;

it("shows a wrong answer as unconfirmed with its receipt and retries only on request", async () => {
  const { api, calls } = server({
    id: "probe_1",
    model: "model-a",
    status: "unknown",
    reason: "wrong_answer",
    answer: "GOING BEYOND COUNTING EYEBALLS",
  });
  render(<VisionCapability api={api} workspaceId={WS} model="model-a" />);
  await screen.findByText("unconfirmed");
  expect(screen.getByText(/may describe images it cannot see/)).toBeTruthy();
  expect(screen.getByText("Test answer: GOING BEYOND COUNTING EYEBALLS")).toBeTruthy();
  // ADR-0023 amendment 2: the observed confabulation withholds images from this model's runs.
  expect(screen.getByTestId("vision-withheld").textContent).toContain("not shown images");
  expect(calls.every((c) => c.startsWith("GET"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test again" }));
  await waitFor(() =>
    expect(calls).toContain("POST /api/workspaces/ws_1/model-capabilities/vision/probe"),
  );
  await screen.findByText("checking…");
});

it("shows a verified result without a Retry", async () => {
  const { api } = server({
    id: "probe_1",
    model: "model-a",
    status: "supported",
    reason: "verified_answer",
  });
  render(<VisionCapability api={api} workspaceId={WS} model="model-a" />);
  await screen.findByText("works");
  expect(screen.queryByRole("button", { name: "Test again" })).toBeNull();
  expect(screen.queryByTestId("vision-withheld")).toBeNull();
});

it("says an unsupported model's runs are not shown images", async () => {
  const { api } = server({
    id: "probe_1",
    model: "model-a",
    status: "unsupported",
    reason: "explicit_refusal",
  });
  render(<VisionCapability api={api} workspaceId={WS} model="model-a" />);
  await screen.findByText("not supported");
  expect(screen.getByTestId("vision-withheld")).toBeTruthy();
});
