import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelCommand,
  ChannelConnectRequest,
  ChannelPlugin,
  ChannelPluginRuntime,
  ChannelWebhookRequest,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

const SECRET = "whatsapp-cloud-secret-never-public";
const SECRETS_KEY = Buffer.alloc(32, 43).toString("base64");
const roots: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakePlugin(record: {
  connects: ChannelConnectRequest[];
  commands: { command: ChannelCommand; input?: Readonly<Record<string, unknown>> }[];
  webhooks: ChannelWebhookRequest[];
}): ChannelPlugin {
  const statuses = new Map<string, { phase: string; account?: string }>();
  const runtime: ChannelPluginRuntime = {
    async connect(request) {
      record.connects.push(request);
      const status = { phase: "connected", account: "+15550001111" };
      statuses.set(request.connectionId, status);
      return status;
    },
    async restore(request) {
      return this.connect(request);
    },
    async status(connectionId) {
      return statuses.get(connectionId) ?? { phase: "idle" };
    },
    async command(connectionId, command, input) {
      record.commands.push({ command, ...(input ? { input } : {}) });
      if (command === "disconnect") {
        statuses.delete(connectionId);
        return { phase: "disconnected" };
      }
      return statuses.get(connectionId) ?? { phase: "connected" };
    },
    async webhook(request) {
      record.webhooks.push(request);
      return { status: 202, headers: { "x-channel-test": "ok" }, body: "accepted" };
    },
    async stop() {},
  };
  return {
    manifest: {
      apiVersion: 1,
      id: "whatsapp",
      version: "1.0.0",
      displayName: "WhatsApp",
      description: "Fake WhatsApp",
      capabilities: { directMessages: true, groups: false, testMessage: true },
      methods: [
        {
          id: "cloud",
          label: "Cloud API",
          description: "Cloud API",
          fields: [
            { key: "phoneNumberId", label: "Phone number ID", kind: "text", required: true },
            {
              key: "accessToken",
              label: "Access token",
              kind: "password",
              secret: true,
              required: true,
            },
          ],
        },
        { id: "qr", label: "QR", description: "QR", fields: [] },
      ],
      statusVocabulary: ["connected", "disconnected"],
    },
    async create() {
      return runtime;
    },
  };
}

async function setup(plugin: ChannelPlugin) {
  const stateRoot = await mkdtemp(join(tmpdir(), "deskmates-channel-state-"));
  roots.push(stateRoot);
  const harness = await startHarness(
    { secretsKey: SECRETS_KEY, channelStateDir: stateRoot },
    undefined,
    { channelPlugins: new Map([[plugin.manifest.id, plugin]]) },
  );
  harnesses.push(harness);
  const seeded = await harness.seed();
  return { harness, seeded, stateRoot };
}

describe("channel product lifecycle (ADR-0017 amendment 1)", () => {
  it("keeps provider secrets encrypted while connecting, testing and disconnecting", async () => {
    const record = { connects: [], commands: [], webhooks: [] } as {
      connects: ChannelConnectRequest[];
      commands: { command: ChannelCommand; input?: Readonly<Record<string, unknown>> }[];
      webhooks: ChannelWebhookRequest[];
    };
    const { harness, seeded, stateRoot } = await setup(fakePlugin(record));

    const catalog = await harness.api<{ plugins: { manifest: { id: string } }[] }>(
      "GET",
      "/api/channels",
    );
    expect(catalog.status).toBe(200);
    expect(catalog.json.plugins[0]?.manifest.id).toBe("whatsapp");

    const connected = await harness.api<{
      connection: { id: string; config: Record<string, unknown>; status: { phase: string } };
    }>("POST", `/api/workspaces/${seeded.workspace.id}/channels/whatsapp/connect`, {
      method: "cloud",
      botId: seeded.bot.id,
      config: { phoneNumberId: "phone-1", accessToken: SECRET },
    });
    expect(connected.status).toBe(201);
    expect(connected.json.connection.config).toEqual({ phoneNumberId: "phone-1" });
    expect(connected.json.connection.status.phase).toBe("connected");
    expect(record.connects[0]?.secrets).toEqual({ accessToken: SECRET });

    const row = harness.app.deskmates.ctx.db
      .prepare(
        `SELECT c.config_json, s.encrypted_blob
           FROM channel_connections c JOIN secrets s ON s.id = c.secret_id
          WHERE c.id = ?`,
      )
      .get(connected.json.connection.id) as { config_json: string; encrypted_blob: Buffer };
    expect(row.config_json).toBe('{"phoneNumberId":"phone-1"}');
    expect(row.encrypted_blob.includes(Buffer.from(SECRET))).toBe(false);
    const stateDirectory = join(
      stateRoot,
      seeded.workspace.id,
      "whatsapp",
      connected.json.connection.id,
    );
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);

    const duplicate = await harness.api<{ code: string }>(
      "POST",
      `/api/workspaces/${seeded.workspace.id}/channels/whatsapp/connect`,
      { method: "qr", botId: seeded.bot.id, config: {} },
    );
    expect(duplicate.status).toBe(409);

    const tested = await harness.api<{ connection: { status: { phase: string } } }>(
      "POST",
      `/api/workspaces/${seeded.workspace.id}/channels/whatsapp/commands/test`,
      { to: "+15551112222", text: "hello" },
    );
    expect(tested.status).toBe(200);
    expect(record.commands.at(-1)).toEqual({
      command: "test",
      input: { to: "+15551112222", text: "hello" },
    });

    const webhook = await fetch(
      `${harness.baseUrl}/api/channel-webhooks/${seeded.workspace.id}/whatsapp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"entry":[]}',
      },
    );
    expect(webhook.status).toBe(202);
    expect(webhook.headers.get("x-channel-test")).toBe("ok");
    expect(await webhook.text()).toBe("accepted");
    expect(Buffer.from(record.webhooks[0]?.body ?? []).toString("utf8")).toBe('{"entry":[]}');

    const disconnected = await harness.api<{ connection: null }>(
      "POST",
      `/api/workspaces/${seeded.workspace.id}/channels/whatsapp/commands/disconnect`,
      {},
    );
    expect(disconnected.status).toBe(200);
    expect(disconnected.json.connection).toBeNull();
    expect(harness.app.deskmates.ctx.db.prepare("SELECT count(*) AS n FROM secrets").get()).toEqual(
      {
        n: 0,
      },
    );
    await expect(stat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the Gateway healthy when one release plugin cannot start", async () => {
    const plugin = fakePlugin({ connects: [], commands: [], webhooks: [] });
    plugin.create = async () => {
      throw new Error("provider-specific startup detail");
    };
    const { harness } = await setup(plugin);
    const catalog = await harness.api<{
      plugins: unknown[];
      failures: { id: string; message: string }[];
    }>("GET", "/api/channels");
    expect(catalog.status).toBe(200);
    expect(catalog.json.plugins).toEqual([]);
    expect(catalog.json.failures).toEqual([
      { id: "whatsapp", message: "provider-specific startup detail" },
    ]);
    expect((await harness.api("GET", "/api/config")).status).toBe(200);
  });
});
