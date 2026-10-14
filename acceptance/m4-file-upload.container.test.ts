// T2: ADR-0014 amendment A5 end to end on a real workspace image. A file uploaded through the
// operator routes in several parts lands under /work/uploads/<date>/ byte-identical and
// downloads back unchanged; a second upload of the same name gets `-2`; an `uploads` directory
// planted as a link into /profile is refused before any byte is written. No model is involved.
//
// The workspace image must contain this checkout's sidecar (`file-write.js`); an image built
// before amendment A5 answers every upload with 503 sandbox_unavailable.

import { createHash, randomBytes } from "node:crypto";
import { WORKSPACE_FILE_UPLOAD_PART_BYTES } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const PART = WORKSPACE_FILE_UPLOAD_PART_BYTES;

const available = await dockerAvailable();
describe.skipIf(!available)("M4 workspace file upload (real image)", () => {
  let stack: Stack;
  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      modelBaseUrl: "http://127.0.0.1:1",
      modelAuthToken: "unused-t2-token",
      defaultModel: "unused-model",
      cheapModel: "unused-cheap-model",
      label: "m4-file-upload",
    });
  }, 180_000);
  afterAll(async () => stopStack(stack), 120_000);

  const auth = () => ({ authorization: `Bearer ${stack.config.operatorToken}` });
  const base = () => `${stack.gatewayUrl}/api/workspaces/${stack.workspace.id}/uploads`;

  async function sh(script: string): Promise<{ stdout: string }> {
    const result = await stack.docker.exec(stack.handle, {
      cmd: ["sh", "-c", script],
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(`workspace shell failed (${result.exitCode}): ${result.stderr}`);
    return { stdout: result.stdout };
  }

  async function upload(name: string, bytes: Buffer): Promise<Record<string, unknown>> {
    const created = await fetch(base(), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ name, sizeBytes: bytes.length }),
    });
    const session = (await created.json()) as { id: string };
    expect(created.status, JSON.stringify(session)).toBe(201);
    for (let offset = 0; offset < bytes.length; offset += PART) {
      const part = await fetch(`${base()}/${session.id}/parts?offset=${offset}`, {
        method: "PUT",
        headers: { ...auth(), "content-type": "application/octet-stream" },
        body: bytes.subarray(offset, offset + PART),
      });
      expect(part.status, await part.clone().text()).toBe(200);
    }
    const done = await fetch(`${base()}/${session.id}/complete`, {
      method: "POST",
      headers: auth(),
    });
    expect(done.status).toBe(200);
    return (await done.json()) as Record<string, unknown>;
  }

  it("writes a multi-part upload byte-identical and never overwrites", async () => {
    const bytes = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      randomBytes(2 * PART + 1000),
    ]);
    const done = await upload("../../Report (final).bin", bytes);
    expect(done.path).toMatch(/^\/work\/uploads\/\d{4}-\d{2}-\d{2}\/Report_final\.bin$/);
    expect(done.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const inContainer = await sh(`sha256sum '${done.path}' && stat -c %a '${done.path}'`);
    expect(inContainer.stdout).toContain(done.sha256 as string);
    // Decision 32: no execute bit.
    expect(inContainer.stdout.trim().split("\n").at(-1)).toMatch(/^[0-7][0246][0246]$/);
    const download = await fetch(
      `${stack.gatewayUrl}/api/workspaces/${stack.workspace.id}/files?path=${encodeURIComponent(done.path as string)}`,
      { headers: auth() },
    );
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);

    const again = await upload("Report (final).bin", Buffer.from("second"));
    expect(again.path).toBe(
      (done.path as string).replace("Report_final.bin", "Report_final-2.bin"),
    );
  }, 120_000);

  it("refuses an uploads directory planted as a link into /profile", async () => {
    await sh(
      ["mkdir -p /profile", "rm -rf /work/uploads", "ln -s /profile /work/uploads"].join(" && "),
    );
    try {
      const created = await fetch(base(), {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ name: "x.txt", sizeBytes: 1 }),
      });
      expect(created.status).toBe(403);
      expect(await created.json()).toMatchObject({
        code: "forbidden",
        details: { reason: "upload_path_policy" },
      });
      const profile = await sh("ls -a /profile");
      expect(profile.stdout).not.toContain(".partial");
    } finally {
      await sh("rm -f /work/uploads");
    }
  }, 60_000);
});
