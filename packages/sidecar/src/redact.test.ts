import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, redactText, redactValue } from "./redact.js";

describe("redactText (test strategy §4.3: token, cookie, Bearer header, x-api-key)", () => {
  it("scrubs bearer tokens", () => {
    expect(redactText("Authorization: Bearer abcDEF1234567890")).toBe(`Authorization: ${REDACTED}`);
    expect(redactText("got bearer abcDEF1234567890 back")).toBe(`got bearer ${REDACTED} back`);
  });

  it("scrubs sk- keys", () => {
    expect(redactText("key sk-ant-api03-abcdefghijkl end")).toBe(`key ${REDACTED} end`);
  });

  it("scrubs credential environment variables", () => {
    expect(redactText("ANTHROPIC_AUTH_TOKEN=tok_123456 X=1")).toBe(
      `ANTHROPIC_AUTH_TOKEN=${REDACTED} X=1`,
    );
    expect(redactText("ANTHROPIC_API_KEY: whatever")).toBe(`ANTHROPIC_API_KEY=${REDACTED}`);
  });

  it("scrubs cookie and x-api-key headers", () => {
    expect(redactText("Cookie: session=abc; other=def\nnext")).toBe(`Cookie: ${REDACTED}\nnext`);
    expect(redactText("set-cookie: a=b")).toBe(`set-cookie: ${REDACTED}`);
    expect(redactText("x-api-key: zzz")).toBe(`x-api-key: ${REDACTED}`);
  });

  it("scrubs exact known secrets even when they look ordinary", () => {
    expect(redactText("the value is hunter22 ok", ["hunter22"])).toBe(
      `the value is ${REDACTED} ok`,
    );
    expect(redactText("ab", ["ab"])).toBe("ab");
  });
});

describe("redactValue", () => {
  it("walks objects and arrays, and replaces sensitive keys wholesale", () => {
    const input = {
      command: "curl -H 'Authorization: Bearer abcdefgh12345678' https://x",
      headers: { Cookie: "a=b", Accept: "*/*" },
      nested: [{ token: "t" }, "sk-abcdefghijklmnop"],
      count: 3,
    };
    expect(redactValue(input)).toEqual({
      command: `curl -H 'Authorization: ${REDACTED}' https://x`,
      headers: { Cookie: REDACTED, Accept: "*/*" },
      nested: [{ token: REDACTED }, REDACTED],
      count: 3,
    });
  });

  it("does not mutate its input", () => {
    const input = { token: "t" };
    redactValue(input);
    expect(input.token).toBe("t");
  });
});

describe("redactText: credentials in a URL query string (review M4)", () => {
  it("scrubs the value and keeps the shape of the URL", () => {
    expect(
      redactText("open https://ops.example.test/cb?access_token=abcdefghijklmnop&next=/home"),
    ).toBe(`open https://ops.example.test/cb?access_token=${REDACTED}&next=/home`);
  });

  it.each([
    "token",
    "access_token",
    "api_key",
    "apikey",
    "key",
    "sig",
    "signature",
    "session",
    "sid",
    "auth",
  ])("scrubs ?%s=", (param) => {
    const out = redactText(`https://h/x?${param}=abcdefghijklmnop&page=2`);
    expect(out).toBe(`https://h/x?${param}=${REDACTED}&page=2`);
  });

  it("scrubs a credential that is not the first query parameter", () => {
    expect(redactText("https://h/x?page=2&sig=deadbeefcafe")).toBe(
      `https://h/x?page=2&sig=${REDACTED}`,
    );
  });

  it("scrubs several credentials in one string", () => {
    expect(redactText("a https://h/1?token=aaaa b https://h/2?sid=bbbb c")).toBe(
      `a https://h/1?token=${REDACTED} b https://h/2?sid=${REDACTED} c`,
    );
  });

  it("leaves ordinary query parameters alone", () => {
    const url = "https://ops.example.test/tickets?status=open&page=2&sort=created";
    expect(redactText(url)).toBe(url);
  });
});

