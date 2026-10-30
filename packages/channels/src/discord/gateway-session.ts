// One Discord Gateway session (API v10, JSON encoding): Hello, heartbeats with zombie detection,
// Identify or Resume, dispatches, and reconnect with exponential backoff and jitter. A session
// that can be resumed is resumed (Discord then replays the events missed while disconnected); the
// session id, resume URL and sequence number are handed to `onResumeState` so the plugin can keep
// them across a Gateway restart. Read from Discord's public Gateway documentation; not verified
// against the live service.

import type { DiscordSocket, DiscordTransport } from "./transport.js";

/** Intents: DIRECT_MESSAGES only. Message content of DMs reaches a bot without MESSAGE_CONTENT. */
export const DISCORD_INTENT_DIRECT_MESSAGES = 1 << 12;
export const DISCORD_INTENTS = DISCORD_INTENT_DIRECT_MESSAGES;

/** Close codes after which reconnecting cannot help. 4004: the token was refused. */
const FATAL_CLOSE: Readonly<Record<number, "revoked" | "failed">> = {
  4004: "revoked",
  4010: "failed",
  4011: "failed",
  4012: "failed",
  4013: "failed",
  4014: "failed",
};
/** Close codes after which the session cannot be resumed: identify again. */
const NEW_SESSION_CLOSE = new Set([4007, 4009]);
/** The code this client closes with when it wants to resume afterwards (not 1000/1001). */
export const RESUMABLE_CLOSE = 4000;

export interface DiscordResumeState {
  sessionId: string;
  resumeUrl: string;
  seq: number | null;
}

export interface DiscordReady {
  resumed: boolean;
  userId?: string;
  applicationId?: string;
  username?: string;
}

export interface DiscordGatewayOptions {
  transport: DiscordTransport;
  token: string;
  /** The URL to identify against (`GET /gateway/bot`). */
  resolveUrl(): Promise<string>;
  resume?: DiscordResumeState;
  onReady(ready: DiscordReady): void;
  onDispatch(type: string, data: unknown): void;
  /** The resume state changed (new session, new sequence, or cleared). */
  onResumeState(state: DiscordResumeState | undefined): void;
  /** Reconnecting after a drop; `onReady` follows when it succeeds. */
  onReconnecting(attempt: number): void;
  /** The session cannot continue: `revoked` for a refused token, `failed` otherwise. */
  onFatal(kind: "revoked" | "failed", message: string): void;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
  backoff?: { initialMs: number; maxMs: number };
  /** Wait after an Invalid Session before identifying again; Discord asks for 1 to 5 s. */
  invalidSessionDelayMs?: () => number;
  /** Close the socket when no Hello arrives within this time. */
  helloTimeoutMs?: number;
  random?: () => number;
}

interface Payload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

function withQuery(url: string): string {
  const base = url.replace(/\/+$/, "");
  return `${base}/?v=10&encoding=json`;
}

export class DiscordGatewaySession {
  /** Times this session identified, resumed and reconnected; for status details and tests. */
  readonly counters = { identifies: 0, resumes: 0, reconnects: 0, zombies: 0 };
  private resume: DiscordResumeState | undefined;
  private socket: DiscordSocket | undefined;
  private socketId = 0;
  private stopped = false;
  private attempt = 0;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private acked = true;

  constructor(private readonly options: DiscordGatewayOptions) {
    this.resume = options.resume;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  /**
   * Stop for good. `resumable` closes with 4000 so Discord keeps the session for a later resume
   * (restart, reconnect); otherwise 1000, which ends the session (disconnect, relink).
   */
  stop(resumable: boolean): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.socketId += 1;
    socket?.close(resumable ? RESUMABLE_CLOSE : 1000, "closing");
    if (!resumable) this.setResume(undefined);
  }

  private random(): number {
    return (this.options.random ?? Math.random)();
  }

