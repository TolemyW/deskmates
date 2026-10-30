// A scripted Discord for T1 tests of the Discord plugin: the Gateway websocket (Hello, heartbeat
// ACKs, Identify, Resume with replay, Reconnect, Invalid Session, close codes) and the REST
// endpoints the plugin calls, all in memory behind a `DiscordTransport`. It follows Discord's
// public documentation; it does not prove what the live service does.

import type { DiscordAttachment, DiscordMessage } from "../discord/rest.js";
import type {
  DiscordSocket,
  DiscordSocketHandlers,
  DiscordTransport,
} from "../discord/transport.js";

export interface FakeDiscordBot {
  token: string;
  userId: string;
  applicationId: string;
  username: string;
  /** False makes `/users/@me` answer a user account, not a bot. */
  bot?: boolean;
}

interface Session {
  id: string;
  bot: FakeDiscordBot;
  seq: number;
  events: { seq: number; t: string; d: unknown }[];
  socket: FakeSocket | undefined;
}

class FakeSocket implements DiscordSocket {
  open = true;
  session: Session | undefined;
  constructor(
    readonly url: string,
    readonly handlers: DiscordSocketHandlers,
    private readonly discord: FakeDiscord,
  ) {}

  send(data: string): void {
    if (!this.open) return;
    this.discord.onClientPayload(this, JSON.parse(data) as { op: number; d?: unknown });
  }

  close(code: number): void {
    if (!this.open) return;
    this.discord.clientCloses.push(code);
    this.detach();
    setTimeout(() => this.handlers.onClose(code, ""), 0);
  }

  /** The server closes the socket. */
  serverClose(code: number): void {
    if (!this.open) return;
    this.detach();
    setTimeout(() => this.handlers.onClose(code, ""), 0);
  }

  deliver(payload: unknown): void {
    if (!this.open) return;
    const text = JSON.stringify(payload);
    setTimeout(() => {
      if (this.open) this.handlers.onMessage(text);
    }, 0);
  }

  private detach(): void {
    this.open = false;
    if (this.session?.socket === this) this.session.socket = undefined;
  }
}

export interface FakeSentMessage {
  token: string;
  channelId: string;
  content: string;
  id: string;
  replyTo?: string;
}

export interface FakeRestFailure {
  status: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Applies only to a send whose content matches; any send when absent. */
  when?: (content: string) => boolean;
}

export class FakeDiscord {
  readonly apiBase = "https://discord.test/api/v10";
  readonly gatewayUrl = "wss://gateway.fake.discord";
  readonly resumeUrl = "wss://resume.fake.discord";
  heartbeatIntervalMs = 40;
  ackHeartbeats = true;
  readonly sent: FakeSentMessage[] = [];
  /** Queued answers for the next `POST /channels/:id/messages`, before any success. */
  readonly sendFailures: FakeRestFailure[] = [];
  readonly connects: string[] = [];
  readonly identifies: { userId: string; intents: unknown }[] = [];
  readonly resumes: { userId: string; ok: boolean }[] = [];
  readonly heartbeats: number[] = [];
  readonly clientCloses: number[] = [];
  /** Every REST and CDN request: URL and the Authorization header, for leak checks. */
  readonly requests: { method: string; url: string; authorization: string | undefined }[] = [];
  readonly transport: DiscordTransport;
  private readonly bots = new Map<string, FakeDiscordBot>();
  private readonly revoked = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private readonly history = new Map<string, DiscordMessage[]>();
  private readonly dmChannels = new Map<string, string>();
  private readonly cdn = new Map<string, { bytes: Uint8Array; type: string }>();
  private readonly sockets: FakeSocket[] = [];
  private nextId = 1_100_000_000_000_000_000n;
  private nextSession = 1;

  constructor() {
    this.transport = {
      apiBase: this.apiBase,
      fetch: (input, init) => this.fetch(String(input), init),
      connect: (url, handlers) => {
        this.connects.push(url);
        const socket = new FakeSocket(url, handlers, this);
        this.sockets.push(socket);
        setTimeout(() => {
          if (!socket.open) return;
          handlers.onOpen();
          socket.deliver({ op: 10, d: { heartbeat_interval: this.heartbeatIntervalMs } });
        }, 0);
        return socket;
      },
    };
  }

  snowflake(): string {
    this.nextId += 1n;
    return this.nextId.toString();
  }

