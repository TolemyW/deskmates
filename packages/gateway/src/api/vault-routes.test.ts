// T1 (ADR-0045 decision 2): only an Owner or Admin of the workspace changes the Vault; a Member
// and a Guest read metadata or nothing; a session write without the CSRF header is refused; reads
// never return a value; a name edit leaves the value; a stale revision is refused; an error body
// never echoes what was sent; the audit record holds metadata only.

import type { VaultEntry, VaultView } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { TEST_SECRETS_KEY } from "../test-support/connector-fixture.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";
import { vaultStore } from "../vault/store.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PASSWORD = "synthetic-route-password-51aa";
const USERNAME = "synthetic-route-user-8e02";

describe("vault routes (ADR-0045 decision 2)", () => {
  it("lets an Admin maintain, a Member read and a Guest neither", async () => {
    h = await startHarness({ auth: FAST_AUTH, secretsKey: TEST_SECRETS_KEY });
    const people = await seedRoles(h);
    const path = `/api/workspaces/${people.workspace.id}/vault`;
    const body = {
      name: "Console",
      type: "browser_login",
      targetOrigin: "https://console.example.test",
      username: USERNAME,
      password: PASSWORD,
    };
    expect((await people.member.fetch("POST", path, { body })).status).toBe(403);
    expect((await people.guest.fetch("GET", path)).status).toBe(403);
    // A session write without the CSRF header is refused before the handler.
    expect((await people.admin.fetch("POST", path, { body, csrf: null })).status).toBe(403);
    const created = await people.admin.json<{ entry: VaultEntry }>("POST", path, { body });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.json)).not.toContain(PASSWORD);
    expect(JSON.stringify(created.json)).not.toContain(USERNAME);

    const read = await people.member.json<{ vault: VaultView }>("GET", path);
    expect(read.status).toBe(200);
    expect(read.json.vault.entries).toHaveLength(1);
    expect(JSON.stringify(read.json)).not.toContain(PASSWORD);
    expect(JSON.stringify(read.json)).not.toContain(USERNAME);

    const entry = created.json.entry;
    const one = `${path}/${entry.id}`;
    expect(
      (await people.member.fetch("PATCH", one, { body: { expectedRevision: 1, enabled: false } }))
        .status,
    ).toBe(403);
    // An Owner maintains too.
    const renamed = await people.owner.json<{ entry: VaultEntry }>("PATCH", one, {
      body: { expectedRevision: 1, name: "Console (ops)" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.entry.revision).toBe(2);
    // Editing the name left the value as it was.
    expect(vaultStore(h.app.deskmates.ctx).payload(people.workspace.id, entry.id, 2)).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });
  });

  it("refuses a stale revision and never echoes a value in an error", async () => {
    h = await startHarness({ secretsKey: TEST_SECRETS_KEY });
    const { workspace } = await h.seed();
    const path = `/api/workspaces/${workspace.id}/vault`;
    const created = await h.api<{ entry: VaultEntry }>("POST", path, {
      name: "Console",
      type: "browser_login",
      targetOrigin: "https://console.example.test",
      password: PASSWORD,
    });
    const one = `${path}/${created.json.entry.id}`;
    await h.api("PATCH", one, { expectedRevision: 1, enabled: false });
    const stale = await h.api<{ code: string; details: Record<string, unknown> }>("PATCH", one, {
      expectedRevision: 1,
      enabled: true,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.details.reason).toBe("stale_revision");
    // A value sent to the metadata route is refused, naming the field and not the value.
    const misplaced = await h.api("PATCH", one, { expectedRevision: 2, password: PASSWORD });
    expect(misplaced.status).toBe(400);
    expect(JSON.stringify(misplaced.json)).not.toContain(PASSWORD);
    const control = await h.api("PUT", `${one}/value`, {
      expectedRevision: 2,
      password: `${PASSWORD}\r\nX-Injected: 1`,
    });
    expect(control.status).toBe(400);
    expect(JSON.stringify(control.json)).not.toContain(PASSWORD);
    const badOrigin = await h.api("POST", path, {
      name: "Other",
      type: "browser_login",
      targetOrigin: "http://10.0.0.5/login",
      password: PASSWORD,
    });
    expect(badOrigin.status).toBe(400);
    expect(JSON.stringify(badOrigin.json)).not.toContain(PASSWORD);
    const audit = h.app.deskmates.ctx.db
      .prepare("SELECT before_json, after_json FROM audit_events WHERE action LIKE 'vault.%'")
      .all();
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    const removed = await h.api("DELETE", `${one}?expectedRevision=2`);
    expect(removed.status).toBe(200);
    expect((await h.api<{ vault: VaultView }>("GET", path)).json.vault.entries).toEqual([]);
  });

  it("has no route that reveals, exports or reads back a value (decision 10)", async () => {
    const { ROUTE_POLICY } = await import("./route-policy.js");
    const vault = Object.keys(ROUTE_POLICY).filter((key) => key.includes("/vault"));
    expect(vault.sort()).toEqual(
      [
        "DELETE /api/workspaces/:id/vault/:entryId",
        "GET /api/workspaces/:id/vault",
        "PATCH /api/workspaces/:id/vault/:entryId",
        "POST /api/workspaces/:id/vault",
        "PUT /api/workspaces/:id/vault/:entryId/requests",
        "PUT /api/workspaces/:id/vault/:entryId/value",
      ].sort(),
    );
    expect(vault.filter((key) => /reveal|export|secret|plaintext/i.test(key))).toEqual([]);
    expect(vault.filter((key) => key.startsWith("GET ") && key.endsWith("/value"))).toEqual([]);
  });
});
