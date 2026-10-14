// @vitest-environment jsdom
// ADR-0015 consequences, on the Skills page of issue #27: rows show name, description, stage,
// who a skill is enabled for and when it was last used; origin, hash, scan findings and history
// are in a detail panel; "needs your confirmation" shows why a version is held and the scan's
// findings, with confirm and reject, only when something waits; a human installs by the
// reviewed hash, which the screen computes the same way the Gateway does, from a form that
// opens on demand.
import "@testing-library/jest-dom/vitest";

import { createHash } from "node:crypto";
import {
  type BotDefinition,
  type Skill,
  type SkillVersion,
  type StarterSkill,
  type WorkspaceId,
  skillHashInput,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillsView } from "../../api/client.js";
import { selectOption } from "../../test-support/select.js";
import { type SkillsApi, SkillsPanel, skillSha256 } from "./skills.js";

afterEach(cleanup);

const WS = "ws_1" as WorkspaceId;
const bots = [
  { id: "bot_nova", name: "nova", workspaceId: WS },
  { id: "bot_orion", name: "orion", workspaceId: WS },
] as unknown as BotDefinition[];

function skill(over: Partial<Skill> & { id: string; name: string }): Skill {
  return {
    workspaceId: WS,
    description: `${over.name} description`,
    origin: "authored",
    stage: "provisional",
    assignments: [],
    version: 1,
    sha256: "ab".repeat(32),
    pinned: false,
    listedSince: "2026-10-01T00:00:00.000Z",
    pendingVersions: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  } as Skill;
}

const pending: SkillVersion & { name: string } = {
  skillId: "skill_held",
  name: "fetch-rates",
  version: 1,
  op: "install",
  files: [
    { path: "SKILL.md", content: "---\nname: fetch-rates\ndescription: x\n---\nRun it." },
    { path: "fetch.sh", content: "#!/bin/sh" },
  ],
  sha256: "cd".repeat(32),
  description: "x",
  review: "pending",
  holdReasons: ["scan_findings"],
  findings: [
    { kind: "executable_file", path: "fetch.sh", detail: "script file extension" },
    { kind: "off_allowlist_url", path: "SKILL.md", line: 5, detail: "rates.elsewhere.example" },
  ],
  derivedFrom: [],
  by: "human:user:owner",
  createdAt: "2026-10-02T00:00:00.000Z",
};

type SkillsFixture = Pick<SkillsView, "skills"> &
  Partial<Pick<SkillsView, "starterPack" | "starterSkills">> & {
    pending: (SkillVersion & { name: string })[];
  };

/** A fake Gateway that pages and searches like the real one (#113). */
function fakeApi(view: SkillsFixture) {
  const catalog = {
    starterPack: view.starterPack ?? { version: "1.0.0", sha256: "ef".repeat(32) },
    starterSkills: view.starterSkills ?? [],
  };
  return {
    listSkills: vi.fn(
      async (
        _ws: WorkspaceId,
        { q = "", offset = 0, limit = 25 }: { q?: string; offset?: number; limit?: number } = {},
      ): Promise<SkillsView> => {
        const needle = q.toLowerCase();
        const matched = view.skills.filter(
          (s) =>
            !needle ||
            s.name.toLowerCase().includes(needle) ||
            s.description.toLowerCase().includes(needle),
        );
        return {
          ...catalog,
          skills: matched.slice(offset, offset + limit),
          offset,
          limit,
          total: matched.length,
          pendingTotal: view.pending.length,
        };
      },
    ),
    listPendingSkillVersions: vi.fn(
      async (
        _ws: WorkspaceId,
        { cursor, limit = 25 }: { cursor?: string; limit?: number } = {},
      ) => {
        const start = Number(cursor ?? 0);
        const next = start + limit;
        return {
          pending: view.pending.slice(start, next),
          total: view.pending.length,
          ...(next < view.pending.length ? { nextCursor: String(next) } : {}),
        };
      },
    ),
    installSkill: vi.fn(async () => ({
      skill: skill({ id: "skill_new", name: "new-skill", origin: "installed" }),
      version: { ...pending, review: "cleared" as const },
    })),
    confirmSkillVersion: vi.fn(async () => skill({ id: "skill_held", name: "fetch-rates" })),
    rejectSkillVersion: vi.fn(async () => skill({ id: "skill_held", name: "fetch-rates" })),
    assignSkill: vi.fn(async () => skill({ id: "skill_a", name: "export-refunds" })),
    updateSkill: vi.fn(async () => skill({ id: "skill_a", name: "export-refunds" })),
    undoSkill: vi.fn(async () => skill({ id: "skill_a", name: "export-refunds" })),
    listSkillVersions: vi.fn(
      async (
        _id: string,
        { cursor }: { cursor?: string; limit?: number } = {},
      ): Promise<{ versions: SkillVersion[]; nextCursor?: string }> =>
        cursor
          ? {
              versions: [
                { ...pending, skillId: "skill_b", version: 1, review: "cleared", findings: [] },
              ],
            }
          : {
              versions: [
                {
                  ...pending,
                  skillId: "skill_b",
                  version: 2,
                  op: "revise",
                  review: "cleared",
                  findings: [{ kind: "credential", path: "SKILL.md", detail: "api key shape" }],
                },
              ],
              nextCursor: "older",
            },
    ),
  } satisfies SkillsApi;
}

