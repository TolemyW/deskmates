// @vitest-environment jsdom
// ADR-0023 amendment 2, decision 14 (issue #87): a chat names the member bots whose model cannot
// see images, and says nothing when every member's runs are shown images.

import type { ModelCapabilityView, WorkspaceId } from "@deskmates/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { VisionNotice } from "./vision-notice.js";

afterEach(cleanup);

const WS = "ws_1" as WorkspaceId;
const MEMBERS = [
  { botId: "bot_a", name: "ada" },
  { botId: "bot_b", name: "bob" },
];

function api(capabilities: ModelCapabilityView[] | "error") {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (capabilities === "error") return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json({ capabilities });
  });
  return { client: createApiClient({ fetch: fetcher }), calls };
}

const blind: ModelCapabilityView = {
  model: "model-blind",
  vision: { id: "p1", model: "model-blind", status: "unknown", reason: "wrong_answer" },
  visionPolicy: "withhold",
  botIds: ["bot_b"],
};
const seeing: ModelCapabilityView = {
  model: "model-seeing",
  vision: { id: "p2", model: "model-seeing", status: "supported", reason: "verified_answer" },
  visionPolicy: "deliver",
  botIds: ["bot_a"],
};

it("names only the members whose model withholds images, and never probes", async () => {
  const { client, calls } = api([blind, seeing]);
  render(<VisionNotice api={client} workspaceId={WS} members={MEMBERS} />);
  const note = await screen.findByRole("note");
  expect(note.textContent).toContain("bob cannot see images");
  expect(note.textContent).not.toContain("ada");
  expect(calls).toEqual(["GET /api/workspaces/ws_1/model-capabilities"]);
});

it("derives the policy when an older Gateway sends none", async () => {
  const { visionPolicy: _omit, ...legacy } = blind;
  const { client } = api([{ ...legacy, vision: { ...blind.vision, status: "unsupported" } }]);
  render(<VisionNotice api={client} workspaceId={WS} members={MEMBERS} />);
  expect((await screen.findByRole("note")).textContent).toContain("bob");
});

it("shows nothing when every member can see, or the route refuses", async () => {
  for (const capabilities of [[seeing], "error"] as const) {
    const { client, calls } = api(capabilities === "error" ? "error" : [...capabilities]);
    render(<VisionNotice api={client} workspaceId={WS} members={MEMBERS} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
  }
});
