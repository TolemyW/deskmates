// The Discord plugin's ABI-2 runtime (ADR-0047): verify a bot token against Discord's own identity
// endpoints, and run one `DiscordConnection` per open connection. Connections never share a
// token, a socket, state or a host, so two bots in one workspace stay apart.

import {
  type ChannelCloseReason,
  type ChannelConnectionHost,
  type ChannelConnectionStatus,
  type ChannelIdentity,
  type ChannelOpenRequest,
  type ChannelPluginContextV2,
  type ChannelPluginRuntimeV2,
  type ChannelVerifyRequest,
  type ChannelWebhookRequest,
  type ChannelWebhookResponse,
  DeskmatesError,
} from "@deskmates/contracts";
import { DISCORD_TIMINGS_DEFAULT, DiscordConnection, type DiscordTimings } from "./connection.js";
import { DISCORD_METHOD_BOT_TOKEN, DISCORD_PLUGIN_ID } from "./manifest.js";
import { DiscordHttpError, DiscordRest, normalizeDiscordToken } from "./rest.js";
import { type DiscordTransport, defaultDiscordTransport } from "./transport.js";

export interface DiscordRuntimeOptions {
  transport?: DiscordTransport;
  timings?: Partial<DiscordTimings>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** A Discord snowflake: a decimal id. */
const SNOWFLAKE = /^\d{1,20}$/;

/** The identity key of a Discord application's bot (ADR-0047 decision 6). */
export function discordIdentityKey(applicationId: string): string {
  return `${DISCORD_PLUGIN_ID}:app:${applicationId}`;
}

export class DiscordRuntime implements ChannelPluginRuntimeV2 {
  private readonly operations = new Map<string, Promise<void>>();
  private stopped = false;

  /** Replacement and close must share one lifecycle order for each connection. */
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.operations.set(id, settled);
    void settled.then(() => {
      if (this.operations.get(id) === settled) this.operations.delete(id);
    });
    return result;
  }

  private readonly connections = new Map<string, DiscordConnection>();
  private readonly transport: DiscordTransport;
  private readonly timings: DiscordTimings;

  constructor(
    private readonly context: ChannelPluginContextV2,
    private readonly options: DiscordRuntimeOptions = {},
  ) {
    this.transport = options.transport ?? defaultDiscordTransport();
    this.timings = { ...DISCORD_TIMINGS_DEFAULT, ...(options.timings ?? {}) };
  }

  async verify(request: ChannelVerifyRequest): Promise<ChannelIdentity> {
    if (request.method !== DISCORD_METHOD_BOT_TOKEN)
      throw new Error("Unknown Discord connection method.");
    const token = normalizeDiscordToken(request.secrets.token);
    const rest = new DiscordRest({
      transport: this.transport,
      token,
      retries: 1,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    });
    let user: Awaited<ReturnType<DiscordRest["currentUser"]>>;
    let application: Awaited<ReturnType<DiscordRest["currentApplication"]>>;
    try {
      user = await rest.currentUser();
      application = await rest.currentApplication();
    } catch (error) {
      // The message carries the status, never the token.
      throw new Error(
        error instanceof DiscordHttpError && error.status === 401
          ? "Discord refused the bot token."
          : "Discord could not be asked who the token belongs to.",
      );
    }
    if (!user?.bot || typeof user.id !== "string" || !SNOWFLAKE.test(user.id))
      throw new Error("The token is not a Discord bot token.");
    if (typeof application?.id !== "string" || !SNOWFLAKE.test(application.id))
      throw new Error("Discord returned no application for the token.");
    if (application.bot?.id !== undefined && application.bot.id !== user.id)
      throw new Error("Discord's application and bot user do not match.");
    const discriminator =
      user.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : "";
    return {
      identityKey: discordIdentityKey(application.id),
      label: `${user.username}${discriminator}`,
    };
  }

  async open(
    request: ChannelOpenRequest,
    host: ChannelConnectionHost,
  ): Promise<ChannelConnectionStatus> {
    return this.serialize(request.connectionId, async () => {
      if (this.stopped) return { phase: "stopped" };
      return this.openConnection(request, host);
    });
  }

  private async openConnection(
    request: ChannelOpenRequest,
    host: ChannelConnectionHost,
  ): Promise<ChannelConnectionStatus> {
    const previous = this.connections.get(request.connectionId);
    if (previous) await previous.close(true, true);
    normalizeDiscordToken(request.secrets.token);
    const connection = new DiscordConnection({
      request,
      host,
      transport: this.transport,
      timings: this.timings,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    this.connections.set(request.connectionId, connection);
    const status = await connection.open();
    this.context.log("info", "discord connection opened", {
      connectionId: request.connectionId,
      reason: request.reason,
      phase: status.phase,
    });
    return status;
  }

  async close(connectionId: string, reason: ChannelCloseReason): Promise<void> {
    return this.serialize(connectionId, () => this.closeConnection(connectionId, reason));
  }

  private async closeConnection(connectionId: string, reason: ChannelCloseReason): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    // A disconnect ends the Discord session and keeps no state (the Gateway deletes the
    // directory); a relink ends the old credential's session; an archive keeps the state but not
    // the session (a restore may come much later); reconnect and rebind may resume.
    await connection.close(reason === "reconnect" || reason === "rebind", reason !== "disconnect");
  }

  async status(connectionId: string): Promise<ChannelConnectionStatus> {
    return this.connections.get(connectionId)?.status() ?? { phase: "stopped" };
  }

  async test(): Promise<ChannelConnectionStatus> {
    throw new DeskmatesError(
      "invalid_transition",
      "Discord offers no test message in this version.",
    );
  }

  async webhook(_request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
    // Discord reaches this plugin through the Gateway websocket; there is no webhook ingress.
    return { status: 404, body: "not used" };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const ids = new Set([...this.connections.keys(), ...this.operations.keys()]);
    await Promise.all(
      [...ids].map((id) =>
        this.serialize(id, async () => {
          const connection = this.connections.get(id);
          this.connections.delete(id);
          await connection?.close(true, true);
        }),
      ),
    );
  }
}
