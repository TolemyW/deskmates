// T1 only: real Gateway/adapter, synthetic account/provider and local artifact sink.
// No real OAuth, Google traffic, provider credentials, or workspace delivery is exercised.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationExecuteResult, IntegrationSearchResult } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type IntegrationFixture,
  RUNTIME_URL,
  integrationFixture,
} from "../test-support/integration-fixture.js";
import {
  DRIVE_ACCEPTANCE_TEXT,
  type DriveAcceptanceIO,
  verifyDriveAcceptance,
} from "./drive-acceptance-harness.js";
import { PINNED_DRIVE_DEFINITIONS } from "./drive-pinned-definitions.js";
import { RuntimeAdapter } from "./runtime-adapter.js";

let f: IntegrationFixture | undefined;
let directory: string | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const binding = {
  account: "synthetic-account",
  folderId: "dedicated-folder",
  connectionName: "scratch",
  runLabel: "offline",
};

async function setup() {
  const fx = await integrationFixture();
  f = fx;
  await fx.adopt("googledrive");
  await fx.h.api("PUT", "/api/integrations/providers/googledrive/oauth-app", {
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    requestedScopes: ["https://www.googleapis.com/auth/drive"],
  });
  const started = await fx.h.api<{ authorizationUrl: string }>(
    "POST",
    `/api/integrations/workspaces/${fx.a.workspace.id}/connections/oauth/start`,
    {
      service: "googledrive",
      connectionName: binding.connectionName,
    },
  );
  expect(started.status).toBe(200);
  const state = new URL(started.json.authorizationUrl).searchParams.get("state");
  expect(
    (await fetch(`${fx.h.baseUrl}/api/integrations/oauth/callback?code=synthetic&state=${state}`))
      .status,
  ).toBe(200);
  let file: Record<string, unknown> | undefined;
  let fail: string | undefined;
  fx.fake.actionResult = (action, input) => {
    if (fail) return { ok: false, error: { code: fail, message: "Synthetic provider refusal" } };
    if (action === "googledrive.files.list") {
      expect(input).toEqual({
        q: "'dedicated-folder' in parents and trashed = false",
        pageSize: 5,
      });
      return { ok: true, data: { files: [] } };
    }
    if (action === "googledrive.files.create") {
      expect(input.parents).toEqual([binding.folderId]);
      expect(input.text).toBe(DRIVE_ACCEPTANCE_TEXT);
      file = { id: "synthetic-created-file", name: input.name, parents: input.parents };
      return { ok: true, data: file };
    }
    if (action === "googledrive.files.get") {
      if (input.fileId === binding.folderId)
        return {
          ok: true,
          data: { id: binding.folderId, mimeType: "application/vnd.google-apps.folder" },
        };
      expect(input.fileId).toBe(file?.id);
      return {
        ok: true,
        data:
          input.alt === "media"
            ? {
                file: {
                  downloadUrl: `${RUNTIME_URL}/api/files/0123456789abcdef0123456789abcdef.txt`,
                },
              }
            : file,
      };
    }
    throw new Error("Unexpected acceptance action");
  };
  directory = await mkdtemp(join(tmpdir(), "deskmates-drive-acceptance-"));
  const path = join(directory, "artifact.txt");
  const downloads: RequestInit[] = [];
  const adapter = new RuntimeAdapter({
    url: RUNTIME_URL,
    adminToken: "synthetic-admin",
    fetch: async (_url, init) => {
      downloads.push(init ?? {});
      return new Response(DRIVE_ACCEPTANCE_TEXT);
    },
  });
  const io: DriveAcceptanceIO = {
    definition: async (id) => {
      const expected = PINNED_DRIVE_DEFINITIONS.find((d) => d.id === id);
      if (!expected) throw new Error("Unknown action");
      return structuredClone(expected);
    },
    search: async (actionId) =>
      (
        await fx.run<IntegrationSearchResult>(fx.a, "POST", "/search", {
          service: "googledrive",
          query: actionId,
        })
      ).json,
    execute: async (actionId, input) =>
      (
        await fx.run<IntegrationExecuteResult>(fx.a, "POST", "/execute", {
          actionId,
          connectionName: binding.connectionName,
          input,
        })
      ).json,
    download: (url) => adapter.downloadTransit(url),
    deliver: async (bytes) => {
      await writeFile(path, bytes, { flag: "wx" });
      return { path, readBack: await readFile(path) };
    },
  };
  return {
    fx,
    io,
    downloads,
    fail: (code: string) => {
      fail = code;
    },
  };
}

