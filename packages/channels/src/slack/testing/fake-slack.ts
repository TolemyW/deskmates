// A scripted Slack for T1 tests: the Web API methods the plugin calls, file downloads and Socket
// Mode sockets the test drives frame by frame. Nothing here touches a network. It behaves the way
// Slack's documentation describes, which is not proof of how a live workspace behaves.

import type {
  SlackDownload,
  SlackHttpResponse,
  SlackSocket,
  SlackSocketHandlers,
  SlackTransport,
} from "../transport.js";

export interface FakeSlackInstall {
  teamId: string;
  teamName: string;
  appId: string;
  botId: string;
  botUserId: string;
  botName: string;
  enterpriseId?: string;
  enterpriseInstall?: boolean;
}

export interface FakeSlackCall {
  method: string;
  token: string;
  params: Readonly<Record<string, string>>;
}

export interface FakeSlackPost {
  token: string;
  channel: string;
  text: string;
  ts: string;
}

export class FakeSlackSocket implements SlackSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly appId: string,
    private readonly handlers: SlackSocketHandlers,
  ) {}

  /** Envelope ids the plugin acknowledged on this socket. */
  get acks(): string[] {
    return this.sent.map((text) => (JSON.parse(text) as { envelope_id: string }).envelope_id);
  }

  send(text: string): void {
    if (!this.closed) this.sent.push(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose(1000);
  }

  /** Slack sends a frame. */
  emit(frame: unknown): void {
    if (!this.closed) this.handlers.onMessage(JSON.stringify(frame));
  }

  /** Slack drops the connection without a `disconnect` frame. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose(1006);
  }

  hello(appId = this.appId): void {
    this.emit({ type: "hello", num_connections: 1, connection_info: { app_id: appId } });
  }
}

/** A Socket Mode envelope carrying one `message` event. */
export function messageEnvelope(input: {
  envelopeId: string;
  eventId: string;
  install: FakeSlackInstall;
  channel?: string;
  channelType?: "im" | "channel" | "group" | "mpim";
  user: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
  files?: unknown[];
  retryAttempt?: number;
}): Record<string, unknown> {
  const ts = input.ts ?? "1700000000.000100";
  return {
    type: "events_api",
    envelope_id: input.envelopeId,
    accepts_response_payload: false,
    retry_attempt: input.retryAttempt ?? 0,
    payload: {
      type: "event_callback",
      team_id: input.install.teamId,
      ...(input.install.enterpriseId ? { enterprise_id: input.install.enterpriseId } : {}),
      api_app_id: input.install.appId,
      event_id: input.eventId,
      event_time: 1700000000,
      event: {
        type: "message",
        channel: input.channel ?? "D0PERSON1",
        channel_type: input.channelType ?? "im",
        user: input.user,
        text: input.text ?? "",
        ts,
        event_ts: ts,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        ...(input.subtype ? { subtype: input.subtype } : {}),
        ...(input.botId ? { bot_id: input.botId } : {}),
        ...(input.files ? { files: input.files } : {}),
      },
    },
  };
}

/** A Socket Mode envelope for `app_uninstalled` or `tokens_revoked`. */
export function revocationEnvelope(input: {
  envelopeId: string;
  eventId: string;
  install: FakeSlackInstall;
  type: "app_uninstalled" | "tokens_revoked";
}): Record<string, unknown> {
  return {
    type: "events_api",
    envelope_id: input.envelopeId,
    payload: {
      type: "event_callback",
      team_id: input.install.teamId,
      api_app_id: input.install.appId,
      event_id: input.eventId,
      event:
        input.type === "app_uninstalled"
          ? { type: "app_uninstalled" }
          : { type: "tokens_revoked", tokens: { bot: [input.install.botUserId] } },
    },
  };
}

type Scripted = Partial<SlackHttpResponse> & { throws?: boolean };

export class FakeSlack implements SlackTransport {
  readonly calls: FakeSlackCall[] = [];
  readonly posts: FakeSlackPost[] = [];
  readonly sockets: FakeSlackSocket[] = [];
  readonly downloads: { url: string; token: string }[] = [];
  /** Send `hello` as soon as a socket opens. */
  autoHello = true;
  private readonly bots = new Map<string, FakeSlackInstall>();
  private readonly apps = new Map<string, string>();
  private readonly files = new Map<string, SlackDownload>();
  private readonly scripted = new Map<string, Scripted[]>();
  private nextTs = 1;
  private nextTicket = 1;

  /** `botToken` is a bot token of `install`; `appToken` an app-level token of `appTokenApp`. */
  install(
    botToken: string,
    appToken: string,
    install: FakeSlackInstall,
    appTokenApp = install.appId,
  ) {
    this.bots.set(botToken, install);
    this.apps.set(appToken, appTokenApp);
  }

  revoke(token: string): void {
    this.bots.delete(token);
    this.apps.delete(token);
  }

  addFile(url: string, file: SlackDownload): void {
    this.files.set(url, file);
  }

  /** The next calls of `method` answer these, in order, before the normal behaviour resumes. */
  script(method: string, ...responses: Scripted[]): void {
    this.scripted.set(method, [...(this.scripted.get(method) ?? []), ...responses]);
  }

  get lastSocket(): FakeSlackSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("no socket was opened");
    return socket;
  }

  async call(
    method: string,
    token: string,
    params: Readonly<Record<string, string>>,
  ): Promise<SlackHttpResponse> {
    this.calls.push({ method, token, params });
    const queued = this.scripted.get(method);
    const next = queued?.shift();
    if (next) {
      if (next.throws) throw new Error("network down");
      return {
        status: next.status ?? 200,
        body: next.body,
        ...(next.retryAfterSeconds ? { retryAfterSeconds: next.retryAfterSeconds } : {}),
      };
    }
    const fail = (error: string) => ({ status: 200, body: { ok: false, error } });
    if (method === "apps.connections.open") {
      const appId = this.apps.get(token);
      if (!appId) return fail("invalid_auth");
      const ticket = this.nextTicket++;
      return {
        status: 200,
        body: { ok: true, url: `wss://wss.fake-slack.test/link/?ticket=t${ticket}&app=${appId}` },
      };
    }
    const install = this.bots.get(token);
    if (!install) return fail("invalid_auth");
    if (method === "auth.test")
      return {
        status: 200,
        body: {
          ok: true,
          url: "https://fake.slack.test/",
          team: install.teamName,
          user: install.botName,
          team_id: install.teamId,
          user_id: install.botUserId,
          bot_id: install.botId,
          is_enterprise_install: install.enterpriseInstall === true,
          ...(install.enterpriseId ? { enterprise_id: install.enterpriseId } : {}),
        },
      };
    if (method === "bots.info")
      return params.bot === install.botId
        ? {
            status: 200,
            body: {
              ok: true,
              bot: {
                id: install.botId,
                app_id: install.appId,
                name: install.botName,
                user_id: install.botUserId,
              },
            },
          }
        : fail("bot_not_found");
    if (method === "chat.postMessage") {
      const ts = `1700000100.${String(this.nextTs++).padStart(6, "0")}`;
      this.posts.push({ token, channel: params.channel ?? "", text: params.text ?? "", ts });
      return { status: 200, body: { ok: true, channel: params.channel, ts } };
    }
    return fail("unknown_method");
  }

  async download(url: string, token: string, maxBytes: number): Promise<SlackDownload> {
    this.downloads.push({ url, token });
    const file = this.files.get(url);
    if (!file || !this.bots.has(token))
      // What Slack does for an unauthorised file request: a sign-in page.
      return { status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<html>") };
    if (file.bytes && file.bytes.byteLength > maxBytes) return { ...file, bytes: undefined };
    return file;
  }

  openSocket(url: string, handlers: SlackSocketHandlers): SlackSocket {
    const appId = new URL(url).searchParams.get("app") ?? "";
    const socket = new FakeSlackSocket(url, appId, handlers);
    this.sockets.push(socket);
    queueMicrotask(() => {
      handlers.onOpen();
      if (this.autoHello) socket.hello();
    });
    return socket;
  }
}
