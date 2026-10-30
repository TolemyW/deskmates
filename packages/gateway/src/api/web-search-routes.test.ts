// T1 (ADR-0049 decision 4): the `web_search` switch. A Member reads, only an Owner or Admin
// changes it; the configured default is on; turning it on needs `SEARCH_URL`; `null` returns to the default;
// every change is audited.

import type { WebSearchView } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readSearchConfig } from "../config/search.js";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("web search routes (ADR-0049 decision 4)", () => {
  it("a Member reads the default on, an Admin turns it on and back to the default", async () => {
    h = await startHarness({
      auth: FAST_AUTH,
      ...readSearchConfig({ SEARCH_URL: "http://fake-searxng.test" }),
    });
    const people = await seedRoles(h);
    const path = `/api/workspaces/${people.workspace.id}/web-search`;

    const read = await people.member.json<{ webSearch: WebSearchView }>("GET", path);
    expect(read.status).toBe(200);
    expect(read.json.webSearch).toEqual({
      workspaceId: people.workspace.id,
      configured: true,
      enabled: null,
      effective: true,
      defaultEnabled: true,
      updatedBy: null,
      updatedAt: null,
    });

    expect((await people.member.fetch("PUT", path, { body: { enabled: true } })).status).toBe(403);
    expect((await people.admin.fetch("PUT", path, { body: { enabled: "yes" } })).status).toBe(400);
    expect((await people.admin.fetch("PUT", path, { body: { other: true } })).status).toBe(400);
    expect((await people.admin.fetch("PUT", path, { body: {} })).status).toBe(400);

    const on = await people.admin.json<{ webSearch: WebSearchView }>("PUT", path, {
      body: { enabled: true },
    });
    expect(on.status).toBe(200);
    expect(on.json.webSearch).toMatchObject({ enabled: true, effective: true });
    expect(on.json.webSearch.updatedBy).toMatch(/^user:/);

    const off = await people.admin.json<{ webSearch: WebSearchView }>("PUT", path, {
      body: { enabled: false },
    });
    expect(off.json.webSearch).toMatchObject({ enabled: false, effective: false });
    const reset = await people.admin.json<{ webSearch: WebSearchView }>("PUT", path, {
      body: { enabled: null },
    });
    expect(reset.json.webSearch).toMatchObject({
      enabled: null,
      effective: true,
      updatedBy: null,
    });
    // Setting what is already stored changes nothing and writes no row.
    await people.admin.fetch("PUT", path, { body: { enabled: null } });

    const audit = h.app.deskmates.ctx.db
      .prepare(
        "SELECT before_json, after_json FROM audit_events WHERE action = 'workspace.web_search_set' ORDER BY seq",
      )
      .all() as { before_json: string; after_json: string }[];
    expect(audit.map((a) => [JSON.parse(a.before_json), JSON.parse(a.after_json)])).toEqual([
      [{ enabled: null }, { enabled: true }],
      [{ enabled: true }, { enabled: false }],
      [{ enabled: false }, { enabled: null }],
    ]);
  });

  it("refuses to turn it on where the installation has no SEARCH_URL", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const people = await seedRoles(h);
    const path = `/api/workspaces/${people.workspace.id}/web-search`;
    const read = await people.member.json<{ webSearch: WebSearchView }>("GET", path);
    expect(read.json.webSearch).toMatchObject({ configured: false, effective: false });
    const refused = await people.admin.json<{ details: { reason: string } }>("PUT", path, {
      body: { enabled: true },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.details.reason).toBe("search_not_configured");
    // Off may still be stored; it changes nothing on this installation.
    expect((await people.admin.fetch("PUT", path, { body: { enabled: false } })).status).toBe(200);
  });
});
