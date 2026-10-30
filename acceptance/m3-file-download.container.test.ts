// T2: ADR-0014 end to end on a real workspace image. A file written into /work downloads
// byte-identical through the operator route; /profile/Cookies, a link from /work into /profile and
// a sparse file over 1 GiB is refused by the container's `deskmates-sidecar file-read`; a workspace with
// no container is reported and not started. No model is involved.
//
// The workspace image must contain this checkout's sidecar (`file-read.js`); an image built
// before ADR-0014 answers every download with 503 sandbox_unavailable.

import { randomBytes } from "node:crypto";
import type { Workspace } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DIR = "/work/m3-file-download";

const available = await dockerAvailable();
describe.skipIf(!available)("M3 workspace file download (real image)", () => {
  let stack: Stack;
  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      modelBaseUrl: "http://127.0.0.1:1",
      modelAuthToken: "unused-t2-token",
      defaultModel: "unused-model",
      cheapModel: "unused-cheap-model",
      label: "m3-file-download",
    });
  }, 180_000);
  afterAll(async () => stopStack(stack), 120_000);

  /** Run a fixed shell snippet in the workspace; the paths are this file's constants. */
  async function sh(script: string, stdin?: string): Promise<void> {
    const result = await stack.docker.exec(stack.handle, {
      cmd: ["sh", "-c", script],
      timeoutMs: 30_000,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(`workspace shell failed (${result.exitCode}): ${result.stderr}`);
  }

  function download(workspaceId: string, path: string): Promise<Response> {
    return fetch(
      `${stack.gatewayUrl}/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${stack.config.operatorToken}` } },
    );
  }

  it("downloads a file written into /work byte-identical, with attachment headers", async () => {
    // Every byte value, then random bytes: a text-only path through exec would corrupt these.
    const bytes = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      randomBytes(200_000),
    ]);
    await sh(`mkdir -p ${DIR} && base64 -d > ${DIR}/result.bin`, bytes.toString("base64"));
    const response = await download(stack.workspace.id, `${DIR}/result.bin`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="result.bin"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  }, 60_000);

  it("downloads from the bot's home and accepts exactly 1 MiB", async () => {
    const home = `/home/${stack.bot.name}`;
    await sh(`mkdir -p ${home} && printf 'a,b\\n1,2\\n' > ${home}/out.csv`);
    const csv = await download(stack.workspace.id, `${home}/out.csv`);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toBe("a,b\n1,2\n");

    await sh(`mkdir -p ${DIR} && head -c ${MIB} /dev/urandom > ${DIR}/exact.bin`);
    const exact = await download(stack.workspace.id, `${DIR}/exact.bin`);
    expect(exact.status).toBe(200);
    expect((await exact.arrayBuffer()).byteLength).toBe(MIB);
  }, 60_000);

  it("accepts files over 1 MiB and refuses protected paths or a file over 1 GiB", async () => {
    await sh(
      [
        "mkdir -p /profile",
        "[ -e /profile/Cookies ] || printf 'm3-download-cookie' > /profile/Cookies",
        `mkdir -p ${DIR}`,
        `ln -sfn /profile/Cookies ${DIR}/cookies-link`,
        `head -c ${MIB + 1} /dev/zero > ${DIR}/big.bin`,
        `truncate -s ${GIB + 1} ${DIR}/too-big.bin`,
        `mkdir -p ${DIR}/subdir`,
      ].join(" && "),
    );
    const big = await download(stack.workspace.id, `${DIR}/big.bin`);
    expect(big.status).toBe(200);
    expect((await big.arrayBuffer()).byteLength).toBe(MIB + 1);
    const cases: Array<[string, number, string]> = [
      ["/profile/Cookies", 403, "forbidden"],
      [`${DIR}/cookies-link`, 403, "forbidden"],
      [`${DIR}/../../profile/Cookies`, 403, "forbidden"],
      [`${DIR}/subdir`, 403, "forbidden"],
      [`${DIR}/too-big.bin`, 413, "payload_too_large"],
      [`${DIR}/missing.bin`, 404, "not_found"],
    ];
    for (const [path, status, code] of cases) {
      const response = await download(stack.workspace.id, path);
      const body = (await response.json()) as { code: string; message: string };
      expect(response.status, path).toBe(status);
      expect(body.code, path).toBe(code);
      expect(body.message, path).not.toContain("m3-download-cookie");
    }
  }, 60_000);

  it("reports a workspace with no running container and does not start one", async () => {
    const created = await stack.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      defaultBot: false,
      name: "m3-file-download-stopped",
      egressAllowlist: [],
    });
    expect(created.status).toBe(201);
    const stopped = created.json.workspace;
    const specsBefore = stack.provider.specs.length;
    const response = await download(stopped.id, "/work/anything.md");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "not_found",
      details: { reason: "workspace_not_running" },
    });
    expect(stack.provider.specs.length).toBe(specsBefore);
    expect(await stack.docker.attach(stopped.id)).toBeUndefined();
  }, 60_000);
});
