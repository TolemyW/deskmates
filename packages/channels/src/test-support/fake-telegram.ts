// A scripted Telegram Bot API for T1 tests of the Telegram plugin: a `fetch`-shaped transport that
// answers `getMe`, `getUpdates` (long polling: it waits until an update is queued or the request
// is aborted), `sendMessage`, `getFile` and file downloads for several bots at once. It models
// only what the plugin relies on and is no evidence of live Telegram behaviour.

import type { TelegramMessage, TelegramUpdate } from "../telegram/bot-api.js";

export interface FakeTelegramBot {
  token: string;
  id: number;
  username: string;
}

export interface FakeTelegramSend {
  botId: number;
  chatId: string;
  text: string;
  messageId: number;
}

interface BotState extends FakeTelegramBot {
  revoked: boolean;
  webhook: boolean;
  /** Queued updates not yet confirmed by an offset. */
  queue: TelegramUpdate[];
  nextUpdateId: number;
  nextMessageId: number;
  waiters: Set<() => void>;
}

export interface FakeTelegramFailure {
  error_code: number;
  description: string;
  retry_after?: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ok = (result: unknown) => json(200, { ok: true, result });
const fail = (failure: FakeTelegramFailure) =>
  json(failure.error_code, {
    ok: false,
    error_code: failure.error_code,
    description: failure.description,
    ...(failure.retry_after !== undefined
      ? { parameters: { retry_after: failure.retry_after } }
      : {}),
  });

export class FakeTelegram {
  readonly sends: FakeTelegramSend[] = [];
  readonly menus = new Map<string, unknown>();
  menuButton = "web_app";
  failMenu = false;
  /** Every method call: which bot, which method, its parameters. */
  readonly calls: { botId: number | undefined; method: string; params: Record<string, unknown> }[] =
    [];
  /** Failures the next `sendMessage` calls answer with, in order. */
  readonly sendFailures: FakeTelegramFailure[] = [];
  /** Failures the next `getUpdates` calls answer with, in order. */
  readonly pollFailures: FakeTelegramFailure[] = [];
  private readonly bots = new Map<string, BotState>();
  private readonly files = new Map<string, { path: string; bytes: Uint8Array; size?: number }>();
  private nextFile = 1;

  readonly transport = (url: string, init: RequestInit): Promise<Response> =>
    this.handle(url, init);

  addBot(bot: FakeTelegramBot): void {
    this.bots.set(bot.token, {
      ...bot,
      revoked: false,
      webhook: false,
      queue: [],
      nextUpdateId: 1000,
      nextMessageId: 1,
      waiters: new Set(),
    });
  }

  revoke(token: string): void {
    const bot = this.mustBot(token);
    bot.revoked = true;
    this.wake(bot);
  }

  setWebhook(token: string, on: boolean): void {
    const bot = this.mustBot(token);
    bot.webhook = on;
    this.wake(bot);
  }

  /** A file a message can point to; returns its `file_id`. */
  addFile(bytes: Uint8Array, options: { size?: number } = {}): string {
    const id = `file-${this.nextFile++}`;
    this.files.set(id, {
      path: `photos/${id}.bin`,
      bytes,
      ...(options.size !== undefined ? { size: options.size } : {}),
    });
    return id;
  }

  /** Queue an update for `token`'s bot; returns its update id. */
  push(token: string, message: Omit<TelegramMessage, "message_id"> & { message_id?: number }) {
    const bot = this.mustBot(token);
    const update: TelegramUpdate = {
      update_id: bot.nextUpdateId++,
      message: { message_id: bot.nextMessageId++, date: 0, ...message } as TelegramMessage,
    };
    bot.queue.push(update);
    this.wake(bot);
    return update;
  }

  /** A person's private-chat text to `token`'s bot. */
  privateText(token: string, userId: number, text: string, extra: Partial<TelegramMessage> = {}) {
    return this.push(token, {
      from: { id: userId, is_bot: false, first_name: "Person" },
      chat: { id: userId, type: "private" },
      text,
      ...extra,
    });
  }