  addBot(bot: FakeDiscordBot): FakeDiscordBot {
    this.bots.set(bot.token, bot);
    return bot;
  }

  /** Reset the token in the developer portal: REST answers 401 and the socket closes 4004. */
  revoke(token: string): void {
    this.revoked.add(token);
    for (const session of this.sessions.values())
      if (session.bot.token === token) session.socket?.serverClose(4004);
  }

  /** The DM channel between a bot and a person, created on first use. */
  dmChannel(bot: FakeDiscordBot, userId: string): string {
    const key = `${bot.userId}:${userId}`;
    let id = this.dmChannels.get(key);
    if (!id) {
      id = this.snowflake();
      this.dmChannels.set(key, id);
    }
    return id;
  }

  /** Host an image (or any file) on the fake CDN; returns its attachment record. */
  upload(filename: string, type: string, bytes: Uint8Array): DiscordAttachment {
    const id = this.snowflake();
    const url = `https://cdn.discordapp.com/attachments/1/${id}/${filename}?ex=signed`;
    this.cdn.set(url, { bytes, type });
    return { id, filename, content_type: type, size: bytes.byteLength, url };
  }

  /** A person sends the bot a message. Dispatched now, or replayed on the next resume. */
  dm(
    bot: FakeDiscordBot,
    input: {
      userId: string;
      username?: string;
      content?: string;
      attachments?: DiscordAttachment[];
      stickers?: number;
      guildId?: string;
      authorBot?: boolean;
      type?: number;
    },
  ): DiscordMessage {
    const channelId = input.guildId ? this.snowflake() : this.dmChannel(bot, input.userId);
    const message: DiscordMessage = {
      id: this.snowflake(),
      channel_id: channelId,
      ...(input.guildId ? { guild_id: input.guildId } : {}),
      author: {
        id: input.userId,
        username: input.username ?? `user${input.userId.slice(-4)}`,
        ...(input.authorBot ? { bot: true } : {}),
      },
      content: input.content ?? "",
      type: input.type ?? 0,
      attachments: input.attachments ?? [],
      ...(input.stickers
        ? {
            sticker_items: Array.from({ length: input.stickers }, (_, n) => ({
              id: String(n + 1),
              name: "sticker",
            })),
          }
        : {}),
    };
    const list = this.history.get(channelId) ?? [];
    list.push(message);
    this.history.set(channelId, list);
    this.dispatch(bot, "MESSAGE_CREATE", message);
    return message;
  }

  /** Close the bot's current socket from the server side (1006: abnormal, resumable). */
  drop(bot: FakeDiscordBot, code = 1006): void {
    this.current(bot)?.serverClose(code);
  }

  /** Opcode 7: Discord asks the client to reconnect and resume. */
  requestReconnect(bot: FakeDiscordBot): void {
    this.current(bot)?.deliver({ op: 7, d: null });
  }

  /**
   * Forget every session of the bot, as when Discord's resume window has passed; a socket still
   * open is dropped (1006), so the client's next resume is refused.
   */
  expireSessions(bot: FakeDiscordBot): void {
    for (const [id, session] of this.sessions) {
      if (session.bot.token !== bot.token) continue;
      this.sessions.delete(id);
      session.socket?.serverClose(1006);
    }
  }

  /** Open sockets of the bot. */
  openSockets(bot: FakeDiscordBot): number {
    return this.sockets.filter((s) => s.open && s.session?.bot.token === bot.token).length;
  }

  private current(bot: FakeDiscordBot): FakeSocket | undefined {
    for (const session of this.sessions.values())
      if (session.bot.token === bot.token && session.socket) return session.socket;
    return undefined;
  }

  private dispatch(bot: FakeDiscordBot, t: string, d: unknown): void {
    for (const session of this.sessions.values()) {
      if (session.bot.token !== bot.token) continue;
      session.seq += 1;
      session.events.push({ seq: session.seq, t, d });
      session.socket?.deliver({ op: 0, s: session.seq, t, d });
    }
  }

