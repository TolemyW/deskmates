// All network I/O of the Discord plugin goes through this one seam, so T1 tests run the whole
// plugin against a scripted Discord Gateway and REST API in memory. The default uses Node 22's
// global `fetch` and `WebSocket`; no third-party package is involved (ADR-0047 decision 15).
// Neither global honours `HTTPS_PROXY` in Node 22: a Gateway host that needs a proxy to reach
// Discord is not supported by this version.

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_DEFAULT = "wss://gateway.discord.gg";
/** Hosts an inbound attachment may be downloaded from. */
export const DISCORD_CDN_HOSTS: readonly string[] = ["cdn.discordapp.com", "media.discordapp.net"];

export interface DiscordSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
  onError(error: unknown): void;
}

export interface DiscordSocket {
  send(data: string): void;
  close(code: number, reason?: string): void;
}

export interface DiscordTransport {
  /** REST base, `https://discord.com/api/v10` outside tests. */
  apiBase: string;
  fetch: typeof fetch;
  /** Open a websocket to `url`; events arrive through `handlers`. */
  connect(url: string, handlers: DiscordSocketHandlers): DiscordSocket;
}

function messageText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return undefined;
}

/** The real transport: global `fetch` and `WebSocket`. */
export function defaultDiscordTransport(): DiscordTransport {
  return {
    apiBase: DISCORD_API_BASE,
    fetch: (input, init) => fetch(input, init),
    connect(url, handlers) {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => handlers.onOpen());
      socket.addEventListener("message", (event) => {
        const text = messageText(event.data);
        if (text !== undefined) handlers.onMessage(text);
      });
      socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
      socket.addEventListener("error", (event) => handlers.onError(event));
      return {
        send: (data) => socket.send(data),
        close: (code, reason) => {
          try {
            socket.close(code, reason);
          } catch {
            // Already closing or closed.
          }
        },
      };
    },
  };
}
