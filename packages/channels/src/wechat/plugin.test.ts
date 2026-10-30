import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelOpenRequest, ChannelPluginRuntimeV2 } from "@deskmates/contracts";
import { channelManifestV2Problems } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeConnectionHost } from "../test-support/fake-whatsapp-connection-host.js";
import type { JsonObject, WechatTransport } from "./api.js";
import { chunks, privateMessage } from "./messages.js";
import { createWechatPlugin } from "./plugin.js";
import { WechatState } from "./state.js";

const runtimes: ChannelPluginRuntimeV2[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const message = (id = 1, extra: JsonObject = {}) => ({
  message_id: id,
  from_user_id: "peer",
  message_type: 1,
  message_state: 2,
  context_token: "private-context",
  item_list: [{ type: 1, text_item: { text: "hello" } }],
  ...extra,
});

async function setup(options: { refuse?: string; confirmed?: JsonObject } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wechat-test-"));
  directories.push(directory);
  const host = createFakeConnectionHost({ channel: "wechat" });
  host.refuseClaim = options.refuse;
  const log = vi.fn();
  host.log = log;
  const batches: JsonObject[] = [];
  const sends: JsonObject[] = [];
  const calls: { path: string; body?: JsonObject }[] = [];
  let sendResult: JsonObject = { ret: 0 };
  const transport: WechatTransport = async (url, init) => {
    const path = new URL(url).pathname.split("/").at(-1) as string;
    const body = init.body ? (JSON.parse(String(init.body)) as JsonObject) : undefined;
    calls.push({ path, ...(body ? { body } : {}) });
    if (path === "get_bot_qrcode")
      return Response.json({ qrcode: "challenge", qrcode_img_content: "https://weixin.qq.com/qr" });
    if (path === "get_qrcode_status")
      return Response.json(
        options.confirmed ?? {
          status: "confirmed",
          bot_token: "private-token",
          ilink_bot_id: "account",
          baseurl: "https://ilinkai.weixin.qq.com",
        },
      );
    if (path === "sendmessage") {
      sends.push(body as JsonObject);
      return Response.json(sendResult);
    }
    if (path === "getupdates") {
      if (batches.length) return Response.json(batches.shift());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        init.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      return Response.json({ ret: 0, msgs: [] });
    }
    throw new Error("unexpected path");
  };
  const plugin = createWechatPlugin({
    transport,
    encodeQr: async () => "data:image/png;base64,AAAA",
    pollPauseMs: 1,
    retryMs: 5,
  });
  const runtime = await plugin.create({ log });
  runtimes.push(runtime);
  const request: ChannelOpenRequest = {
    connectionId: host.connectionId,
    workspaceId: host.workspaceId,
    botId: host.botId,
    identityKey: "wechat:pending:chn_fake",
    bindingGeneration: 1,
    credentialGeneration: 1,
    reason: "connect",
    method: "qr",
    config: {},
    secrets: {},
    stateDirectory: directory,
  };
  await runtime.open(request, host);
  return {
    plugin,
    runtime,
    host,
    batches,
    sends,
    calls,
    directory,
    request,
    log,
    setSendResult: (result: JsonObject) => {
      sendResult = result;
    },
  };
}
const connected = async (s: Awaited<ReturnType<typeof setup>>) => {
  await vi.waitFor(async () =>
    expect((await s.runtime.status(s.host.connectionId)).phase).toBe("connected"),
  );
};

describe("native WeChat connection", () => {
  it("claims the scanned identity, persists private credentials and exposes no token in status or logs", async () => {
    const s = await setup();
    await connected(s);
    expect(channelManifestV2Problems(s.plugin.manifest)).toEqual([]);
    expect(s.plugin.manifest.capabilities).toMatchObject({
      groups: "unavailable",
      inboundImages: "disabled",
    });
    expect(s.host.claims).toEqual([{ identityKey: "wechat:ilink:account", label: "account" }]);
    expect(statSync(join(s.directory, "wechat-state.json")).mode & 0o777).toBe(0o600);
    expect(
      JSON.stringify([await s.runtime.status(s.host.connectionId), s.log.mock.calls]),
    ).not.toContain("private-token");
  });
  it.each(["channel_identity_in_use", "channel_identity_mismatch"])(
    "stops before polling on %s",
    async (refuse) => {
      const s = await setup({ refuse });
      await vi.waitFor(async () =>
        expect((await s.runtime.status(s.host.connectionId)).phase).toBe("error"),
      );
      expect(s.calls.some((c) => c.path === "getupdates")).toBe(false);
      expect(readFileSync(join(s.directory, "wechat-state.json"), "utf8")).not.toContain(
        "private-token",
      );
    },
  );
  it("deduplicates inbound, relays bot/system messages with the peer context and recovers without another QR", async () => {
    const s = await setup();
    await connected(s);
    s.batches.push({ ret: 0, msgs: [message(), message()], get_updates_buf: "cursor-1" });
    await vi.waitFor(() => expect(s.host.received).toHaveLength(1));
    const thread = [...s.host.threads.keys()][0] as string;
    s.host.append(thread, { body: "answer" });
    s.host.append(thread, { body: "notice", authorKind: "system" });
    await vi.waitFor(() => expect(s.host.sent).toHaveLength(2));
    expect(s.sends).toHaveLength(2);
    expect(s.sends[0]).toMatchObject({
      msg: { to_user_id: "peer", context_token: "private-context", message_type: 2 },
    });
    await s.runtime.close(s.request.connectionId, "reconnect");
    await s.runtime.open(
      { ...s.request, reason: "restore", identityKey: "wechat:ilink:account" },
      s.host,
    );
    await connected(s);
    expect(s.calls.filter((c) => c.path === "get_bot_qrcode")).toHaveLength(1);
    expect(s.calls.filter((c) => c.path === "getupdates").at(-1)?.body).toMatchObject({
      get_updates_buf: "cursor-1",
    });
    expect(s.sends).toHaveLength(2);
  });
  it("drops groups, echoes and blocked senders; refuses media without posting a task", async () => {
    const s = await setup();
    await connected(s);
    s.host.blocked.add("blocked");
    s.batches.push({
      ret: 0,
      msgs: [
        message(1, { group_id: "group" }),
        message(2, { message_type: 2 }),
        message(3, { from_user_id: "blocked" }),
        message(4, { item_list: [{ type: 2 }] }),
      ],
    });
    await vi.waitFor(() => expect(s.sends).toHaveLength(1));
    expect(s.host.received).toHaveLength(0);
    expect(s.sends[0]).toMatchObject({
      msg: {
        to_user_id: "peer",
        item_list: [{ text_item: { text: expect.stringContaining("text only") } }],
      },
    });
  });
  it("retains the provider cursor on a failed host post, then retries without losing the message", async () => {
    const s = await setup();
    await connected(s);
    const receive = s.host.receive;
    s.host.receive = vi
      .fn()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockImplementation(receive);
    s.batches.push({ msgs: [message()], get_updates_buf: "must-not-commit" });
    await vi.waitFor(() => expect(s.host.receive).toHaveBeenCalledTimes(1));
    expect(readFileSync(join(s.directory, "wechat-state.json"), "utf8")).not.toContain(
      "must-not-commit",
    );
    s.batches.push({ msgs: [message()], get_updates_buf: "committed" });
    await vi.waitFor(() => expect(s.host.received).toHaveLength(1));
  });
  it("requires an explicit send acknowledgment and does not mark a failed send as delivered", async () => {
    const s = await setup();
    await connected(s);
    s.setSendResult({});
    s.batches.push({ msgs: [message()] });
    await vi.waitFor(() => expect(s.host.received).toHaveLength(1));
    s.host.append([...s.host.threads.keys()][0] as string, { body: "answer" });
    await vi.waitFor(() => expect(s.sends.length).toBeGreaterThan(0));
    expect(s.host.sent).toHaveLength(0);
    s.setSendResult({ ret: 0 });
    await vi.waitFor(() => expect(s.host.sent).toHaveLength(1));
  });
  it("stops on expired authorization and clears QR and secrets from public status", async () => {
    const s = await setup();
    await connected(s);
    s.batches.push({ ret: -14, errmsg: "private-token" });
    await vi.waitFor(async () =>
      expect((await s.runtime.status(s.host.connectionId)).phase).toBe("logged_out"),
    );
    expect(JSON.stringify(await s.runtime.status(s.host.connectionId))).not.toMatch(
      /private-token|private-context|data:image/,
    );
  });
  it("makes unsupported verification explicit instead of pretending the connection succeeded", async () => {
    const s = await setup({ confirmed: { status: "need_verifycode" } });
    await vi.waitFor(async () =>
      expect(await s.runtime.status(s.host.connectionId)).toMatchObject({
        phase: "error",
        message: expect.stringContaining("verification"),
      }),
    );
    expect(s.host.claims).toHaveLength(0);
  });
  it("shows a transient QR while waiting and stops its login loop on disconnect", async () => {
    const s = await setup({ confirmed: { status: "wait" } });
    await vi.waitFor(async () =>
      expect(await s.runtime.status(s.host.connectionId)).toMatchObject({
        phase: "qr",
        qr: "data:image/png;base64,AAAA",
      }),
    );
    await s.runtime.close(s.host.connectionId, "disconnect");
    expect(await s.runtime.status(s.host.connectionId)).toEqual({ phase: "stopped" });
    expect(s.host.claims).toHaveLength(0);
    expect(s.calls.some((call) => call.path === "getupdates")).toBe(false);
  });
  it("bounds expired QR refreshes and does not persist a QR challenge", async () => {
    const s = await setup({ confirmed: { status: "expired" } });
    await vi.waitFor(async () =>
      expect((await s.runtime.status(s.host.connectionId)).phase).toBe("error"),
    );
    expect(s.calls.filter((call) => call.path === "get_bot_qrcode")).toHaveLength(3);
    expect(readFileSync(join(s.directory, "wechat-state.json"), "utf8")).not.toContain("challenge");
  });
  it("refuses an untrusted confirmed API destination before claiming or sending credentials", async () => {
    const s = await setup({
      confirmed: {
        status: "confirmed",
        bot_token: "private-token",
        ilink_bot_id: "account",
        baseurl: "https://evil.example",
      },
    });
    await vi.waitFor(async () =>
      expect((await s.runtime.status(s.host.connectionId)).phase).toBe("error"),
    );
    expect(s.host.claims).toHaveLength(0);
    expect(s.calls.some((call) => call.path === "getupdates")).toBe(false);
  });
  it("keeps reply contexts separate for different people", async () => {
    const s = await setup();
    await connected(s);
    s.batches.push({
      msgs: [message(1), message(2, { from_user_id: "other", context_token: "other-context" })],
    });
    await vi.waitFor(() => expect(s.host.received).toHaveLength(2));
    for (const thread of s.host.threads.keys()) s.host.append(thread, { body: "reply" });
    await vi.waitFor(() => expect(s.host.sent).toHaveLength(2));
    expect(s.sends.map((send) => send.msg)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to_user_id: "peer", context_token: "private-context" }),
        expect.objectContaining({ to_user_id: "other", context_token: "other-context" }),
      ]),
    );
  });
  it("sends an approval command to the scoped host without starting a conversation", async () => {
    const s = await setup();
    await connected(s);
    const decide = vi.spyOn(s.host, "decideApproval");
    s.batches.push({
      msgs: [
        message(1, {
          item_list: [{ type: 1, text_item: { text: "approve approval_0123456789abcdef" } }],
        }),
      ],
    });
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith({
        id: "approval_0123456789abcdef",
        decision: "allow_once",
        senderId: "peer",
      }),
    );
    expect(s.host.received).toHaveLength(0);
    await vi.waitFor(() => expect(s.sends).toHaveLength(1));
  });
  it("stops a stale host before any outbound send", async () => {
    const s = await setup();
    await connected(s);
    s.batches.push({ msgs: [message()] });
    await vi.waitFor(() => expect(s.host.received).toHaveLength(1));
    s.host.stale = true;
    s.host.append([...s.host.threads.keys()][0] as string, { body: "do not send" });
    await vi.waitFor(async () =>
      expect((await s.runtime.status(s.host.connectionId)).phase).toBe("error"),
    );
    expect(s.sends).toHaveLength(0);
  });
  it("never sends without a reply context, and resumes when the peer sends one", async () => {
    const s = await setup();
    await connected(s);
    s.batches.push({ msgs: [message(1, { context_token: undefined })] });
    await vi.waitFor(() => expect(s.host.received).toHaveLength(1));
    s.host.append([...s.host.threads.keys()][0] as string, { body: "answer" });
    expect(s.sends).toHaveLength(0);
    s.batches.push({ msgs: [message(2)] });
    await vi.waitFor(() => expect(s.host.sent).toHaveLength(1));
  });
  it("clears session and reply contexts on relink; rebind retains auth but drops old threads", async () => {
    const s = await setup();
    await connected(s);
    await s.runtime.close(s.request.connectionId, "relink");
    const state = new WechatState(s.directory, 1, 1);
    state.data.contexts.peer = "old-context";
    state.cursor("old-thread");
    state.save();
    const rebound = new WechatState(s.directory, 2, 1);
    expect(rebound.data.session?.token).toBe("private-token");
    expect(Object.keys(rebound.data.threads)).toEqual([]);
    expect(Object.keys(rebound.data.contexts)).toEqual([]);
    const relinked = new WechatState(s.directory, 2, 2);
    expect(relinked.data.session).toBeUndefined();
    expect(relinked.data.updateCursor).toBe("");
  });
  it("rejects unsafe ids and chunks Unicode without breaking surrogate pairs", () => {
    expect(privateMessage(message(Number.MAX_SAFE_INTEGER + 1))).toBeUndefined();
    const text = "😀".repeat(2001);
    expect(chunks(text).join("")).toBe(text);
    expect(chunks(text)).toHaveLength(2);
  });
});
