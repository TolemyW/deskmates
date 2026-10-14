// #113 slice S: a workspace's skills page by name with an honest total and server search; the
// confirmation queue and a skill's versions are bounded keyset lists. Limits above the maximum
// and cursors of another list or skill are refused.

import type { Skill, WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const human = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
let sandbox: ReturnType<typeof buildGateway>;
let operator: ReturnType<typeof buildOperatorGateway>;
let workspaceId: WorkspaceId;
let otherWorkspaceId: WorkspaceId;

beforeEach(async () => {
  sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
  const ctx = sandbox.deskmates.ctx;
  workspaceId = ctx.workspaces.create({ name: "skills", sandboxProvider: "docker" }).id;
  otherWorkspaceId = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" }).id;
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

const AT = "2026-10-13T00:00:00.000Z";

/** `count` skills `skill-00`.. with one version each; every third one is held for review. */
function seed(count: number): string[] {
  const store = sandbox.deskmates.ctx.skills.store;
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = `skill-${String(i).padStart(2, "0")}`;
    const id = store.insert({ workspaceId, name, origin: "installed", stage: "active", at: AT });
    store.addVersion(id, {
      op: "install",
      files: [{ path: "SKILL.md", content: name }],
      sha256: "0".repeat(64),
      description: i % 2 ? `odd ${name}` : `even ${name}`,
      review: i % 3 === 0 ? "pending" : "cleared",
      by: "human:web",
      at: AT,
    });
    if (i % 3 !== 0) store.setCurrent(id, 1, AT);
    ids.push(id);
  }
  return ids;
}

async function get(url: string) {
  return operator.inject({ method: "GET", url, headers: human });
}

describe("skill pagination (#113 S)", () => {
  it("pages skills by name with an honest total across three pages", async () => {
    seed(60);
    const base = `/api/workspaces/${workspaceId}/skills`;
    const names: string[] = [];
    for (const offset of [0, 25, 50]) {
      const body = (await get(`${base}?offset=${offset}&limit=25`)).json();
      expect(body).toMatchObject({ offset, limit: 25, total: 60, pendingTotal: 20 });
      names.push(...body.skills.map((s: Skill) => s.name));
    }
    expect(names).toHaveLength(60);
    expect(names).toEqual([...names].sort());
    expect((await get(`${base}?offset=75`)).json()).toMatchObject({ skills: [], total: 60 });
    // The bundled starter catalog still comes whole: it is static, not a growing list.
    expect((await get(base)).json().starterSkills.length).toBeGreaterThan(0);
  });

  it("searches on the server and counts only the matches", async () => {
    seed(30);
    // 15 odd skills; 5 of them are held, so they have no current description yet.
    const body = (await get(`/api/workspaces/${workspaceId}/skills?q=ODD&limit=8`)).json();
    expect(body.total).toBe(10);
    expect(body.skills).toHaveLength(8);
    expect((await get(`/api/workspaces/${workspaceId}/skills?q=skill-2`)).json().total).toBe(10);
    expect(body.skills.every((s: Skill) => s.description.startsWith("odd"))).toBe(true);
  });

  it("walks the whole confirmation queue with a cursor", async () => {
    seed(60);
    const ids: string[] = [];
    let cursor = "";
    for (let pages = 0; pages < 5; pages += 1) {
      const body = (
        await get(
          `/api/workspaces/${workspaceId}/skills/pending?limit=8${cursor ? `&cursor=${cursor}` : ""}`,
        )
      ).json();
      expect(body.total).toBe(20);
      ids.push(...body.pending.map((p: { name: string }) => p.name));
      cursor = body.nextCursor ?? "";
      if (!cursor) break;
    }
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    // A cursor of this workspace's queue is refused for another workspace.
    const first = (await get(`/api/workspaces/${workspaceId}/skills/pending?limit=1`)).json();
    expect(
      (await get(`/api/workspaces/${otherWorkspaceId}/skills/pending?cursor=${first.nextCursor}`))
        .statusCode,
    ).toBe(400);
  });

  it("reads versions newest first in bounded pages", async () => {
    const [id] = seed(1);
    const store = sandbox.deskmates.ctx.skills.store;
    for (let v = 2; v <= 5; v += 1)
      store.addVersion(id as string, {
        op: "revise",
        files: [{ path: "SKILL.md", content: `v${v}` }],
        sha256: "0".repeat(64),
        description: "d",
        review: "cleared",
        by: "human:web",
        at: AT,
      });
    const first = (await get(`/api/skills/${id}/versions?limit=2`)).json();
    expect(first.versions.map((v: { version: number }) => v.version)).toEqual([5, 4]);
    const second = (
      await get(`/api/skills/${id}/versions?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.versions.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    const third = (
      await get(`/api/skills/${id}/versions?limit=2&cursor=${second.nextCursor}`)
    ).json();
    expect(third).toEqual({ versions: [expect.objectContaining({ version: 1 })] });
  });

  it("refuses a limit above the maximum", async () => {
    const [id] = seed(1);
    for (const url of [
      `/api/workspaces/${workspaceId}/skills?limit=101`,
      `/api/workspaces/${workspaceId}/skills/pending?limit=101`,
      `/api/skills/${id}/versions?limit=101`,
      `/api/workspaces/${workspaceId}/skills?offset=-1`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
    }
  });
});