  onClientPayload(socket: FakeSocket, payload: { op: number; d?: unknown }): void {
    if (payload.op === 1) {
      this.heartbeats.push(Number(payload.d ?? 0));
      if (this.ackHeartbeats) socket.deliver({ op: 11 });
      return;
    }
    if (payload.op === 2) {
      const d = payload.d as { token?: string; intents?: unknown };
      const bot = this.bots.get(d.token ?? "");
      if (!bot || this.revoked.has(bot.token)) {
        socket.serverClose(4004);
        return;
      }
      this.identifies.push({ userId: bot.userId, intents: d.intents });
      const session: Session = {
        id: `session-${this.nextSession++}`,
        bot,
        seq: 1,
        events: [],
        socket,
      };
      this.sessions.set(session.id, session);
      socket.session = session;
      socket.deliver({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          v: 10,
          session_id: session.id,
          resume_gateway_url: this.resumeUrl,
          user: { id: bot.userId, username: bot.username, bot: true },
          application: { id: bot.applicationId },
        },
      });
      return;
    }
    if (payload.op === 6) {
      const d = payload.d as { token?: string; session_id?: string; seq?: number | null };
      const session = this.sessions.get(d.session_id ?? "");
      if (!session || session.bot.token !== d.token || this.revoked.has(session.bot.token)) {
        const bot = this.bots.get(d.token ?? "");
        this.resumes.push({ userId: bot?.userId ?? "", ok: false });
        socket.deliver({ op: 9, d: false });
        return;
      }
      this.resumes.push({ userId: session.bot.userId, ok: true });
      session.socket?.serverClose(4000);
      session.socket = socket;
      socket.session = session;
      for (const event of session.events)
        if (event.seq > (d.seq ?? 0))
          socket.deliver({ op: 0, s: event.seq, t: event.t, d: event.d });
      session.seq += 1;
      socket.deliver({ op: 0, s: session.seq, t: "RESUMED", d: {} });
    }
  }

  private botFor(init: RequestInit | undefined): FakeDiscordBot | undefined {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.startsWith("Bot ") ? auth.slice(4) : "";
    const bot = this.bots.get(token);
    return bot && !this.revoked.has(token) ? bot : undefined;
  }

  private async fetch(url: string, init: RequestInit | undefined): Promise<Response> {
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    this.requests.push({ method, url, authorization });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    if (url.startsWith("https://cdn.discordapp.com/")) {
      const file = this.cdn.get(url);
      if (!file) return new Response("missing", { status: 404 });
      return new Response(file.bytes, {
        status: 200,
        headers: { "content-type": file.type, "content-length": String(file.bytes.byteLength) },
      });
    }
    if (!url.startsWith(this.apiBase)) return new Response("unknown host", { status: 599 });
    const path = url.slice(this.apiBase.length);
    const bot = this.botFor(init);
    if (!bot) return json(401, { message: "401: Unauthorized", code: 0 });
    if (method === "GET" && path === "/users/@me")
      return json(200, {
        id: bot.userId,
        username: bot.username,
        discriminator: "0",
        ...(bot.bot === false ? {} : { bot: true }),
      });
    if (method === "GET" && path === "/applications/@me")
      return json(200, { id: bot.applicationId, name: bot.username, bot: { id: bot.userId } });
    if (method === "GET" && path === "/gateway/bot")
      return json(200, { url: this.gatewayUrl, shards: 1 });
    const messages = /^\/channels\/(\d+)\/messages(?:\?(.*))?$/.exec(path);
    if (messages && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content?: string;
        message_reference?: { message_id?: string };
      };
      const content = body.content ?? "";
      const index = this.sendFailures.findIndex((f) => !f.when || f.when(content));
      if (index >= 0) {
        const [failure] = this.sendFailures.splice(index, 1);
        return json(failure?.status ?? 500, failure?.body ?? {}, failure?.headers);
      }
      if (content.length === 0 || content.length > 2000)
        return json(400, { message: "Invalid Form Body", code: 50035 });
      const id = this.snowflake();
      this.sent.push({
        token: bot.token,
        channelId: messages[1] ?? "",
        content,
        id,
        ...(body.message_reference?.message_id
          ? { replyTo: body.message_reference.message_id }
          : {}),
      });
      return json(200, { id, channel_id: messages[1], content });
    }
    if (messages && method === "GET") {
      const params = new URLSearchParams(messages[2] ?? "");
      const after = BigInt(params.get("after") ?? "0");
      const list = (this.history.get(messages[1] ?? "") ?? [])
        .filter((m) => BigInt(m.id) > after)
        .reverse();
      return json(200, list);
    }
    return json(404, { message: "Unknown route", code: 0 });
  }
}
