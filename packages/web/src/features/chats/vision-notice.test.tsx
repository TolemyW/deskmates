// @vitest-environment jsdom
// ADR-0023 amendment 2, decision 14 (issue #87): the attach button names the member bots whose
// model cannot see images, and shows nothing when every member's runs are shown images.

import type { ModelCapabilityView, WorkspaceId } from "@deskmates/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../../api/client.js";
import { VisionBadge, useBlindMembers } from "./vision-notice.js";

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

/** The badge as the composer mounts it: fed by the hook. */
function Badge({ client }: { client: ApiClient }) {
  const names = useBlindMembers(client, WS, MEMBERS);
  return <VisionBadge names={names} />;
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
  render(<Badge client={client} />);
  const note = await screen.findByRole("note");
  expect(note.textContent).toContain("bob cannot see images");
  expect(note.getAttribute("title")).toContain("bob cannot see images");
  expect(note.textContent).not.toContain("ada");
  expect(calls).toEqual(["GET /api/workspaces/ws_1/model-capabilities"]);
});

it("derives the policy when an older Gateway sends none", async () => {
  const { visionPolicy: _omit, ...legacy } = blind;
  const { client } = api([{ ...legacy, vision: { ...blind.vision, status: "unsupported" } }]);
  render(<Badge client={client} />);
  expect((await screen.findByRole("note")).textContent).toContain("bob");
});

it("shows nothing when every member can see, or the route refuses", async () => {
  for (const capabilities of [[seeing], "error"] as const) {
    const { client, calls } = api(capabilities === "error" ? "error" : [...capabilities]);
    render(<Badge client={client} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
  }
});