describe("M4 Drive acceptance procedure (offline evidence only)", () => {
  it("binds folder-scoped read/write, exact content and delivery hash through existing Gateway meta-tools", async () => {
    const { fx, io, downloads } = await setup();
    const report = await verifyDriveAcceptance(binding, io);
    expect(report.bytes).toBe(Buffer.byteLength(DRIVE_ACCEPTANCE_TEXT));
    expect(report.receipts).toHaveLength(5);
    expect(await readFile(report.artifactPath, "utf8")).toBe(DRIVE_ACCEPTANCE_TEXT);
    expect(downloads).toHaveLength(1);
    expect(new Headers(downloads[0]?.headers).has("authorization")).toBe(false);
    expect(fx.fake.executions.map((e) => e.actionId)).toEqual([
      "googledrive.files.get",
      "googledrive.files.list",
      "googledrive.files.create",
      "googledrive.files.get",
      "googledrive.files.get",
    ]);
    const connection = fx.h.app.deskmates.ctx.integrations.listConnections(fx.a.workspace.id)[0];
    expect(connection).toBeDefined();
    expect(
      (
        await fx.run(fx.b, "POST", "/execute", {
          actionId: "googledrive.files.get",
          connectionName: "scratch",
          input: { fileId: binding.folderId },
        })
      ).status,
    ).toBe(403);
    await fx.h.api(
      "DELETE",
      `/api/integrations/workspaces/${fx.a.workspace.id}/connections/${connection?.id}`,
    );
    const count = fx.fake.executions.length;
    expect(
      (
        await fx.run(fx.a, "POST", "/execute", {
          actionId: "googledrive.files.get",
          connectionName: "scratch",
          input: { fileId: binding.folderId },
        })
      ).status,
    ).toBe(403);
    expect(fx.fake.executions).toHaveLength(count);
    expect([...fx.fake.tokens.values()].every((t) => t.revoked)).toBe(true);
  });

  it.each(["refresh_failed", "egress_denied", "provider_unavailable"])(
    "isolates synthetic %s without retry or write",
    async (code) => {
      const { fx, io, fail, downloads } = await setup();
      fail(code);
      await expect(verifyDriveAcceptance(binding, io)).rejects.toMatchObject({
        partial: { stage: "folder_metadata", writeAttempted: false },
      });
      expect(fx.fake.executions).toHaveLength(1);
      expect(downloads).toHaveLength(0);
      // Other provider/workspace remains usable after this connection's failure.
      await fx.adopt("gitea");
      await fx.apiKey(fx.b, "other", "synthetic-key");
      fx.fake.actionResult = undefined;
      expect(
        (
          await fx.run<IntegrationExecuteResult>(fx.b, "POST", "/execute", {
            actionId: "gitea.list_my_repositories",
            input: {},
          })
        ).json.ok,
      ).toBe(true);
    },
  );

  it("fails closed on catalog mismatch before reading or writing", async () => {
    const { fx, io } = await setup();
    io.search = async () => ({ service: "googledrive", actions: [] });
    await expect(verifyDriveAcceptance(binding, io)).rejects.toThrow("catalog mismatch");
    expect(fx.fake.executions).toHaveLength(0);
  });

  it("does not retry a successful write after transit failure or deliver partial data", async () => {
    const { fx, io } = await setup();
    let deliveries = 0;
    io.download = async () => {
      throw new Error("transit expired");
    };
    io.deliver = async () => {
      deliveries++;
      throw new Error("unexpected delivery");
    };
    await expect(verifyDriveAcceptance(binding, io)).rejects.toMatchObject({
      partial: {
        stage: "transit",
        fileId: "synthetic-created-file",
        receipts: expect.any(Array),
        writeAttempted: true,
      },
    });
    expect(fx.fake.executions.filter((e) => e.actionId.endsWith("create"))).toHaveLength(1);
    expect(deliveries).toBe(0);
  });

  it("rejects corrupt downloaded or delivered bytes", async () => {
    const { io } = await setup();
    const download = io.download;
    io.download = async () => new Uint8Array([1]);
    await expect(verifyDriveAcceptance(binding, io)).rejects.toMatchObject({
      partial: { stage: "transit", fileId: "synthetic-created-file" },
    });
    io.download = download;
    io.deliver = async () => ({ path: "synthetic", readBack: new Uint8Array([1]) });
    await expect(verifyDriveAcceptance(binding, io)).rejects.toMatchObject({
      partial: { stage: "delivery", fileId: "synthetic-created-file" },
    });
  });

  it("rejects complete schema drift before provider actions", async () => {
    const { fx, io } = await setup();
    const definition = io.definition;
    io.definition = async (id) => ({
      ...(await definition(id)),
      inputSchema: { type: "object", required: ["unexpected"] },
    });
    await expect(verifyDriveAcceptance(binding, io)).rejects.toThrow("schema mismatch");
    expect(fx.fake.executions).toHaveLength(0);
  });

  it("retains created identity when the write result lacks an execution receipt", async () => {
    const { fx, io } = await setup();
    const execute = io.execute;
    io.execute = async (id, input) => {
      const result = await execute(id, input);
      if (id.endsWith("create")) {
        const { executionId: _receipt, ...withoutReceipt } = result;
        return withoutReceipt;
      }
      return result;
    };
    await expect(verifyDriveAcceptance(binding, io)).rejects.toMatchObject({
      partial: {
        stage: "create",
        writeAttempted: true,
        fileId: "synthetic-created-file",
        receipts: expect.any(Array),
      },
    });
    expect(fx.fake.executions.filter((e) => e.actionId.endsWith("create"))).toHaveLength(1);
  });
});

it("keeps local revoke effective when runtime removal fails, and retries removal after recovery", async () => {
  const { fx } = await setup();
  const connection = fx.h.app.deskmates.ctx.integrations.listConnections(fx.a.workspace.id)[0];
  const path = `/api/integrations/workspaces/${fx.a.workspace.id}/connections/${connection?.id}`;
  fx.fake.setAvailable(false);
  expect((await fx.h.api("DELETE", path)).status).toBe(503);
  fx.fake.setAvailable(true);
  const before = fx.fake.executions.length;
  expect(
    (
      await fx.run(fx.a, "POST", "/execute", {
        actionId: "googledrive.files.get",
        connectionName: "scratch",
        input: { fileId: binding.folderId },
      })
    ).status,
  ).toBe(403);
  expect(fx.fake.executions).toHaveLength(before);
  expect((await fx.h.api("DELETE", path)).status).toBe(200);
  expect([...fx.fake.tokens.values()].every((t) => t.revoked)).toBe(true);
});
