import { randomUUID } from "node:crypto";
import type {
  ChannelConnectionHost,
  ChannelConnectionStatus,
  ChannelOpenRequest,
} from "@deskmates/contracts";
import { isChannelIdentityKey } from "@deskmates/contracts";
import { parseApprovalCommand } from "../whatsapp/commands.js";
import { type JsonObject, type WechatApi, WechatApiError, sleep, wechatOrigin } from "./api.js";
import { chunks, privateMessage, render } from "./messages.js";
import { type WechatSession, WechatState } from "./state.js";

export interface WechatConnectionOptions {
  request: ChannelOpenRequest;
  host: ChannelConnectionHost;
  api: WechatApi;
  encodeQr(text: string): Promise<string>;
  retryMs?: number;
  pollPauseMs?: number;
}

/** Owns the two abortable loops, QR login and serialized per-thread reply delivery. */
export class WechatConnection {
  private readonly controller = new AbortController();
  private readonly state: WechatState;
  private snapshot: ChannelConnectionStatus = { phase: "connecting" };
  private run: Promise<void> | undefined;
  private subscription: Promise<void> | undefined;
  private readonly relays = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private session: WechatSession | undefined;

  constructor(private readonly options: WechatConnectionOptions) {
    const { request } = options;
    this.state = new WechatState(
      request.stateDirectory,
      request.bindingGeneration,
      request.credentialGeneration,
    );
  }
  status(): ChannelConnectionStatus {
    return { ...this.snapshot };
  }
  start(): ChannelConnectionStatus {
    this.run = this.monitor().catch((error: unknown) => this.fail(error));
    return this.status();
  }
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([this.run, this.subscription, ...this.relays.values()]);
    this.snapshot = { phase: "stopped" };
  }
  private get signal(): AbortSignal {
    return this.controller.signal;
  }
  private fail(error: unknown): void {
    if (this.signal.aborted) return;
    const code = error instanceof Error ? (error as { code?: string }).code : undefined;
    this.snapshot = {
      phase: error instanceof WechatApiError && error.revoked ? "logged_out" : "error",
      message:
        code === "channel_identity_in_use"
          ? "This WeChat account is already connected. Disconnect it there first."
          : code === "channel_identity_mismatch"
            ? "This is a different WeChat account. Link the original account or create a new connection."
            : error instanceof WechatApiError && error.revoked
              ? "WeChat authorization expired. Link this account again."
              : "WeChat could not continue. Reconnect or link the account again.",
    };
    this.controller.abort();
  }
  private async claim(session: WechatSession): Promise<void> {
    if (!this.options.host.claimIdentity) throw new Error("identity claims unavailable");
    await this.options.host.claimIdentity({
      identityKey: `wechat:ilink:${session.account}`,
      label: session.account,
    });
    if (this.signal.aborted) return;
    this.session = session;
    this.state.data.session = session;
    this.state.save();
  }

  private async login(): Promise<void> {
    let origin: string | undefined;
    // Bound QR refreshes and the total login lifetime. The operator can request a new link.
    const expires = Date.now() + 8 * 60_000;
    for (let refresh = 0; refresh < 3 && !this.signal.aborted && Date.now() < expires; refresh++) {
      const qr = await this.options.api.call("get_bot_qrcode?bot_type=3", {
        signal: this.signal,
        body: { local_token_list: [] },
      });
      if (
        typeof qr.qrcode !== "string" ||
        !qr.qrcode ||
        typeof qr.qrcode_img_content !== "string" ||
        !qr.qrcode_img_content ||
        qr.qrcode_img_content.length > 8192
      )
        throw new WechatApiError(502);
      const image = await this.options.encodeQr(qr.qrcode_img_content);
      if (this.signal.aborted) return;
      this.snapshot = {
        phase: "qr",
        qr: image,
        qrExpiresAt: new Date(Math.min(expires, Date.now() + 180_000)).toISOString(),
      };
      origin = undefined;
      while (!this.signal.aborted && Date.now() < expires) {
        let result: JsonObject;
        try {
          result = await this.options.api.call(
            `get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
            {
              signal: this.signal,
              ...(origin ? { origin } : {}),
            },
          );
        } catch (error) {
          if (
            error instanceof WechatApiError &&
            (error.status === 0 || error.status >= 500 || error.status === 429)
          ) {
            await sleep(Math.max(this.options.retryMs ?? 1000, error.retryAfterMs), this.signal);
            continue;
          }
          throw error;
        }
        if (this.signal.aborted) return;
        if (result.status === "confirmed") {
          const { bot_token: token, ilink_bot_id: account, baseurl } = result;
          if (
            typeof token !== "string" ||
            !token ||
            token.length > 16384 ||
            typeof account !== "string" ||
            !isChannelIdentityKey(`wechat:ilink:${account}`, "wechat") ||
            typeof baseurl !== "string"
          )
            throw new WechatApiError(502);
          await this.claim({ account, token, origin: wechatOrigin(baseurl) });
          return;
        }
        if (result.status === "expired") break;
        if (result.status === "scaned_but_redirect" && typeof result.redirect_host === "string") {
          origin = wechatOrigin(`https://${result.redirect_host}`);
        } else if (result.status !== "wait" && result.status !== "scaned") {
          this.snapshot = {
            phase: "error",
            message:
              result.status === "need_verifycode"
                ? "WeChat requires additional verification, which this version does not support. Complete account verification in WeChat, then link again."
                : "WeChat did not complete the link. Check your account in WeChat and link again.",
          };
          return;
        }
        await sleep(this.options.pollPauseMs ?? 1000, this.signal);
      }
    }
    if (!this.signal.aborted)
      this.snapshot = {
        phase: "error",
        message: "The WeChat QR code expired. Link again for a new code.",
      };
  }

  private async monitor(): Promise<void> {
    if (this.state.data.session) await this.claim(this.state.data.session);
    else await this.login();
    if (!this.session || this.signal.aborted) return;
    this.snapshot = { phase: "connected", account: this.session.account };
    this.subscription = this.options.host
      .subscribe(
        {
          onOpen: async () => this.recover(),
          onFrame: (frame) => {
            if (frame.type === "thread_message") void this.relay(frame.threadId);
          },
        },
        this.signal,
      )
      .catch((error: unknown) => this.fail(error));
    let failures = 0;
    while (!this.signal.aborted) {
      try {
        const result = await this.call("getupdates", {
          get_updates_buf: this.state.data.updateCursor,
        });
        if (this.signal.aborted) return;
        if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw new WechatApiError(502);
        for (const value of (result.msgs ?? []) as unknown[]) {
          if (this.signal.aborted) return;
          await this.inbound(value);
        }
        if (this.signal.aborted) return;
        // Commit the provider cursor only after every message has reached the durable host.
        if (typeof result.get_updates_buf === "string" && result.get_updates_buf) {
          this.state.data.updateCursor = result.get_updates_buf;
          this.state.save();
        }
        failures = 0;
        this.snapshot = this.retryAt.size
          ? {
              phase: "reconnecting",
              message:
                "A WeChat reply is waiting to retry. Delivery may repeat after an unconfirmed send.",
            }
          : { phase: "connected", account: this.session.account };
        await this.recover();
        await sleep(this.options.pollPauseMs ?? 250, this.signal);
      } catch (error) {
        if (this.signal.aborted) return;
        if (error instanceof WechatApiError && error.revoked) throw error;
        if ((error as { code?: string })?.code === "channel_connection_stale") throw error;
        this.snapshot = {
          phase: "reconnecting",
          message: "WeChat synchronization is retrying. Replies remain queued.",
        };
        await sleep(
          Math.max(
            Math.min((this.options.retryMs ?? 1000) * 2 ** Math.min(failures++, 6), 60_000),
            error instanceof WechatApiError ? error.retryAfterMs : 0,
          ),
          this.signal,
        );
      }
    }
  }
  private async call(path: string, body: JsonObject): Promise<JsonObject> {
    if (!this.session || this.signal.aborted) throw new Error("connection stopped");
    return this.options.api.call(path, {
      signal: this.signal,
      origin: this.session.origin,
      token: this.session.token,
      body,
    });
  }
  private async inbound(value: unknown): Promise<void> {
    const message = privateMessage(value);
    if (!message) return;
    const { host } = this.options;
    if (!(await host.admits?.(message.sender))) return;
    if (message.context) {
      this.state.data.contexts[message.sender] = message.context;
      this.state.save();
    }
    const command = parseApprovalCommand(message.text);
    if (command) {
      try {
        await host.decideApproval({
          id: command.approvalId,
          decision: command.decision,
          senderId: message.sender,
          ...(command.reason ? { reason: command.reason } : {}),
        });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (!["not_found", "forbidden", "invalid_transition", "conflict"].includes(code ?? ""))
          throw error;
        await this.notice(
          message.sender,
          "This approval is unavailable or already decided. Check Approvals in Deskmates.",
        );
      }
      return;
    }
    const result = await host.receive({
      conversationKey: message.sender,
      senderId: message.sender,
      externalId: `${message.sender}:${message.id}`,
      body: message.text,
    });
    if (result.status === "blocked") return;
    if (result.status === "posted" || result.status === "duplicate") {
      const thread = await host.findThread(message.sender);
      if (thread) {
        this.state.cursor(thread.id);
        this.state.save();
        void this.relay(thread.id);
      }
    }
    if (message.media && result.status !== "duplicate")
      await this.notice(
        message.sender,
        "This WeChat connection accepts text only. Images, voice, video and files were not received; please send text.",
      );
  }
  private async notice(peer: string, text: string): Promise<void> {
    if (
      !this.state.data.contexts[peer] ||
      this.signal.aborted ||
      !(await this.options.host.admits?.(peer))
    )
      return;
    try {
      await this.send(peer, text, randomUUID());
    } catch (error) {
      if (error instanceof WechatApiError && error.revoked) throw error;
      this.options.host.log("warn", "WeChat notice was not delivered");
    }
  }
  private async send(peer: string, text: string, id: string): Promise<void> {
    const context = this.state.data.contexts[peer];
    if (!context) throw new Error("reply context unavailable");
    const result = await this.call("sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: peer,
        client_id: id,
        message_type: 2,
        message_state: 2,
        context_token: context,
        item_list: [{ type: 1, text_item: { text } }],
      },
    });
    // iLink acknowledges the client_id with ret:0; it does not return a server message id.
    if (result.ret !== 0) throw new WechatApiError(502);
  }
  private async recover(): Promise<void> {
    const threads = this.options.host.listThreads
      ? await this.options.host.listThreads()
      : Object.keys(this.state.data.threads);
    for (const id of threads) void this.relay(id);
  }
  private relay(threadId: string): Promise<void> {
    if (this.signal.aborted) return Promise.resolve();
    if ((this.retryAt.get(threadId) ?? 0) > Date.now()) return Promise.resolve();
    this.again.add(threadId);
    const running = this.relays.get(threadId);
    if (running) return running;
    const next = Promise.resolve()
      .then(async () => {
        while (this.again.delete(threadId) && !this.signal.aborted) await this.relayPass(threadId);
      })
      .catch((error: unknown) => {
        this.again.delete(threadId);
        if (this.signal.aborted) return;
        if (
          (error instanceof WechatApiError && error.revoked) ||
          (error as { code?: string })?.code === "channel_connection_stale"
        )
          this.fail(error);
        else {
          this.retryAt.set(
            threadId,
            Date.now() +
              Math.max(
                this.options.retryMs ?? 5000,
                error instanceof WechatApiError ? error.retryAfterMs : 0,
              ),
          );
          this.snapshot = {
            phase: "reconnecting",
            message:
              "A WeChat reply is waiting to retry. Delivery may repeat after an unconfirmed send.",
          };
        }
      })
      .finally(() => {
        this.relays.delete(threadId);
        if (this.again.has(threadId)) void this.relay(threadId);
      });
    this.relays.set(threadId, next);
    return next;
  }
  private async relayPass(threadId: string): Promise<void> {
    const { host } = this.options;
    const cursor = this.state.cursor(threadId);
    const peer = await host.conversationKeyOf(threadId);
    for (;;) {
      if (this.signal.aborted) return;
      const messages = await host.listMessages(threadId, cursor.seq);
      if (!messages.length) return;
      for (const message of messages) {
        if (this.signal.aborted) return;
        if (message.seq <= cursor.seq) continue;
        if ((await host.beginSend({ threadId, seq: message.seq })).send) {
          if (!this.state.data.contexts[peer]) return; // Wait for a new inbound context, never send proactively.
          const parts = chunks(render(message));
          let cancelled = false;
          for (let index = cursor.ids.length; index < parts.length; index++) {
            if (this.signal.aborted) return;
            if (!(await host.beginSend({ threadId, seq: message.seq })).send) {
              cancelled = true;
              break;
            }
            const id = randomUUID();
            await this.send(peer, parts[index] as string, id);
            if (this.signal.aborted) return;
            cursor.ids.push(id);
            this.state.save();
          }
          if (!cancelled && cursor.ids.length)
            await host.recordSend({ threadId, seq: message.seq, providerMessageIds: cursor.ids });
        }
        cursor.seq = message.seq;
        cursor.ids = [];
        this.retryAt.delete(threadId);
        this.state.save();
      }
    }
  }
}
