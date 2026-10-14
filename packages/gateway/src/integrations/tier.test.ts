// T1: the tier of `integration_execute` follows the catalog, resolved by the Gateway (ADR-0013
// item 6, Amendment 1). The tier route answers read L0, write L2, destructive L2; an operator may
// lower a write to L1, never a destructive action and never the seeded Drive permission writes.

import type { IntegrationActionOverride, IntegrationActionTier } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type IntegrationFixture,
  integrationFixture,
} from "../test-support/integration-fixture.js";

let f: IntegrationFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup(): Promise<IntegrationFixture> {
  f = await integrationFixture();
  // A Slack bot token as an API-key connection, and a Drive connection through OAuth (Drive
  // takes no API key).
  await f.adopt("slack");
  await f.adopt("googledrive");
  await f.apiKey(f.a, "team", "xoxb-test", "slack");
  // Drive connection through the OAuth flow of the fake runtime.
  await f.h.api("PUT", "/api/integrations/providers/googledrive/oauth-app", {
    clientId: "c",
    clientSecret: "s",
  });
  const started = await f.h.api<{ authorizationUrl: string }>(
    "POST",
    `/api/integrations/workspaces/${f.a.workspace.id}/connections/oauth/start`,
    { service: "googledrive", connectionName: "drive" },
  );
  const state = new URL(started.json.authorizationUrl).searchParams.get("state");
  await fetch(`${f.h.baseUrl}/api/integrations/oauth/callback?code=c&state=${state}`);
  return f;
}

const tier = (fx: IntegrationFixture, actionId: string) =>
  fx.run<IntegrationActionTier & { code?: string }>(fx.a, "GET", `/actions/${actionId}/tier`);

describe("integration tier route", () => {
  it("maps read to L0, write to L2 and destructive to L2 with the catalog description", async () => {
    const fx = await setup();
    expect((await tier(fx, "slack.list_channels")).json).toMatchObject({
      operationType: "read",
      tier: "L0",
      connectionName: "team",
    });
    const post = (await tier(fx, "slack.post_message")).json;
    expect(post).toMatchObject({
      operationType: "write",
      tier: "L2",
      requiredScopes: ["chat:write"],
    });
    expect(post.description).toMatch(/^Post a Slack message/);
    expect((await tier(fx, "slack.delete_message")).json).toMatchObject({
      operationType: "destructive",
      tier: "L2",
    });
  });

  it("lowers a write the operator lowered, and refuses to lower a destructive or pinned action", async () => {
    const fx = await setup();
    const put = (actionId: string, body: Record<string, unknown>) =>
      fx.h.api<{ override: IntegrationActionOverride; code?: string }>(
        "PUT",
        `/api/integrations/actions/${actionId}/override`,
        body,
      );
    expect((await put("slack.add_reaction", { lowerableToL1: true })).status).toBe(200);
    expect((await tier(fx, "slack.add_reaction")).json).toMatchObject({ tier: "L1" });
    expect((await put("slack.delete_message", { lowerableToL1: true })).status).toBe(400);
    expect((await put("googledrive.permissions.create", { lowerableToL1: true })).status).toBe(400);
    expect((await tier(fx, "googledrive.permissions.create")).json).toMatchObject({
      tier: "L2",
      override: { neverLowerable: true },
      connectionName: "drive",
    });
    const listed = await fx.h.api<{ overrides: IntegrationActionOverride[] }>(
      "GET",
      "/api/integrations/actions/overrides",
    );
    expect(listed.json.overrides.map((o) => o.actionId)).toEqual([
      "googledrive.permissions.create",
      "googledrive.permissions.update",
      "slack.add_reaction",
    ]);
  });

  it("refuses the tier of another workspace's connection and of an unknown action", async () => {
    const fx = await setup();
    const other = await fx.run<{ code: string }>(
      fx.a,
      "GET",
      "/actions/slack.post_message/tier?connectionName=elsewhere",
    );
    expect(other.json.code).toBe("integration_connection_not_allowed");
    expect((await tier(fx, "slack.nope")).status).toBe(404);
    expect((await fx.run(fx.b, "GET", "/actions/slack.post_message/tier")).status).toBe(403);
  });
});
