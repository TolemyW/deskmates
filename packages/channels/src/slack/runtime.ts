// The Slack plugin runtime (ChannelPlugin ABI 2, ADR-0047): `verify` asks Slack who the tokens
// belong to, `open` and `close` start and stop one `SlackConnection` per connection id. Identity
// is `slack:<team id, or enterprise id for an org-wide install>:<app id>`, from `auth.test` and
// `bots.info` on the bot token, never from what the operator typed: the same app installed in
// another Slack workspace is another identity, and the same installation connected twice is
// refused by the Gateway (`channel_identity_in_use`). Both tokens are secret fields, so the
// Gateway keeps them in its Secret Store and hands them over only in `verify` and `open`.

import type {
  ChannelConnectionHost,
  ChannelConnectionStatus,
  ChannelIdentity,
  ChannelOpenRequest,
  ChannelPluginRuntimeV2,
  ChannelVerifyRequest,
  ChannelWebhookRequest,
  ChannelWebhookResponse,
} from "@deskmates/contracts";
import {
  SLACK_TIMINGS_DEFAULT,
  SlackConnection,
  type SlackCredentials,
  type SlackIdentityFacts,
  type SlackTimings,
} from "./connection.js";
import { SlackStateStore } from "./state.js";
import { type SlackTransport, createFetchTransport } from "./transport.js";
import { SlackWebApi } from "./web-api.js";

export const SLACK_METHOD_ID = "socket-mode";

export interface SlackRuntimeOptions {
  transport?: SlackTransport;
  timings?: Partial<SlackTimings>;
  /** Sleep between Web API retries; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts after the first on 429, 5xx or a network failure. */
  apiRetries?: number;
}

const SLACK_ID = /^[A-Za-z0-9]{1,64}$/;

function readCredentials(secrets: Readonly<Record<string, string>>): SlackCredentials {
  const botToken = (secrets.botToken ?? "").trim();
  const appToken = (secrets.appToken ?? "").trim();
  if (!botToken.startsWith("xoxb-"))
    throw new Error("The bot token must be a Slack bot token (it starts with xoxb-).");
  if (!appToken.startsWith("xapp-"))
    throw new Error("The app-level token must be a Slack app-level token (it starts with xapp-).");
  return { botToken, appToken };
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export class SlackRuntime implements ChannelPluginRuntimeV2 {
  private readonly transport: SlackTransport;
  private readonly api: SlackWebApi;
  private readonly timings: SlackTimings;
  private readonly connections = new Map<string, SlackConnection>();

  constructor(options: SlackRuntimeOptions = {}) {
    this.transport = options.transport ?? createFetchTransport();
    this.api = new SlackWebApi({
      transport: this.transport,
      ...(options.apiRetries !== undefined ? { retries: options.apiRetries } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    this.timings = { ...SLACK_TIMINGS_DEFAULT, ...(options.timings ?? {}) };
  }

  /** Who the bot token belongs to. Throws `SlackApiError` when Slack refuses it. */
  async identify(credentials: SlackCredentials): Promise<SlackIdentityFacts> {
    const auth = await this.api.call("auth.test", credentials.botToken);
    const botId = text(auth.bot_id);
    const botUserId = text(auth.user_id);
    if (!botId || !botUserId) throw new Error("The bot token does not belong to a Slack app bot.");
    const enterpriseInstall = auth.is_enterprise_install === true;
    const namespace = enterpriseInstall ? text(auth.enterprise_id) : text(auth.team_id);
    const info = await this.api.call("bots.info", credentials.botToken, { bot: botId });
    const bot =
      info.bot && typeof info.bot === "object" ? (info.bot as Record<string, unknown>) : {};
    const appId = text(bot.app_id);
    if (!SLACK_ID.test(namespace) || !SLACK_ID.test(appId))
      throw new Error("Slack did not name the app's workspace and app id.");
    const botName = text(auth.user) || text(bot.name) || "Slack app";
    const teamName = text(auth.team);
    return {
      namespace,
      enterpriseInstall,
      appId,
      botUserId,
      label: teamName ? `${botName} in ${teamName}` : botName,
    };
  }

  async verify(request: ChannelVerifyRequest): Promise<ChannelIdentity> {
    if (request.method !== SLACK_METHOD_ID) throw new Error("unknown Slack connection method");
    const credentials = readCredentials(request.secrets);
    const identity = await this.identify(credentials);
    // The app-level token must open Socket Mode; the one-time URL is discarded unused. Whether it
    // belongs to the same app is checked against the socket's `hello` when the connection opens.
    await this.api.call("apps.connections.open", credentials.appToken);
    return { identityKey: `slack:${identity.namespace}:${identity.appId}`, label: identity.label };
  }

  async open(
    request: ChannelOpenRequest,
    host: ChannelConnectionHost,
  ): Promise<ChannelConnectionStatus> {
    await this.connections.get(request.connectionId)?.close();
    this.connections.delete(request.connectionId);
    if (request.method !== SLACK_METHOD_ID) throw new Error("unknown Slack connection method");
    const credentials = readCredentials(request.secrets);
    const connection = new SlackConnection({
      request,
      host,
      credentials,
      api: this.api,
      transport: this.transport,
      state: new SlackStateStore(request.stateDirectory, {
        bindingGeneration: request.bindingGeneration,
        credentialGeneration: request.credentialGeneration,
      }),
      identify: (supplied) => this.identify(supplied),
      timings: this.timings,
    });
    this.connections.set(request.connectionId, connection);
    return connection.status();
  }

  async close(connectionId: string, reason: Parameters<ChannelPluginRuntimeV2["close"]>[1]) {
    const connection = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    await connection?.close();
    // Slack has no session to log out of; uninstalling the app or rotating its tokens in Slack
    // revokes them. The Gateway deletes the secret records and the state directory.
    if (reason === "disconnect") connection?.removeState();
  }

  async status(connectionId: string): Promise<ChannelConnectionStatus> {
    return this.connections.get(connectionId)?.status() ?? { phase: "stopped" };
  }

  async test(): Promise<ChannelConnectionStatus> {
    throw new Error("Slack connections have no test message: proactive sends are not verified.");
  }

  async webhook(_request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
    return { status: 404, body: "Slack connections use Socket Mode, not webhooks" };
  }

  async stop(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(all.map((connection) => connection.close()));
  }

  /** Test hook: the live connection object of an id. */
  connection(connectionId: string): SlackConnection | undefined {
    return this.connections.get(connectionId);
  }
}
