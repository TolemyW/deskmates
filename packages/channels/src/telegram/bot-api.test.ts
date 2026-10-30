// T0: the Bot API client keeps the token out of every error and refuses a token that could change
// the request path.

import { describe, expect, it } from "vitest";
import { TelegramApiError, TelegramBotApi, isTelegramBotToken, redactToken } from "./bot-api.js";

const TOKEN = "123:AAfake-token-never-public-000000001";

describe("Telegram Bot API client", () => {
  it("accepts only BotFather-shaped tokens", () => {
    expect(isTelegramBotToken(TOKEN)).toBe(true);
    for (const bad of [
      "",
      "123",
      "abc:AAAAAAAAAAAAAAAAAAAAAAAA",
      "1:short",
      "1:AAAAAAAAAAAAAAAAAAAAAA/../x",
    ])
      expect(isTelegramBotToken(bad), bad).toBe(false);
    expect(
      () => new TelegramBotApi({ token: "1:../../x", transport: async () => new Response() }),
    ).toThrow(TelegramApiError);
  });

  it("scrubs the token from transport failures and API descriptions", async () => {
    const failing = new TelegramBotApi({
      token: TOKEN,
      transport: async (url) => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    const network = (await failing.getMe().then(
      () => undefined,
      (e: unknown) => e,
    )) as TelegramApiError;
    expect(network).toBeInstanceOf(TelegramApiError);
    expect(network.status).toBe(0);
    expect(network.retryable).toBe(true);
    expect(network.message).not.toContain("AAfake");

    const refusing = new TelegramBotApi({
      token: TOKEN,
      transport: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: `slow down ${TOKEN}`,
            parameters: { retry_after: 3 },
          }),
          { status: 429 },
        ),
    });
    const limited = (await refusing.getMe().then(
      () => undefined,
      (e: unknown) => e,
    )) as TelegramApiError;
    expect(limited).toMatchObject({ status: 429, retryAfterSeconds: 3, retryable: true });
    expect(limited.message).not.toContain("AAfake");
    expect(redactToken(`a ${TOKEN} b`, TOKEN)).toBe("a <redacted> b");
  });

  it("classifies revoked, conflicting and permanent refusals", () => {
    expect(new TelegramApiError("getUpdates", 401, "Unauthorized", undefined).revoked).toBe(true);
    expect(new TelegramApiError("getUpdates", 409, "Conflict", undefined).conflict).toBe(true);
    const forbidden = new TelegramApiError("sendMessage", 403, "Forbidden", undefined);
    expect([forbidden.revoked, forbidden.retryable]).toEqual([false, false]);
  });
});
