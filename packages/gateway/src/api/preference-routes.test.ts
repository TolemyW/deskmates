// T1: `PATCH /auth/preferences` (issue #22, shared with the locale of issue #23). A person's own
// UI preferences are one JSON object on `users`, exposed in `GET /auth/session`. The route has the
// `authenticated` policy: any signed-in person, same origin and session CSRF like every cookie
// mutation; the operator credential and service principals have no user, so no preferences.

import type { AuthenticatedSessionView, UpdatePreferencesResponse } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH } from "../test-support/browser-session.js";
import { TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { ROUTE_POLICY } from "./route-policy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function ownerHarness(): Promise<{ h: Harness; jar: BrowserJar }> {
  const h = await startHarness({ auth: FAST_AUTH });
  cleanups.push(() => h.close());
  await createOwner(h.app.deskmates.ctx.auth, {
    loginName: "owner",
    displayName: "Olive Owner",
    password: TEST_PASSWORD,
  });
  const jar = new BrowserJar(h.baseUrl);
  expect((await jar.signIn("owner")).status).toBe(200);
  return { h, jar };
}

async function session(jar: BrowserJar): Promise<AuthenticatedSessionView> {
  const { status, json } = await jar.json<AuthenticatedSessionView>("GET", "/auth/session");
  expect(status).toBe(200);
  return json;
}

describe("PATCH /auth/preferences", () => {
  it("has the authenticated route policy", () => {
    expect(ROUTE_POLICY["PATCH /auth/preferences"]).toEqual({ access: "authenticated" });
  });

  it("starts empty, stores a dismissal and reports it in the session from then on", async () => {
    const { h, jar } = await ownerHarness();
    expect((await session(jar)).preferences).toEqual({});

    const patched = await jar.json<UpdatePreferencesResponse>("PATCH", "/auth/preferences", {
      body: { firstRunChecklistDismissed: true },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.preferences).toEqual({ firstRunChecklistDismissed: true });
    expect((await session(jar)).preferences).toEqual({ firstRunChecklistDismissed: true });

    // A preference belongs to the person, not the browser: another sign-in sees it.
    const other = new BrowserJar(h.baseUrl);
    expect((await other.signIn("owner")).status).toBe(200);
    expect((await session(other)).preferences).toEqual({ firstRunChecklistDismissed: true });
  });

  it("keeps preferences it was not asked to change", async () => {
    const { h, jar } = await ownerHarness();
    const db = h.app.deskmates.ctx.db;
    db.prepare("UPDATE users SET preferences_json = ?").run(JSON.stringify({ locale: "ja" }));
    const patched = await jar.json<UpdatePreferencesResponse>("PATCH", "/auth/preferences", {
      body: { firstRunChecklistDismissed: true },
    });
    expect(patched.status).toBe(200);
    const stored = db.prepare("SELECT preferences_json AS p FROM users").get() as { p: string };
    expect(JSON.parse(stored.p)).toEqual({ locale: "ja", firstRunChecklistDismissed: true });
  });

  it("stores a locale (issue #23), reports it in the session and replaces it on change", async () => {
    const { jar } = await ownerHarness();
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "es"] as const) {
      const patched = await jar.json<UpdatePreferencesResponse>("PATCH", "/auth/preferences", {
        body: { locale },
      });
      expect(patched.status, locale).toBe(200);
      expect(patched.json.preferences).toEqual({ locale });
      expect((await session(jar)).preferences).toEqual({ locale });
    }
  });

  it("refuses a locale outside the five UI locales and stores nothing", async () => {
    const { jar } = await ownerHarness();
    for (const locale of ["fr", "zh", "zh-cn", "EN", "", 1, null, true]) {
      const response = await jar.fetch("PATCH", "/auth/preferences", { body: { locale } });
      expect(response.status, JSON.stringify(locale)).toBe(400);
    }
    expect((await session(jar)).preferences).toEqual({});
  });

  it("leaves out a stored locale this Gateway does not know", async () => {
    const { h, jar } = await ownerHarness();
    const db = h.app.deskmates.ctx.db;
    db.prepare("UPDATE users SET preferences_json = ?").run(
      JSON.stringify({ locale: "fr", firstRunChecklistDismissed: true }),
    );
    expect((await session(jar)).preferences).toEqual({ firstRunChecklistDismissed: true });
    db.prepare("UPDATE users SET preferences_json = ?").run(JSON.stringify({ locale: "zh-TW" }));
    expect((await session(jar)).preferences).toEqual({ locale: "zh-TW" });
  });

  it("refuses a change without the session CSRF token or from another origin", async () => {
    const { jar } = await ownerHarness();
    const body = { firstRunChecklistDismissed: true };
    expect((await jar.fetch("PATCH", "/auth/preferences", { body, csrf: null })).status).toBe(403);
    expect(
      (await jar.fetch("PATCH", "/auth/preferences", { body, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await session(jar)).preferences).toEqual({});
  });

  it("refuses an unknown key or a value of the wrong type and stores nothing", async () => {
    const { jar } = await ownerHarness();
    for (const body of [
      { firstRunChecklistDismissed: "yes" },
      { somethingElse: true },
      {},
      [true],
    ]) {
      const response = await jar.fetch("PATCH", "/auth/preferences", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await session(jar)).preferences).toEqual({});
  });

  it("answers 400 to the operator credential, which has no user", async () => {
    const { h, jar } = await ownerHarness();
    const response = await h.api<{ code: string }>("PATCH", "/auth/preferences", {
      firstRunChecklistDismissed: true,
    });
    expect(response.status).toBe(400);
    expect(response.json.code).toBe("validation");
    expect((await session(jar)).preferences).toEqual({});
  });

  it("refuses a request with no credential", async () => {
    const { h } = await ownerHarness();
    const response = await fetch(`${h.baseUrl}/auth/preferences`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstRunChecklistDismissed: true }),
    });
    expect(response.status).toBe(401);
  });
});