  /** Updates not yet confirmed by `getUpdates` with a higher offset. */
  pending(token: string): number {
    return this.mustBot(token).queue.length;
  }

  /** Offsets the bot's `getUpdates` calls carried, oldest first. */
  offsets(token: string): (number | undefined)[] {
    const id = this.mustBot(token).id;
    return this.calls
      .filter((call) => call.botId === id && call.method === "getUpdates")
      .map((call) => call.params.offset as number | undefined);
  }

  private mustBot(token: string): BotState {
    const bot = this.bots.get(token);
    if (!bot) throw new Error("unknown fake bot");
    return bot;
  }

  private wake(bot: BotState): void {
    for (const waiter of bot.waiters) waiter();
    bot.waiters.clear();
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(parsed.pathname);
    if (file) {
      const bot = this.bots.get(decodeURIComponent(file[1] ?? ""));
      if (!bot || bot.revoked) return json(401, { ok: false, error_code: 401 });
      const found = [...this.files.values()].find((entry) => entry.path === file[2]);
      if (!found) return json(404, { ok: false, error_code: 404 });
      return new Response(found.bytes, { status: 200 });
    }
    const call = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(parsed.pathname);
    if (!call) return json(404, { ok: false, error_code: 404, description: "Not Found" });
    const bot = this.bots.get(decodeURIComponent(call[1] ?? ""));
    const method = call[2] ?? "";
    const params = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.calls.push({ botId: bot?.id, method, params });
    if (!bot || bot.revoked)
      return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
    switch (method) {
      case "getMyCommands":
        return ok(
          this.menus.get(JSON.stringify([bot.id, params.scope, params.language_code])) ?? [
            { command: "legacy", description: "Old control" },
          ],
        );
      case "setMyCommands":
        if (this.failMenu) return fail({ error_code: 503, description: "menu unavailable" });
        this.menus.set(
          JSON.stringify([bot.id, params.scope, params.language_code]),
          params.commands,
        );
        return ok(true);
      case "getChatMenuButton":
        return ok({ type: this.menuButton });
      case "setChatMenuButton":
        this.menuButton = "commands";
        return ok(true);
      case "getMe":
        return ok({ id: bot.id, is_bot: true, first_name: "Bot", username: bot.username });
      case "getUpdates":
        return this.getUpdates(bot, params, init.signal ?? undefined);
      case "sendMessage": {
        const failure = this.sendFailures.shift();
        if (failure) return fail(failure);
        const text = String(params.text ?? "");
        if (text.length === 0 || text.length > 4096)
          return fail({ error_code: 400, description: "Bad Request: message text is invalid" });
        const messageId = bot.nextMessageId++;
        this.sends.push({ botId: bot.id, chatId: String(params.chat_id), text, messageId });
        return ok({ message_id: messageId, chat: { id: Number(params.chat_id), type: "private" } });
      }
      case "getFile": {
        const entry = this.files.get(String(params.file_id));
        if (!entry) return fail({ error_code: 400, description: "Bad Request: invalid file_id" });
        return ok({
          file_id: params.file_id,
          file_path: entry.path,
          file_size: entry.size ?? entry.bytes.byteLength,
        });
      }
      default:
        return fail({ error_code: 404, description: "Not Found: method not found" });
    }
  }

  private async getUpdates(
    bot: BotState,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const failure = this.pollFailures.shift();
    if (failure) return fail(failure);
    if (bot.webhook)
      return fail({
        error_code: 409,
        description: "Conflict: can't use getUpdates method while webhook is active",
      });
    const offset = typeof params.offset === "number" ? params.offset : 0;
    bot.queue = bot.queue.filter((update) => update.update_id >= offset);
    if (bot.queue.length === 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        const wake = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          bot.waiters.delete(wake);
          reject(new DOMException("aborted", "AbortError"));
        };
        bot.waiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
      if (bot.revoked)
        return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
      if (bot.webhook) return fail({ error_code: 409, description: "Conflict" });
    }
    const limit = typeof params.limit === "number" ? params.limit : 100;
    return ok(bot.queue.slice(0, limit));
  }
}
