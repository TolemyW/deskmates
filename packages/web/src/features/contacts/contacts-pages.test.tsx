// @vitest-environment jsdom
// T0 web for #113 slice B: the Contacts rail shows one page of the workspace's bots by name with
// the Gateway's total, moves between pages, sends the search to the server and returns to the
// first page when it changes, and ignores a slow answer for an earlier search.

import "@testing-library/jest-dom/vitest";
import type { BotDefinition, BotId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WS_ID, bot, workspace } from "../../test-support/fixtures.js";
import { ContactsScreen } from "./contacts.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", window.location.href);
});

const team: BotDefinition[] = Array.from({ length: 60 }, (_, i) => ({
  ...bot,
  id: `bot_${String(i).padStart(2, "0")}` as BotId,
  name: `agent-${String(i).padStart(2, "0")}`,
  role: i % 3 === 0 ? "Analyst" : "writer",
}));

/** A Gateway that pages by name and searches; the first `q=ana` answer is held back. */
function gateway() {
  const calls: string[] = [];
  let releaseSlow: () => void = () => {};
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://gateway.test");
    calls.push(`${url.pathname}${url.search}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/workspaces") return json({ workspaces: [workspace] });
    if (url.pathname === "/api/bots" && !url.searchParams.has("offset"))
      return json({ bots: team });
    if (url.pathname === "/api/bots") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const matches = team.filter((b) => `${b.name} ${b.role}`.toLowerCase().includes(q));
      const body = {
        bots: matches.slice(offset, offset + limit),
        offset,
        limit,
        total: matches.length,
      };
      if (q === "ana")
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      return json(body);
    }
    if (url.pathname === "/api/runs/latest-by-bot") return json({ runs: [] });
    if (url.pathname === "/api/threads") return json({ threads: [] });
    return json({});
  }) as typeof globalThis.fetch;
  return { fetch, calls, release: () => releaseSlow() };
}

describe("Contacts rail pages (#113 B)", () => {
  it("pages by name with the total and moves to the next page", async () => {
    const g = gateway();
    render(<ContactsScreen api={createApiClient({ fetch: g.fetch })} />);
    await screen.findByText("1–50 of 60");
    expect(g.calls).toContain(`/api/bots?workspaceId=${WS_ID}&offset=0&limit=50`);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("51–60 of 60");
    expect(screen.getAllByText("agent-59").length).toBeGreaterThan(0);
  });

  it("searches on the server, returns to page one and drops a late answer", async () => {
    const g = gateway();
    render(<ContactsScreen api={createApiClient({ fetch: g.fetch })} />);
    await screen.findByText("1–50 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("51–60 of 60");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "ana" } });
    await waitFor(() => expect(g.calls.some((c) => c.includes("q=ana"))).toBe(true));
    // A newer search replaces the held one; the held answer must not land afterwards.
    fireEvent.change(search, { target: { value: "agent-1" } });
    await screen.findAllByText("agent-10");
    g.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("navigation", { name: "Bot pages" })).not.toBeInTheDocument();
    expect(
      g.calls.filter((c) => c.includes("q=agent-1")).every((c) => c.includes("offset=0")),
    ).toBe(true);
    expect(screen.queryByText("agent-03")).toBeNull();
  });
});
