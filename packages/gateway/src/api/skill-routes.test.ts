// T1: the skill operator routes (ADR-0015 decisions 3, 4, 5, 7 over HTTP). An Admin installs by
// hash; a held install waits in "needs your confirmation" until an Admin confirms it; a Member
// reads skills but cannot install, confirm, assign or move them; every write is recorded as the
// signed-in human; a skill of another workspace's path is not found.

import { createHash } from "node:crypto";
import {
  CSRF_HEADER,
  type Skill,
  type SkillFile,
  type SkillVersion,
  type StarterSkill,
  skillHashInput,
  skillMarkdown,
} from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "../auth/tokens.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { FIXTURE_PASSWORD, type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";

let app: FastifyInstance;
let A: TenantFixture;
let member: { token: string; csrf: string; userId: string };

beforeAll(async () => {
  app = buildGateway(
    testConfig({
      secretsKey: Buffer.alloc(32, 7).toString("base64"),
      auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
    }),
    new FakeProvider(),
    { surface: "combined-test", startCron: false },
  );
  await app.ready();
  app.deskmates.scheduler.stop();
  const ctx = app.deskmates.ctx;
  A = await seedTenant(ctx, "A");
  const user = await ctx.auth.createUser({
    loginName: "member-a",
    displayName: "Member A",
    password: FIXTURE_PASSWORD,
    role: "member",
    tenantId: A.tenantId,
  });
  const { token } = await ctx.auth.login("member-a", FIXTURE_PASSWORD, "fixture-member");
  member = { token, csrf: csrfTokenFor(token), userId: user.id };
});
afterAll(async () => {
  await app.close();
});

function as(who: { token: string; csrf: string }, method: string, url: string, payload?: unknown) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: {
      cookie: `${SESSION}=${who.token}`,
      host: HOST,
      origin: `http://${HOST}`,
      [CSRF_HEADER]: who.csrf,
    },
  };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies: the inject typing wants a narrower payload type than tests need.
  return app.inject(options as unknown as InjectOptions);
}

function skillFiles(name: string, body: string, extra: SkillFile[] = []): SkillFile[] {
  return [
    { path: "SKILL.md", content: skillMarkdown({ name, description: `${name}.`, body }) },
    ...extra,
  ];
}
const sha = (files: SkillFile[]) =>
  createHash("sha256").update(skillHashInput(files)).digest("hex");

describe("skill routes", () => {
  it("lets an Admin install by hash and a Member read, but not change", async () => {
    const files = skillFiles("weekly-report", "Collect the numbers and post the table.");
    const url = `/api/workspaces/${A.ids.workspace}/skills`;
    const body = { files, sha256: sha(files), botIds: [A.ids.bot] };

    const denied = await as(member, "POST", url, body);
    expect(denied.statusCode).toBe(403);
    const wrongHash = await as(A, "POST", url, { ...body, sha256: "0".repeat(64) });
    expect(wrongHash.statusCode).toBe(400);

    const installed = await as(A, "POST", url, body);
    expect(installed.statusCode).toBe(201);
    const { skill, version } = installed.json() as { skill: Skill; version: SkillVersion };
    expect(skill).toMatchObject({ origin: "installed", stage: "active", version: 1 });
    expect(version.by).toBe(`human:user:${A.ownerUserId}`);

    const listed = await as(member, "GET", url);
    expect(listed.statusCode).toBe(200);
    const view = listed.json() as {
      starterPack: { version: string; sha256: string };
      starterSkills: StarterSkill[];
      skills: Skill[];
    };
    expect(view.starterPack).toMatchObject({ version: "1.0.0" });
    expect(view.starterPack.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(view.starterSkills.map((item) => item.name)).toContain("web-research-citations");
    expect(view.starterSkills.every((item) => item.id.startsWith("starter:"))).toBe(true);
    const names = view.skills.map((s) => s.name);
    expect(names).toContain("weekly-report");
    const versions = await as(member, "GET", `/api/skills/${skill.id}/versions`);
    expect((versions.json() as { versions: SkillVersion[] }).versions).toHaveLength(1);
    const refs = await as(member, "GET", `/api/skills/versions?refs=${skill.id}@1,nope@1`);
    expect((refs.json() as { versions: { name: string }[] }).versions.map((v) => v.name)).toEqual([
      "weekly-report",
    ]);

    for (const [method, path, payload] of [
      ["PATCH", `/api/skills/${skill.id}`, { stage: "archived" }],
      ["POST", `/api/skills/${skill.id}/assign`, { botIds: [] }],
      ["POST", `/api/skills/${skill.id}/undo`, {}],
    ] as const) {
      expect((await as(member, method, path, payload)).statusCode, path).toBe(403);
    }
  });

  it("holds an install with findings until an Admin confirms it", async () => {
    const files = skillFiles("fetch-rates", "Run the helper.", [
      { path: "fetch.sh", content: "#!/bin/sh\ncurl https://rates.elsewhere.example/today\n" },
    ]);
    const res = await as(A, "POST", `/api/workspaces/${A.ids.workspace}/skills`, {
      files,
      sha256: sha(files),
    });
    expect(res.statusCode).toBe(201);
    const { skill, version } = res.json() as { skill: Skill; version: SkillVersion };
    expect(version.review).toBe("pending");
    expect(version.findings.map((f) => f.kind).sort()).toEqual([
      "executable_file",
      "off_allowlist_url",
    ]);
    expect(skill.version).toBe(0);

    const pending = await as(member, "GET", `/api/workspaces/${A.ids.workspace}/skills/pending`);
    expect(
      (pending.json() as { pending: { name: string; version: number }[] }).pending.map(
        (p) => p.name,
      ),
    ).toContain("fetch-rates");
    expect(
      (await as(member, "POST", `/api/skills/${skill.id}/versions/1/confirm`, {})).statusCode,
    ).toBe(403);
    const confirmed = await as(A, "POST", `/api/skills/${skill.id}/versions/1/confirm`, {});
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { skill: Skill }).skill.version).toBe(1);
    const again = await as(A, "POST", `/api/skills/${skill.id}/versions/1/confirm`, {});
    expect(again.statusCode).toBe(409);
  });

  it("refuses a promotion whose comparison does not meet the decision rule", async () => {
    // Installs its own skill: reading the one the first test installed made this test depend on
    // run order (404 instead of 409 when run alone or shuffled; issue #68).
    const files = skillFiles("promo-rule", "Promote only on a real comparison.");
    const installed = await as(A, "POST", `/api/workspaces/${A.ids.workspace}/skills`, {
      files,
      sha256: sha(files),
    });
    expect(installed.statusCode).toBe(201);
    const { skill } = installed.json() as { skill: Skill };
    const res = await as(A, "POST", `/api/skills/${skill.id}/promote`, {
      evidence: {
        sha256: skill.sha256,
        botIds: [A.ids.bot],
        compare: { passes: true, verdict: "inconclusive", pairedTasks: 12 },
      },
    });
    expect(res.statusCode).toBe(409);
  });
});
