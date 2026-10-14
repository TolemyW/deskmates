// The spike guides are an independent, pinned oracle; never assert the fake against itself.
import { readFileSync } from "node:fs";
import { FakeIntegrationRuntime } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import { RuntimeAdapter } from "./runtime-adapter.js";

describe("Drive fixture binding to recorded OpenConnector v1.7.0 guides", () => {
  it.each([
    "files.list",
    "files.get",
    "files.create",
    "files.export",
    "files.delete",
    "permissions.create",
  ])("matches exact names, required flags, types and scopes for %s", async (action) => {
    const guide = readFileSync(
      new URL(
        `../../../../spikes/openconnector/out/guide-googledrive.${action}.md`,
        import.meta.url,
      ),
      "utf8",
    );
    const fake = new FakeIntegrationRuntime();
    const adapter = new RuntimeAdapter({
      url: fake.baseUrl,
      adminToken: fake.adminToken,
      fetch: fake.fetch,
    });
    const grant = await adapter.createToken("synthetic", {
      allowedActions: ["googledrive.*"],
      allowedConnections: ["synthetic"],
    });
    const found = await adapter.searchActions(grant.token, {
      service: "googledrive",
      query: `googledrive.${action}`,
      limit: 5,
    });
    const entry = found.find((a) => a.actionId === `googledrive.${action}`);
    expect(entry).toBeDefined();
    const inputs = [...guide.matchAll(/^\| `([^`]+)`\s*\| (Yes|No)\s*\| `([^`]+)`\s*\|/gm)].map(
      (m) => ({ name: m[1], required: m[2] === "Yes", type: m[3]?.replace(/\\\|/g, "|") }),
    );
    expect(entry?.inputs.map(({ name, required, type }) => ({ name, required, type }))).toEqual(
      inputs,
    );
    const scopes = guide.split("## Required Scopes")[1]?.split("## Provider Permissions")[0] ?? "";
    expect(entry?.requiredScopes).toEqual(
      [...scopes.matchAll(/^- `(https:\/\/[^`]+)`/gm)].map((m) => m[1]),
    );
  });
});