const starter: StarterSkill = {
  id: "starter:web-research-citations",
  name: "web-research-citations",
  description: "Research with sources.",
  category: "research",
  origin: "Deskmates",
  license: "Apache-2.0",
  version: 1,
  sha256: "12".repeat(32),
};

function renderPanel(api: SkillsApi) {
  return render(<SkillsPanel api={api} workspaceId={WS} workspaceName="ops" bots={bots} />);
}

it("lists skills with who they are enabled for and confirms a held version", async () => {
  const api = fakeApi({
    skills: [
      skill({ id: "skill_a", name: "export-refunds", authorBotId: "bot_nova" as never }),
      skill({
        id: "skill_b",
        name: "pdf-forms",
        origin: "installed",
        stage: "active",
        version: 2,
        assignments: [
          { botId: "bot_orion" as never, basis: "human", by: "human:x", createdAt: "t" },
        ],
        lastUsedAt: "2026-10-05T10:00:00.000Z",
        pinned: true,
      }),
    ],
    pending: [pending],
  });
  renderPanel(api);
  const list = await screen.findByRole("list", { name: "Workspace skills" });
  await waitFor(() => expect(within(list).getByText("export-refunds")).toBeTruthy());
  const provisional = list.querySelector('[data-skill="export-refunds"]') as HTMLElement;
  expect(within(provisional).getByText("nova only")).toBeTruthy();
  expect(within(provisional).getByText("provisional")).toBeTruthy();
  expect(within(provisional).getByText("never")).toBeTruthy();
  const installed = list.querySelector('[data-skill="pdf-forms"]') as HTMLElement;
  expect(within(installed).getByText("orion")).toBeTruthy();
  expect(within(installed).getByText("2026-10-05")).toBeTruthy();
  expect(within(installed).getByText(/pinned/)).toBeTruthy();
  // Hashes stay out of the rows.
  expect(installed).not.toHaveTextContent("abababab");
  // No install form until asked for.
  expect(screen.queryByRole("region", { name: "Install a skill" })).toBeNull();

  expect(screen.getByText("1 waiting for review")).toBeTruthy();
  const held = screen.getByRole("region", { name: "Skills needing confirmation" });
  expect(within(held).getByText(/Held because the scan found something/)).toBeTruthy();
  expect(within(held).getByText(/executable file in fetch.sh/)).toBeTruthy();
  expect(
    within(held).getByText(/off allowlist url in SKILL.md:5: rates.elsewhere.example/),
  ).toBeTruthy();
  fireEvent.click(within(held).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.confirmSkillVersion).toHaveBeenCalledWith("skill_held", 1));
  await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2));
  expect(api.listPendingSkillVersions).toHaveBeenCalledTimes(2);
});

