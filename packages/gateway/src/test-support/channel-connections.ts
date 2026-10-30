// T1 fixture for ABI-2 channel connections (ADR-0047): a Gateway with fake ABI-2 providers from
// `@deskmates/testkit`, two workspaces with Bots, an in-memory `/work/uploads` behind the
// `file-write` container command, and helpers for the connection API.

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotDefinition,
  BotId,
  ChannelConnection,
  ExecRequest,
  ExecResult,
  ThreadId,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import type { FakeChannelProvider } from "@deskmates/testkit";
import type { GatewayContext } from "../context.js";
import { type Harness, startHarness } from "./harness.js";

export const CHANNEL_SECRETS_KEY = Buffer.alloc(32, 47).toString("base64");

export interface ChannelFixture {
  harness: Harness;
  ctx: GatewayContext;
  stateRoot: string;
  workspace: Workspace;
  alice: BotDefinition;
  bob: BotDefinition;
  other: { workspace: Workspace; carol: BotDefinition };
  /** Paths the fake `file-write` committed. */
  uploads: Map<string, number>;
  connect(input: {
    pluginId: string;
    token: string;
    botId: BotId;
    workspaceId?: WorkspaceId;
  }): Promise<{ status: number; json: { connection: ChannelConnection; code?: string } }>;
  command(
    connectionId: string,
    command: string,
    body?: unknown,
    workspaceId?: WorkspaceId,
  ): Promise<{ status: number; json: { connection: ChannelConnection | null; code?: string } }>;
  rebind(
    connectionId: string,
    botId: BotId,
  ): Promise<{
    status: number;
    json: {
      connection: ChannelConnection;
      fence: { runsCancelled: number; outboundCancelled: number };
      code?: string;
    };
  }>;
  /** A Bot's reply in a thread, as a run would post it, published to the bus. */
  reply(threadId: string, botId: BotId, body: string): void;
  /** Start the workspace sandbox so uploads can be written. */
  running(workspaceId?: WorkspaceId): Promise<void>;
  close(): Promise<void>;
}

export async function startChannelFixture(
  providers: readonly FakeChannelProvider[],
): Promise<ChannelFixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), "deskmates-channel-abi2-"));
  const harness = await startHarness(
    { secretsKey: CHANNEL_SECRETS_KEY, channelStateDir: stateRoot },
    undefined,
    { channelPlugins: new Map(providers.map((p) => [p.plugin.manifest.id, p.plugin])) },
  );
  const ctx = harness.app.deskmates.ctx;
  // Runs woken by channel messages stay live until a test cancels them or the fixture closes.
  let release: () => void = () => {};
  const released = new Promise<void>((done) => {
    release = done;
  });
  harness.provider.onRun(() => released);
  const seeded = await harness.seed();
  const bob = ctx.bots.create({ name: "bob", role: "tester", workspaceId: seeded.workspace.id });
  const second = await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name: "ws-2",
    egressAllowlist: ["*.example.test"],
    defaultBot: false,
  });
  const carol = ctx.bots.create({
    name: "carol",
    role: "tester",
    workspaceId: second.json.workspace.id,
  });

  const uploads = new Map<string, number>();
  const partial = new Map<string, Buffer[]>();
  const original = harness.provider.exec.bind(harness.provider);
  const out = (body: unknown, exitCode = 0): ExecResult => ({
    exitCode,
    stdout: `${JSON.stringify(body)}\n`,
    stderr: "",
    timedOut: false,
  });
  harness.provider.exec = async (handle, req: ExecRequest): Promise<ExecResult> => {
    if (req.cmd.join(" ") !== "deskmates-sidecar file-write") return original(handle, req);
    const r = JSON.parse(req.stdin ?? "{}") as {
      op: string;
      uploadId: string;
      base64?: string;
      dir?: string;
      name?: string;
    };
    const parts = partial.get(r.uploadId);
    switch (r.op) {
      case "begin":
        partial.set(r.uploadId, []);
        return out({ op: "begin", receivedBytes: 0 });
      case "append": {
        if (!parts) return out({ error: "not_found", message: "gone" }, 1);
        parts.push(Buffer.from(r.base64 ?? "", "base64"));
        return out({ op: "append", receivedBytes: Buffer.concat(parts).length });
      }
      case "commit": {
        if (!parts) return out({ error: "not_found", message: "gone" }, 1);
        const bytes = Buffer.concat(parts);
        const path = `/work/uploads/${r.dir}/${r.name}`;
        uploads.set(path, bytes.length);
        partial.delete(r.uploadId);
        return out({
          op: "commit",
          path,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      case "abort":
        return out({ op: "abort", removed: partial.delete(r.uploadId) });
      default:
        return out({ error: "validation", message: "x" }, 1);
    }
  };

  const base = (workspaceId: WorkspaceId, connectionId: string) =>
    `/api/workspaces/${workspaceId}/channel-connections/${connectionId}`;
  return {
    harness,
    ctx,
    stateRoot,
    workspace: seeded.workspace,
    alice: seeded.bot,
    bob,
    other: { workspace: second.json.workspace, carol },
    uploads,
    connect: (input) =>
      harness.api(
        "POST",
        `/api/workspaces/${input.workspaceId ?? seeded.workspace.id}/channels/${input.pluginId}/connect`,
        {
          method: "token",
          botId: input.botId,
          config: { token: input.token },
        },
      ),
    command: (connectionId, command, body, workspaceId) =>
      harness.api(
        "POST",
        `${base(workspaceId ?? seeded.workspace.id, connectionId)}/commands/${command}`,
        body ?? {},
      ),
    rebind: (connectionId, botId) =>
      harness.api("POST", `${base(seeded.workspace.id, connectionId)}/rebind`, { botId }),
    reply: (threadId, botId, body) => {
      const message = ctx.messages.append({
        threadId: threadId as ThreadId,
        authorKind: "bot",
        authorId: botId,
        body,
        relayCount: 1,
      });
      ctx.bus.publish({ type: "thread_message", threadId: threadId as ThreadId, message });
    },
    running: async (workspaceId) => {
      await ctx.sandboxes.ensure(ctx.workspaces.mustGet(workspaceId ?? seeded.workspace.id));
    },
    close: async () => {
      release();
      await harness.close();
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
}
