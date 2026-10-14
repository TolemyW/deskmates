// #82: the reachable UI must preserve ADR-0026 authorization and restore semantics.
import { CSRF_HEADER, type WorkspaceId } from "@deskmates/contracts";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { csrfTokenFor } from "../auth/tokens.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { FIXTURE_PASSWORD, type TenantFixture, seedTenant } from "../test-support/tenants.js";

const app = buildGateway(
  testConfig({
    secretsKey: Buffer.alloc(32, 7).toString("base64"),
    auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
  }),
  new FakeProvider(),
  { surface: "combined-test", startCron: false },
);
let a: TenantFixture;
let b: TenantFixture;
let admin: { token: string; csrf: string };
let member: { token: string; csrf: string };
beforeAll(async () => {
  await app.ready();
  app.deskmates.scheduler.stop();
  a = await seedTenant(app.deskmates.ctx, "TrashA");
  b = await seedTenant(app.deskmates.ctx, "TrashB");
  const person = async (role: "admin" | "member") => {
    await app.deskmates.ctx.auth.createUser({
      loginName: `trash-${role}`,
      displayName: role,
      password: FIXTURE_PASSWORD,
      role,
      tenantId: a.tenantId,
    });
    const { token } = await app.deskmates.ctx.auth.login(
      `trash-${role}`,
      FIXTURE_PASSWORD,
      `trash-${role}`,
    );
    return { token, csrf: csrfTokenFor(token) };
  };
  admin = await person("admin");
  member = await person("member");
});
afterAll(async () => {
  await app.close();
});
const request = (who: { token: string; csrf: string }, method: "GET" | "POST", url: string) =>
  app.inject({
    method,
    url,
    headers: {
      host: "gw.test",
      origin: "http://gw.test",
      cookie: `__Host-deskmates-session=${who.token}`,
      [CSRF_HEADER]: who.csrf,
    },
  } as InjectOptions);

it("denies Member list/archive/restore without changing workspace state", async () => {
  for (const [method, url] of [
    ["GET", "/api/trash"],
    ["POST", `/api/workspaces/${a.ids.workspace}/archive`],
    ["POST", `/api/workspaces/${a.ids.workspace}/restore`],
  ] as const) {
    expect((await request(member, method, url)).statusCode).toBe(403);
  }
  expect(
    app.deskmates.ctx.workspaces.mustGet(a.ids.workspace as WorkspaceId).archivedAt,
  ).toBeUndefined();
});
for (const role of ["owner", "admin"] as const)
  it(`${role} can archive/list/restore using existing lifecycle without replay`, async () => {
    const who = role === "owner" ? a : admin;
    const workspace = app.deskmates.ctx.workspaces.create({
      tenantId: a.tenantId,
      name: `Disposable ${role}`,
      sandboxProvider: "docker",
      egressAllowlist: ["example.test"],
      ownerUserId: a.ownerUserId,
    });
    // Roles are per workspace (ADR-0031 decision 7): the Admin is an Admin of this one too.
    const adminLogin = app.deskmates.ctx.auth.users.findLocalLogin("trash-admin");
    app.deskmates.ctx.auth.users.grantRole(
      a.tenantId,
      adminLogin?.userId as string,
      "admin",
      workspace.id,
    );
    const runCount = app.deskmates.ctx.db.prepare("SELECT COUNT(*) AS n FROM runs").get();
    const archive = await request(who, "POST", `/api/workspaces/${workspace.id}/archive`);
    expect(archive.statusCode).toBe(200);
    expect(archive.json().workspace.archivedAt).toBeTruthy();
    const trash = await request(who, "GET", "/api/trash");
    expect(trash.statusCode).toBe(200);
    expect(trash.json().workspaces.some((row: { id: string }) => row.id === workspace.id)).toBe(
      true,
    );
    expect((await request(who, "POST", `/api/workspaces/${workspace.id}/restore`)).statusCode).toBe(
      200,
    );
    expect(app.deskmates.ctx.workspaces.mustGet(workspace.id).archivedAt).toBeUndefined();
    expect(app.deskmates.ctx.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual(runCount);
  });
it("does not reveal or restore another team's archived workspace", async () => {
  expect((await request(b, "POST", `/api/workspaces/${b.ids.workspace}/archive`)).statusCode).toBe(
    200,
  );
  const trash = await request(a, "GET", "/api/trash");
  expect(trash.body).not.toContain(b.sentinel);
  for (const action of ["archive", "restore"])
    expect(
      (await request(a, "POST", `/api/workspaces/${b.ids.workspace}/${action}`)).statusCode,
    ).toBe(404);
  expect(
    app.deskmates.ctx.workspaces.mustGetIncludingArchived(b.ids.workspace as WorkspaceId)
      .archivedAt,
  ).toBeTruthy();
});
