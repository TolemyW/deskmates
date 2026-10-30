// T0, ADR-0047 Verification row 1 for Slack: the release manifest ships the Slack plugin as ABI 2,
// and its entry exports the plugin the manifest names.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { channelPlugin } from "./plugin.js";

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/write-channel-plugin-manifest.mjs", import.meta.url),
);

describe("Slack in the release manifest", () => {
  it("lists slack/plugin.js as ABI 2 at the plugin's version", () => {
    const line = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .find((candidate) => candidate.includes('id: "slack"'));
    expect(line).toBeDefined();
    expect(line).toContain("apiVersion: 2");
    expect(line).toContain('entry: "slack/plugin.js"');
    expect(line).toContain(`version: "${channelPlugin.manifest.version}"`);
  });
});