  private clearTimers(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined;
    this.helloTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private setResume(state: DiscordResumeState | undefined): void {
    this.resume = state;
    this.options.onResumeState(state);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    if (this.resume) url = this.resume.resumeUrl;
    else {
      try {
        url = await this.options.resolveUrl();
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 401) {
          this.options.onFatal("revoked", "Discord refused the bot token.");
          this.stopped = true;
          return;
        }
        this.options.log("warn", "discord gateway URL lookup failed; retrying");
        this.scheduleReconnect();
        return;
      }
    }
    if (this.stopped) return;
    const id = ++this.socketId;
    const mine = (): boolean => id === this.socketId && !this.stopped;
    try {
      this.socket = this.options.transport.connect(withQuery(url), {
        onOpen: () => {},
        onMessage: (data) => {
          if (mine()) this.onPayload(data);
        },
        onClose: (code) => {
          if (mine()) this.onClose(code);
        },
        onError: () => {
          // A close event follows.
        },
      });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.helloTimer = setTimeout(() => {
      if (!mine()) return;
      this.options.log("warn", "discord gateway sent no hello; reconnecting");
      this.dropSocket();
      this.scheduleReconnect();
    }, this.options.helloTimeoutMs ?? 30_000);
  }

  private send(payload: Payload): void {
    this.socket?.send(JSON.stringify(payload));
  }

  /** Close the current socket for a resume and ignore its close event. */
  private dropSocket(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.socketId += 1;
    socket?.close(RESUMABLE_CLOSE, "reconnect");
  }

  private onPayload(raw: string): void {
    let payload: Payload;
    try {
      payload = JSON.parse(raw) as Payload;
    } catch {
      return;
    }
    switch (payload.op) {
      case 10: {
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = undefined;
        const interval = Number(
          (payload.d as { heartbeat_interval?: unknown })?.heartbeat_interval,
        );
        this.startHeartbeat(Number.isFinite(interval) && interval > 0 ? interval : 41_250);
        if (this.resume) {
          this.counters.resumes += 1;
          this.send({
            op: 6,
            d: {
              token: this.options.token,
              session_id: this.resume.sessionId,
              seq: this.resume.seq,
            },
          });
        } else {
          this.counters.identifies += 1;
          this.send({
            op: 2,
            d: {
              token: this.options.token,
              intents: DISCORD_INTENTS,
              properties: { os: process.platform, browser: "deskmates", device: "deskmates" },
            },
          });
        }
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.send({ op: 1, d: this.resume?.seq ?? null });
        return;
      case 7:
        // Discord asks for a reconnect: resume at once.
        this.dropSocket();
        this.scheduleReconnect(0);
        return;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable) this.setResume(undefined);
        this.dropSocket();
        this.scheduleReconnect(
          this.options.invalidSessionDelayMs?.() ?? 1_000 + Math.floor(this.random() * 4_000),
        );
        return;
      }
      case 0:
        this.onDispatchPayload(payload);
        return;
      default:
        return;
    }
  }

  private onDispatchPayload(payload: Payload): void {
    const type = payload.t ?? "";
    if (typeof payload.s === "number" && this.resume) {
      this.resume = { ...this.resume, seq: payload.s };
    }
    if (type === "READY") {
      const d = (payload.d ?? {}) as {
        session_id?: unknown;
        resume_gateway_url?: unknown;
        user?: { id?: unknown; username?: unknown };
        application?: { id?: unknown };
      };
      if (typeof d.session_id === "string" && typeof d.resume_gateway_url === "string")
        this.setResume({
          sessionId: d.session_id,
          resumeUrl: d.resume_gateway_url,
          seq: typeof payload.s === "number" ? payload.s : null,
        });
      this.attempt = 0;
      this.options.onReady({
        resumed: false,
        ...(typeof d.user?.id === "string" ? { userId: d.user.id } : {}),
        ...(typeof d.user?.username === "string" ? { username: d.user.username } : {}),
        ...(typeof d.application?.id === "string" ? { applicationId: d.application.id } : {}),
      });
      return;
    }
    if (this.resume && typeof payload.s === "number") this.options.onResumeState(this.resume);
    if (type === "RESUMED") {
      this.attempt = 0;
      this.options.onReady({ resumed: true });
      return;
    }
    this.options.onDispatch(type, payload.d);
  }

  private startHeartbeat(interval: number): void {
    this.acked = true;
    const beat = (): void => {
      if (this.stopped || !this.socket) return;
      if (!this.acked) {
        // No ACK since the last heartbeat: a zombie connection. Resume on a new socket.
        this.counters.zombies += 1;
        this.options.log("warn", "discord heartbeat not acknowledged; reconnecting");
        this.dropSocket();
        this.scheduleReconnect(0);
        return;
      }
      this.acked = false;
      this.send({ op: 1, d: this.resume?.seq ?? null });
      this.heartbeat = setTimeout(beat, interval);
    };
    this.heartbeat = setTimeout(beat, Math.floor(interval * this.random()));
  }

  private onClose(code: number): void {
    this.clearTimers();
    this.socket = undefined;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      this.stopped = true;
      this.setResume(undefined);
      this.options.onFatal(
        fatal,
        fatal === "revoked"
          ? "Discord refused the bot token."
          : `Discord closed the connection with code ${code}.`,
      );
      return;
    }
    if (NEW_SESSION_CLOSE.has(code)) this.setResume(undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(delay?: number): void {
    if (this.stopped) return;
    this.attempt += 1;
    this.counters.reconnects += 1;
    this.options.onReconnecting(this.attempt);
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 1_000, maxMs: 60_000 };
    const base = Math.min(maxMs, initialMs * 2 ** (this.attempt - 1));
    const wait = delay ?? Math.floor(base * (0.5 + this.random() / 2));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, wait);
  }
}
