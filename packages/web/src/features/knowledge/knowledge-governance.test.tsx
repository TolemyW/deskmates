// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeGovernance, type KnowledgeGovernanceApi } from "./knowledge-governance.js";

afterEach(cleanup);

it("paginates governance records and points learned memory to its own page", async () => {
  const api = {
    listKnowledgePage: vi.fn(async ({ cursor }: { cursor?: string } = {}) =>
      cursor
        ? { documents: [{ id: "kb_2", title: "Second", excerpt: "two", version: 1 }] }
        : {
            documents: [{ id: "kb_1", title: "First", excerpt: "one", version: 2 }],
            nextCursor: "docs-next",
          },
    ),
    listKnowledgeProposalsPage: vi.fn(async () => ({
      proposals: [],
    })),
    listKnowledgeHistory: vi.fn(async () => ({
      versions: [
        {
          documentId: "kb_1",
          version: 2,
          title: "First",
          body: "current",
          approvedBy: "human:web",
          createdAt: "now",
          sourceRunId: "run_knowledge",
        },
      ],
    })),
    cleanupKnowledgeVersions: vi.fn(async () => ({ removed: 1, retained: 2 })),
  } as unknown as KnowledgeGovernanceApi;

  render(<KnowledgeGovernance api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "History for First · v2" }));
  expect(await screen.findByLabelText("Knowledge history")).toHaveProperty(
    "textContent",
    expect.stringContaining("current"),
  );
  expect(
    screen
      .getAllByRole("link", { name: "Source run" })
      .some((link) => link.getAttribute("href") === "#/runs/run_knowledge"),
  ).toBe(true);
  // An explicit pager replaces "Load more" (#113): the next page replaces the first.
  const pages = screen.getByRole("navigation", { name: "Published document pages" });
  expect(pages.textContent).toContain("1–1 of more");
  fireEvent.click(within(pages).getByRole("button", { name: "Next" }));
  await screen.findByRole("button", { name: "History for Second · v1" });
  expect(screen.queryByRole("button", { name: "History for First · v2" })).toBeNull();
  expect(within(pages).getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
  fireEvent.click(within(pages).getByRole("button", { name: "Previous" }));
  await screen.findByRole("button", { name: "History for First · v2" });
  expect(api.listKnowledgePage).toHaveBeenLastCalledWith({ limit: 25 });
  fireEvent.click(screen.getByRole("button", { name: "Clean up orphan version files" }));
  await screen.findByText(/Removed 1 orphan file/);

  expect(screen.getByRole("link", { name: "Observations" }).getAttribute("href")).toBe(
    "#/knowledge/observations",
  );
  expect(screen.queryByRole("button", { name: "Apply to memory" })).toBeNull();
});
