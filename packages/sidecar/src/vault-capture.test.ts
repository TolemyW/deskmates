// T1 (ADR-0045 decision 7): capture suppression after a Vault fill, in the ordinary later paths.
// While the run's tab shows the page a credential was filled into, the browser proxy masks field
// values in snapshot text, replaces images with a notice, withholds page-code output and writes no
// run screenshot; on another page it does none of that and drops the mark. The masking is of the
// normal paths only: a page that renders or encodes the value otherwise is not recognized, which
// the ADR and the docs say rather than a passing canary hiding it.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpProxy } from "./mcp-proxy/proxy.js";
import {
  VAULT_CAPTURE_NOTICE,
  VAULT_CAPTURE_SKIPPED,
  type VaultCaptureGuard,
  fileVaultCaptureGuard,
  maskCredentialResult,
  maskSnapshotText,
  vaultCapturePath,
  writeVaultCaptureMark,
} from "./vault-capture.js";

const USER = "synthetic-capture-user-0a9e";
const SNAPSHOT = [
  "### Page state",
  "- Page URL: https://console.example.test/login",
  "```yaml",
  '- textbox "Email" [ref=e3]: synthetic-capture-user-0a9e',
  '- textbox "Password" [ref=e4]: ••••••••',
  '- button "Sign in" [ref=e5]',
  "```",
].join("\n");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-capture-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("masking", () => {
  it("keeps field labels and drops their values", () => {
    const masked = maskSnapshotText(SNAPSHOT);
    expect(masked).not.toContain(USER);
    expect(masked).toContain('- textbox "Email" [ref=e3]: [value hidden after a Vault fill]');
    expect(masked).toContain('- button "Sign in" [ref=e5]');
  });

  it("withholds page-code output whole and replaces images", () => {
    const code = maskCredentialResult("browser_evaluate", {
      content: [{ type: "text", text: `"${USER}"` }],
    }) as { content: { text: string }[] };
    expect(code.content).toEqual([{ type: "text", text: VAULT_CAPTURE_NOTICE }]);
    const shot = maskCredentialResult("browser_take_screenshot", {
      content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }],
    }) as { content: { type: string }[] };
    expect(shot.content.map((b) => b.type)).toEqual(["text"]);
  });

  it("is active on the filled page and ends, deleting the mark, once the tab leaves it", async () => {
    const mark = vaultCapturePath(path.join(dir, "run-1.json"));
    expect(mark).toBe(path.join(dir, "run-1.vault.json"));
    const guard = fileVaultCaptureGuard(mark);
    expect(await guard.active()).toBe(false);
    await writeVaultCaptureMark(mark, {
      runId: "run-1",
      tabId: "tab-1",
      url: "https://console.example.test/login",
      filledAt: "2026-10-17T00:00:00.000Z",
    });
    expect(await guard.active()).toBe(true);
    expect(
      await guard.active({ tabId: "tab-1", url: "https://console.example.test/login#x" }),
    ).toBe(true);
    expect(await guard.active({ tabId: "tab-1", url: "https://console.example.test/home" })).toBe(
      false,
    );
    expect(await guard.active()).toBe(false);
  });
});

function proxy(guard: VaultCaptureGuard, screenshotDir: string) {
  const upstreamIn = new PassThrough();
  const upstreamOut = new PassThrough();
  const childIn = new PassThrough();
  const childOut = new PassThrough();
  const toChild: string[] = [];
  const toUpstream: string[] = [];
  createInterface({ input: childIn }).on("line", (line) => toChild.push(line));
  createInterface({ input: upstreamOut }).on("line", (line) => toUpstream.push(line));
  const done = runMcpProxy({
    upstream: { input: upstreamIn, output: upstreamOut },
    child: { stdin: childIn, stdout: childOut },
    options: { screenshotDir, vaultGuard: guard, log: () => {} },
  });
  return {
    toChild,
    toUpstream,
    sdk: (m: unknown) => upstreamIn.write(`${JSON.stringify(m)}\n`),
    server: (m: unknown) => childOut.write(`${JSON.stringify(m)}\n`),
    end: async () => {
      upstreamIn.end();
      childOut.end();
      await done;
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("the browser proxy while a fill mark is active", () => {
  it("masks the snapshot and writes no screenshot for a page-changing call", async () => {
    const shots = path.join(dir, "shots");
    const p = proxy({ active: async () => true }, shots);
    p.sdk({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_snapshot", arguments: {} },
    });
    await until(() => p.toChild.length === 1);
    p.server({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: SNAPSHOT }] } });
    await until(() => p.toUpstream.length === 1);
    expect(p.toUpstream[0]).not.toContain(USER);
    expect(p.toUpstream[0]).toContain("value hidden after a Vault fill");

    p.sdk({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Remember me", ref: "e6" } },
    });
    await until(() => p.toChild.length === 2);
    p.server({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: SNAPSHOT }] } });
    await until(() => p.toUpstream.length === 2);
    // No screenshot was asked of the browser; the capture file says why.
    expect(p.toChild).toHaveLength(2);
    const files = await readdir(shots);
    const written = JSON.parse(await readFile(path.join(shots, files[0] ?? ""), "utf8"));
    expect(written.skipped).toBe(VAULT_CAPTURE_SKIPPED);
    await p.end();
  });

  it("passes results through untouched without a mark", async () => {
    const p = proxy({ active: async () => false }, path.join(dir, "shots"));
    p.sdk({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_snapshot", arguments: {} },
    });
    await until(() => p.toChild.length === 1);
    p.server({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: SNAPSHOT }] } });
    await until(() => p.toUpstream.length === 1);
    expect(p.toUpstream[0]).toContain(USER);
    await p.end();
  });
});