it("shows no confirmation section, list or form when there are no skills", async () => {
  const api = fakeApi({ skills: [], pending: [] });
  renderPanel(api);
  expect(await screen.findByText(/No skills yet/)).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Skills needing confirmation" })).toBeNull();
  expect(screen.queryByRole("list", { name: "Workspace skills" })).toBeNull();
  expect(screen.queryByLabelText("SKILL.md")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Install skill" })).toHaveLength(1);
});

it("shows built-in Starter Skills as shared, read-only release assets", async () => {
  const api = fakeApi({ skills: [], pending: [], starterSkills: [starter] });
  renderPanel(api);
  const section = await screen.findByRole("region", { name: "Built-in Starter Skills" });
  expect(within(section).getByText(/1 release-bundled skills · pack 1.0.0/)).toBeInTheDocument();
  fireEvent.click(within(section).getByText("web-research-citations"));
  expect(within(section).getByText("Apache-2.0")).toBeInTheDocument();
  expect(within(section).getByText("All bots in this workspace")).toBeInTheDocument();
  expect(within(section).getByText(starter.sha256)).toBeInTheDocument();
  expect(within(section).queryByRole("button", { name: /assign/i })).toBeNull();
});

it("shows its rows under StrictMode's double mount, as the app renders it", async () => {
  const api = fakeApi({ skills: [skill({ id: "skill_a", name: "export-refunds" })], pending: [] });
  render(
    <StrictMode>
      <SkillsPanel api={api} workspaceId={WS} workspaceName="ops" bots={bots} />
    </StrictMode>,
  );
  expect(await screen.findByText("export-refunds")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "More actions for export-refunds" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
  expect(await screen.findByRole("status")).toHaveTextContent("export-refunds pinned.");
});

it("filters by name or description", async () => {
  const api = fakeApi({
    skills: [
      skill({ id: "skill_a", name: "export-refunds" }),
      skill({ id: "skill_b", name: "pdf-forms", description: "Fill tax forms" }),
    ],
    pending: [],
  });
  renderPanel(api);
  const list = await screen.findByRole("list", { name: "Workspace skills" });
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
    target: { value: "TAX" },
  });
  // The Gateway searches, after typing pauses (#113).
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
  expect(api.listSkills).toHaveBeenLastCalledWith(WS, { q: "TAX", offset: 0, limit: 25 });
  expect(within(list).getByText("pdf-forms")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
    target: { value: "nothing" },
  });
  expect(await screen.findByText("No skills match “nothing”.")).toBeTruthy();
});

