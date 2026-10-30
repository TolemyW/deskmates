import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadReleaseChannelPlugins } from "./plugin-loader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const V1_MANIFEST = (apiVersion: number) =>
  `{ apiVersion: ${apiVersion}, id: "fake", version, displayName: "Fake", description: "Fake", capabilities: { directMessages: true, groups: false, testMessage: true }, methods: [], statusVocabulary: [] }`;
const V2_MANIFEST = (groups: string) =>
  `{ apiVersion: 2, id: "fake", version, displayName: "Fake", description: "Fake", multipleConnections: true, capabilities: { directMessages: "available", groups: "${groups}", inboundImages: "available", inboundOtherMedia: "disabled", outboundReply: "available", proactiveMessages: "unavailable", streaming: "disabled", approvals: "available", testMessage: "unavailable" }, methods: [{ id: "token", label: "Token", description: "Token", fields: [] }], statusVocabulary: ["connected"] }`;

async function fixture(apiVersion = 1, manifestSource = V1_MANIFEST(apiVersion)) {
  const root = await mkdtemp(join(tmpdir(), "deskmates-channel-plugin-"));
  roots.push(root);
  const helper = join(root, "helper.mjs");
  const entry = join(root, "plugin.mjs");
  await writeFile(helper, 'export const version = "1.2.3";\n');
  await writeFile(
    entry,
    `import { version } from "./helper.mjs";
export const channelPlugin = {
  manifest: ${manifestSource},
  create: async () => ({ connect: async () => ({phase:"connected"}), restore: async () => ({phase:"connected"}), status: async () => ({phase:"connected"}), command: async () => ({phase:"connected"}), webhook: async () => ({status:200}), stop: async () => {} })
};\n`,
  );
  const entryBytes = await readFile(entry);
  const helperBytes = await readFile(helper);
  const manifest = join(root, "channel-plugins.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: "fake",
          version: "1.2.3",
          apiVersion,
          entry: "plugin.mjs",
          sha256: hash(entryBytes),
          files: [
            { path: "plugin.mjs", sha256: hash(entryBytes) },
            { path: "helper.mjs", sha256: hash(helperBytes) },
          ],
        },
      ],
    }),
  );
  return { root, entry, helper, manifest };
}

describe("release channel plugin loader (ADR-0017 amendment 1 P1/P2)", () => {
  it("loads a compatible plugin only after its complete module tree matches", async () => {
    const fx = await fixture();
    const loaded = await loadReleaseChannelPlugins(fx.manifest);
    expect([...loaded.plugins]).toEqual([
      [
        "fake",
        expect.objectContaining({ manifest: expect.objectContaining({ version: "1.2.3" }) }),
      ],
    ]);
    expect(loaded.failures).toEqual([]);
  });

  it("fails closed when a transitive provider module changes", async () => {
    const fx = await fixture();
    await writeFile(fx.helper, 'export const version = "tampered";\n');
    const loaded = await loadReleaseChannelPlugins(fx.manifest);
    expect(loaded.plugins.size).toBe(0);
    expect(loaded.failures[0]?.message).toContain("asset hash");
  });

  it("degrades an incompatible API version without importing it", async () => {
    const fx = await fixture(3);
    const loaded = await loadReleaseChannelPlugins(fx.manifest);
    expect(loaded.plugins.size).toBe(0);
    expect(loaded.failures[0]?.message).toContain("incompatible");
  });

  it("loads an ABI-2 plugin whose manifest declares every capability row (ADR-0047)", async () => {
    const fx = await fixture(2, V2_MANIFEST("unavailable"));
    const loaded = await loadReleaseChannelPlugins(fx.manifest);
    expect(loaded.failures).toEqual([]);
    expect(loaded.plugins.get("fake")?.manifest.apiVersion).toBe(2);
  });

  it("refuses an ABI-2 plugin that declares groups, which this version does not implement", async () => {
    const fx = await fixture(2, V2_MANIFEST("disabled"));
    const loaded = await loadReleaseChannelPlugins(fx.manifest);
    expect(loaded.plugins.size).toBe(0);
    expect(loaded.failures[0]?.message).toContain("groups must be unavailable");
  });
});
