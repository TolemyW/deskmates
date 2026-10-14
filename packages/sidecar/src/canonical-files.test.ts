import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditCanonicalFiles,
  prepareCanonicalFiles,
  snapshotPeerRuleFiles,
} from "./canonical-files.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const file = (body: string) => ({
  body,
  version: createHash("sha256").update(body).digest("hex"),
});

describe("canonical bot files", () => {
  it("detects a new peer rule file while leaving absent files alone", async () => {
    const fs = createMemoryFs();
    const snapshots = await snapshotPeerRuleFiles(["/home/peer"], fs);
    expect(await auditCanonicalFiles(snapshots, fs)).toEqual([]);
    await fs.writeFile("/home/peer/SOUL.md", "");
    expect(await auditCanonicalFiles(snapshots, fs)).toMatchObject([{ reason: "file_created" }]);
  });
  it("observes peer mutations without rewriting peer files or claiming their author", async () => {
    const fs = createMemoryFs({ "/home/peer/SOUL.md": "peer instructions" });
    const snapshots = await snapshotPeerRuleFiles(["/home/peer"], fs);
    expect(await fs.readFile("/home/peer/SOUL.md")).toBe("peer instructions");
    await fs.writeFile("/home/peer/SOUL.md", "changed concurrently");
    expect(await auditCanonicalFiles(snapshots, fs)).toMatchObject([
      {
        path: "/home/peer/SOUL.md",
        observation: "peer_file_changed_during_run",
        restoredOnNextRun: false,
      },
    ]);
  });
  it("preserves legacy files until the Gateway has imported them", async () => {
    const fs = createMemoryFs({
      "/home/nova/SOUL.md": "existing",
      "/home/nova/MEMORY.md": "notes",
    });
    expect(await prepareCanonicalFiles({ botHomeDir: "/home/nova" }, fs)).toEqual([]);
    expect(await fs.readFile("/home/nova/SOUL.md")).toBe("existing");
    expect(await fs.readFile("/home/nova/MEMORY.md")).toBe("notes");
  });

  it("restores canonical bytes, detects mutations and restores them for the next run", async () => {
    const fs = createMemoryFs();
    const request = {
      botHomeDir: "/home/nova",
      canonicalFiles: { soul: file("operator instructions"), memory: file("observations") },
    };
    const snapshots = await prepareCanonicalFiles(request, fs);
    expect(await auditCanonicalFiles(snapshots, fs)).toEqual([]);
    await fs.writeFile("/home/nova/SOUL.md", "altered");
    await fs.rm("/home/nova/MEMORY.md");
    const events = await auditCanonicalFiles(snapshots, fs);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      reason: "content_changed",
      diff: "- operator instructions\n+ altered",
    });
    expect(events[1]).toMatchObject({ reason: "missing_or_unreadable" });
    await prepareCanonicalFiles(request, fs);
    expect(await fs.readFile("/home/nova/SOUL.md")).toBe("operator instructions");
    expect(await fs.readFile("/home/nova/MEMORY.md")).toBe("observations");
  });

  it("validates the complete request before overwriting a file", async () => {
    const fs = createMemoryFs({ "/home/nova/SOUL.md": "keep" });
    await expect(
      prepareCanonicalFiles(
        {
          botHomeDir: "/home/nova",
          canonicalFiles: { soul: file("new"), memory: { body: "bad", version: "wrong" } },
        },
        fs,
      ),
    ).rejects.toThrow("version mismatch");
    expect(await fs.readFile("/home/nova/SOUL.md")).toBe("keep");
  });

  it("redacts secrets from bounded diffs and does not copy unchanged text", async () => {
    const fs = createMemoryFs();
    const snapshots = await prepareCanonicalFiles(
      {
        botHomeDir: "/home/nova",
        canonicalFiles: { soul: file("unchanged private note\nold\nend") },
      },
      fs,
    );
    await fs.writeFile(
      "/home/nova/SOUL.md",
      "unchanged private note\nBearer abcdefghijklmnop\ncustom-secret-value\nend",
    );
    const [event] = await auditCanonicalFiles(snapshots, fs, ["custom-secret-value"]);
    expect(event?.diff).not.toContain("abcdefghijklmnop");
    expect(event?.diff).not.toContain("custom-secret-value");
    expect(event?.diff).not.toContain("unchanged private note");
    expect(event?.diff).toContain("[redacted]");
  });

  it("rejects an unexpected home path", async () => {
    await expect(
      prepareCanonicalFiles(
        { botHomeDir: "/home/nova/../../profile", canonicalFiles: { soul: file("x") } },
        createMemoryFs(),
      ),
    ).rejects.toThrow("valid bot home");
  });
});