it("shows origin, hash, scans and history in details, and moves a stage there", async () => {
  const api = fakeApi({
    skills: [
      skill({
        id: "skill_b",
        name: "pdf-forms",
        origin: "installed",
        stage: "active",
        version: 2,
        provenance: "example.org/acme/skills v2",
      }),
    ],
    pending: [],
  });
  renderPanel(api);
  fireEvent.click(await screen.findByRole("button", { name: /^pdf-forms/ }));
  const detail = await screen.findByRole("complementary", { name: "Skill details" });
  expect(detail).toHaveTextContent("installed");
  expect(detail).toHaveTextContent("ab".repeat(32));
  expect(detail).toHaveTextContent("example.org/acme/skills v2");
  const history = await within(detail).findByRole("region", { name: "Version history" });
  await waitFor(() => expect(history).toHaveTextContent("v2"));
  expect(history).toHaveTextContent("credential in SKILL.md: api key shape");
  expect(api.listSkillVersions).toHaveBeenCalledWith("skill_b", { limit: 25 });
  // Newest first; older versions load on request with the cursor (#113).
  expect(history).not.toHaveTextContent("v1 ");
  fireEvent.click(within(history).getByRole("button", { name: "Load older versions" }));
  await waitFor(() =>
    expect(api.listSkillVersions).toHaveBeenLastCalledWith("skill_b", {
      cursor: "older",
      limit: 25,
    }),
  );
  await waitFor(() =>
    expect(within(history).queryByRole("button", { name: "Load older versions" })).toBeNull(),
  );
  expect(within(history).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
  await selectOption(within(detail).getByLabelText("Stage of pdf-forms"), "archived");
  await waitFor(() =>
    expect(api.updateSkill).toHaveBeenCalledWith("skill_b", { stage: "archived" }),
  );
});

it("pins, undoes and assigns from the row's action menu", async () => {
  const api = fakeApi({
    skills: [
      skill({
        id: "skill_a",
        name: "export-refunds",
        authorBotId: "bot_nova" as never,
        version: 2,
      }),
    ],
    pending: [],
  });
  renderPanel(api);
  const menu = await screen.findByRole("button", { name: "More actions for export-refunds" });
  fireEvent.click(menu);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
  await waitFor(() => expect(api.updateSkill).toHaveBeenCalledWith("skill_a", { pinned: true }));
  fireEvent.click(menu);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Undo" }));
  await waitFor(() => expect(api.undoSkill).toHaveBeenCalledWith("skill_a"));
  fireEvent.click(menu);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Assign" }));
  const dialog = await screen.findByRole("dialog", { name: "Assign export-refunds" });
  fireEvent.click(within(dialog).getByLabelText("orion"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.assignSkill).toHaveBeenCalledWith("skill_a", ["bot_orion"]));
});

it("disables Undo for a skill with no previous version", async () => {
  const api = fakeApi({ skills: [skill({ id: "skill_a", name: "export-refunds" })], pending: [] });
  renderPanel(api);
  fireEvent.click(await screen.findByRole("button", { name: "More actions for export-refunds" }));
  expect(await screen.findByRole("menuitem", { name: "Undo" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("installs by the reviewed hash, computed like the Gateway's", async () => {
  const api = fakeApi({ skills: [], pending: [] });
  renderPanel(api);
  const content = "---\nname: new-skill\ndescription: Do the thing.\n---\n\nSteps.\n";
  const expected = createHash("sha256")
    .update(skillHashInput([{ path: "SKILL.md", content }]))
    .digest("hex");
  expect(await skillSha256([{ path: "SKILL.md", content }])).toBe(expected);

  fireEvent.click(await screen.findByRole("button", { name: "Install skill" }));
  const form = screen.getByRole("region", { name: "Install a skill" });
  fireEvent.change(within(form).getByLabelText("SKILL.md"), { target: { value: content } });
  await waitFor(() => expect(within(form).getByText(expected)).toBeTruthy());
  fireEvent.change(within(form).getByLabelText("Reviewed SHA-256"), {
    target: { value: expected },
  });
  fireEvent.click(within(form).getByLabelText("Install for orion"));
  fireEvent.click(within(form).getByRole("button", { name: "Install" }));
  await waitFor(() =>
    expect(api.installSkill).toHaveBeenCalledWith(WS, {
      files: [{ path: "SKILL.md", content }],
      sha256: expected,
      botIds: ["bot_orion"],
    }),
  );
  expect(await screen.findByText("new-skill installed.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Install a skill" })).toBeNull();
});

it("closes the install form without installing", async () => {
  const api = fakeApi({ skills: [], pending: [] });
  renderPanel(api);
  fireEvent.click(await screen.findByRole("button", { name: "Install skill" }));
  const form = screen.getByRole("region", { name: "Install a skill" });
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("region", { name: "Install a skill" })).toBeNull();
  expect(api.installSkill).not.toHaveBeenCalled();
});

it("pages skills and the whole confirmation queue with honest totals (#113)", async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    skill({ id: `skill_${i}`, name: `skill-${String(i).padStart(2, "0")}` }),
  );
  const queue = Array.from({ length: 27 }, (_, i) => ({
    ...pending,
    skillId: `held_${i}`,
    name: `held-${String(i).padStart(2, "0")}`,
  }));
  const api = fakeApi({ skills: many, pending: queue });
  renderPanel(api);
  const skillsNav = await screen.findByRole("navigation", { name: "Skill pages" });
  expect(skillsNav).toHaveTextContent("1–25 of 30");
  fireEvent.click(within(skillsNav).getByRole("button", { name: "Next" }));
  await screen.findByText("skill-29");
  expect(screen.queryByText("skill-00")).toBeNull();
  expect(skillsNav).toHaveTextContent("26–30 of 30");

  // The heading and the toolbar count the whole queue, not the 25 rows shown.
  expect(screen.getByText("Waiting for review (27)")).toBeTruthy();
  expect(screen.getByText("27 waiting for review")).toBeTruthy();
  const queueNav = screen.getByRole("navigation", { name: "Confirmation queue pages" });
  fireEvent.click(within(queueNav).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(queueNav).toHaveTextContent("26–27 of 27"));
  expect(api.listPendingSkillVersions).toHaveBeenLastCalledWith(WS, { cursor: "25", limit: 25 });
});
