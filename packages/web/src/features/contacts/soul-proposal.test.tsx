// @vitest-environment jsdom
// Issue #77: drafting SOUL.md with AI is inert until applied, shows the real diff against the
// loaded version, keeps unsaved work, and turns a version conflict into a fresh draft.

import type { BotDefinition, SoulProposal } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SoulProposalPanel } from "./soul-proposal.js";

afterEach(cleanup);

const bot = {
  id: "bot_1",
  workspaceId: "ws_1",
  name: "triage",
  role: "Support",
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-09-23T00:00:00.000Z",
} as unknown as BotDefinition;

const BASE = "# Triage\nAnswer tickets.\n\n## Notes\nHuman note, keep.\n";
const PROPOSED = "# Triage\nAnswer tickets and tag duplicates.\n\n## Notes\nHuman note, keep.\n";

function proposal(status: SoulProposal["status"], extra: Partial<SoulProposal> = {}): SoulProposal {
  return {
    id: "soulp_1",
    botId: "bot_1",
    mode: "edit",
    instruction: "tag duplicates",
    status,
    baseVersion: "v1",
    baseBody: BASE,
    proposedBody: status === "ready" || status === "applied" ? PROPOSED : null,
    runId: "run_1",
    error: status === "failed" ? "model unavailable" : null,
    appliedVersion: status === "applied" ? "v2" : null,
    requestedBy: "user:u",
    createdAt: "2026-10-13T00:00:00.000Z",
    finishedAt: null,
    ...extra,
  };
}

function server(opts: { final?: SoulProposal; applyStatus?: number } = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/bots/bot_1/soul-proposals")
      return Response.json({ proposal: proposal("pending") }, { status: 202 });
    if (method === "GET" && path === "/api/bots/bot_1/soul-proposals/soulp_1")
      return Response.json({ proposal: opts.final ?? proposal("ready") });
    if (path.endsWith("/apply")) {
      if (opts.applyStatus === 409)
        return Response.json(
          { code: "invalid_transition", message: "SOUL changed", details: {} },
          { status: 409 },
        );
      return Response.json({
        proposal: proposal("applied"),
        soul: { body: PROPOSED, version: "v2" },
      });
    }
    if (path.endsWith("/discard")) return Response.json({ proposal: proposal("discarded") });
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

it("previews the exact change and applies only on confirm", async () => {
  const { api, calls } = server();
  const onApplied = vi.fn();
  render(<SoulProposalPanel api={api} bot={bot} loadedVersion="v1" onApplied={onApplied} />);
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "tag duplicates" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Draft" }));
  const diff = await screen.findByLabelText("Proposed changes", {}, { timeout: 3000 });
  const changed = [...diff.querySelectorAll("[data-kind]")]
    .filter((line) => line.getAttribute("data-kind") !== "same")
    .map((line) => `${line.getAttribute("data-kind")}:${line.textContent?.trim()}`);
  expect(changed).toEqual([
    "removed:- Answer tickets.",
    "added:+ Answer tickets and tag duplicates.",
  ]);
  expect(diff.textContent).toContain("Human note, keep.");
  expect(calls.some((c) => c.endsWith("/apply"))).toBe(false);
  expect(onApplied).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ body: PROPOSED, version: "v2" }));
  expect(calls.filter((c) => c.endsWith("/apply"))).toHaveLength(1);
});

it("holds drafting while the screen has unsaved edits", () => {
  const { api } = server();
  render(<SoulProposalPanel api={api} bot={bot} loadedVersion="v1" disabled onApplied={vi.fn()} />);
  expect(screen.getByText("Save or discard your own edits first.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Draft" }) as HTMLButtonElement).disabled).toBe(true);
});

it("refuses to apply a draft made against another version and offers a fresh one", async () => {
  const { api, calls } = server({ final: proposal("ready", { baseVersion: "v0" }) });
  render(
    <SoulProposalPanel
      api={api}
      bot={bot}
      loadedVersion="v1"
      initialInstruction="tag duplicates"
      autoStart
      onApplied={vi.fn()}
    />,
  );
  await screen.findByText(/changed since this draft was made/, {}, { timeout: 3000 });
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard and draft again" }));
  await waitFor(() => expect(calls.some((c) => c.endsWith("/discard"))).toBe(true));
  expect(calls.some((c) => c.endsWith("/apply"))).toBe(false);
});

it("shows a conflict from the server and a failed generation without writing anything", async () => {
  const conflict = server({ applyStatus: 409 });
  render(
    <SoulProposalPanel
      api={conflict.api}
      bot={bot}
      loadedVersion="v1"
      initialInstruction="tag duplicates"
      autoStart
      onApplied={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Apply" }, { timeout: 3000 }));
  await screen.findByText(/changed since this draft was made/);
  cleanup();

  const failed = server({ final: proposal("failed") });
  const onApplied = vi.fn();
  render(
    <SoulProposalPanel
      api={failed.api}
      bot={bot}
      loadedVersion="v1"
      initialInstruction="tag duplicates"
      autoStart
      onApplied={onApplied}
    />,
  );
  await screen.findByText(/No draft: model unavailable/, {}, { timeout: 3000 });
  expect(onApplied).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Draft" }) as HTMLButtonElement).disabled).toBe(false);
});