describe("redactText: a cookie assigned in page script (review M4)", () => {
  it("scrubs sid= after document.cookie", () => {
    const out = redactText('await page.evaluate(() => document.cookie = "sid=abcdef123")');
    expect(out).not.toContain("abcdef123");
    expect(out).toContain(`cookie: ${REDACTED}`);
  });

  it("scrubs a cookie assignment however it is quoted", () => {
    for (const src of [
      "document.cookie = 'sid=abcdef123'",
      'document.cookie="sid=abcdef123"',
      "document.cookie = sid=abcdef123",
      "Cookie: sid=abcdef123; theme=dark",
    ]) {
      expect(redactText(src)).not.toContain("abcdef123");
    }
  });

  it("leaves a cookie mentioned without a value alone", () => {
    expect(redactText("the cookie jar is at /work/cookies")).toBe(
      "the cookie jar is at /work/cookies",
    );
  });
});

describe("isSensitiveKey: whole words, not substrings (review M4)", () => {
  it.each([
    "client_secret",
    "clientSecret",
    "api_secret",
    "apiSecret",
    "secret_key",
    "secretKey",
    "sessionid",
    "sessionId",
    "session_id",
    "passwd",
    "password",
    "passwords",
    "token",
    "access_token",
    "refresh_token",
    "authToken",
    "modelAuthToken",
    "api_key",
    "apikey",
    "apiKey",
    "x-api-key",
    "X-API-Key",
    "authorization",
    "Authorization",
    "cookie",
    "Cookie",
    "cookies",
    "set-cookie",
    "credential",
    "credentials",
    "secret",
    "secrets",
  ])("%s is a credential key", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "runId",
    "threadId",
    "botId",
    "approvalId",
    "workspaceId",
    "toolUseId",
    "tokens_used",
    "tokensUsed",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreateTokens",
    "tokenizer",
    "keyboard",
    "monkey",
    "sessionCount",
    "command",
    "element",
    "url",
  ])("%s is not a credential key", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactValue applies the key rule (review M4)", () => {
  it("redacts the new keys and leaves the token counts alone", () => {
    expect(
      redactValue({
        client_secret: "abc",
        api_secret: "abc",
        secret_key: "abc",
        sessionid: "abc",
        passwd: "abc",
        clientSecret: "abc",
        "x-api-key": "abc",
        runId: "run-1",
        threadId: "thread-1",
        tokens_used: 1234,
        inputTokens: 120,
      }),
    ).toEqual({
      client_secret: REDACTED,
      api_secret: REDACTED,
      secret_key: REDACTED,
      sessionid: REDACTED,
      passwd: REDACTED,
      clientSecret: REDACTED,
      "x-api-key": REDACTED,
      runId: "run-1",
      threadId: "thread-1",
      tokens_used: 1234,
      inputTokens: 120,
    });
  });

  /**
   * A `screenshot` payload has to reach the ledger byte for byte: the run screen rebuilds a data
   * URL from `mimeType` + `base64`, and one character replaced by `[redacted]` makes an image
   * that will not decode. The redactor works on text patterns and credential key names, and
   * `base64` is neither — the image is not redacted at all, which is why the README calls a
   * screenshot ledger data with the sensitivity of page content.
   */
  it("leaves a screenshot payload intact", () => {
    const payload = {
      toolName: "mcp__browser__browser_click",
      toolUseId: "toolu_01",
      action: 3,
      mimeType: "image/jpeg",
      base64: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a",
      bytes: 57,
      takenAt: "2026-09-22T10:00:00.000Z",
    };
    expect(redactValue(payload, ["deskmates-run-token-9f3c2a1b7e"])).toEqual(payload);
  });

  it("reaches credential keys nested in arrays and objects", () => {
    expect(
      redactValue({ items: [{ headers: { "Set-Cookie": "a=b" }, credentials: { pw: "x" } }] }),
    ).toEqual({ items: [{ headers: { "Set-Cookie": REDACTED }, credentials: REDACTED }] });
  });
});
