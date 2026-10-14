// T0: the Gateway's secret-shaped guard. Pure patterns, no database, no HTTP.

import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, scrubSecretShaped } from "./secret-shaped.js";

describe("scrubSecretShaped patterns", () => {
  it("redacts a bearer token wherever it appears", () => {
    const r = scrubSecretShaped({ command: "curl -H 'Authorization: Bearer sk-live-abcdefghij'" });
    const command = (r.value as { command: string }).command;
    expect(command).toContain(REDACTED);
    expect(command).not.toContain("sk-live-abcdefghij");
    expect(r.hits).toBe(1);
  });

  it("redacts a bare sk- key", () => {
    const r = scrubSecretShaped("the key is sk-ant-api03-9f8e7d6c5b");
    expect(r.value).toBe(`the key is ${REDACTED}`);
    expect(r.hits).toBe(1);
  });

  it("redacts a cookie header line and keeps the header name", () => {
    const r = scrubSecretShaped("set-cookie: sid=abc123def456; Path=/");
    expect(r.value).toBe(`set-cookie: ${REDACTED}`);
  });

  it("redacts the credential environment variables", () => {
    const r = scrubSecretShaped("ANTHROPIC_AUTH_TOKEN=xyzzy MODEL_AUTH_TOKEN: other");
    expect(r.value).toBe(`ANTHROPIC_AUTH_TOKEN=${REDACTED} MODEL_AUTH_TOKEN=${REDACTED}`);
  });

  it("redacts a credential in a query string but keeps the URL's shape", () => {
    const r = scrubSecretShaped("https://api.example.test/v1?access_token=zzz9999&page=2");
    expect(r.value).toBe(`https://api.example.test/v1?access_token=${REDACTED}&page=2`);
  });

  it("leaves a plain URL, runId and tokens_used untouched", () => {
    const input = {
      runId: "run_01HZX",
      tokens_used: 1234,
      inputTokens: 99,
      url: "https://shop.example.test/orders?page=2&sort=date",
    };
    const r = scrubSecretShaped(input);
    expect(r.value).toEqual(input);
    expect(r.hits).toBe(0);
  });

  it("redacts a property whose key names a credential, whatever its value looks like", () => {
    const r = scrubSecretShaped({ headers: { cookie: "sid=abc123def456", accept: "*/*" } });
    expect(r.value).toEqual({ headers: { cookie: REDACTED, accept: "*/*" } });
    expect(r.hits).toBe(1);
  });

  it("redacts an exact known secret even when it looks like nothing", () => {
    const r = scrubSecretShaped({ note: "token is hunter2hunter2" }, ["hunter2hunter2"]);
    expect(r.value).toEqual({ note: `token is ${REDACTED}` });
    expect(r.hits).toBe(1);
  });

  it("walks arrays and nested objects and counts every place it touched", () => {
    const r = scrubSecretShaped({
      args: ["--header", "Authorization: Bearer abcdefghijkl", "--url", "http://x.test/"],
      nested: { deep: { note: "sk-abcdefghij" } },
    });
    expect(JSON.stringify(r.value)).not.toContain("abcdefghijkl");
    expect(r.hits).toBe(2);
  });

  it("does not mutate its input", () => {
    const input = { command: "Authorization: Bearer abcdefghijkl" };
    scrubSecretShaped(input);
    expect(input.command).toBe("Authorization: Bearer abcdefghijkl");
  });
});

describe("isSensitiveKey", () => {
  it("matches credential words and nothing that merely contains them", () => {
    for (const key of ["cookie", "x-api-key", "clientSecret", "sessionId", "passwd", "token"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["runId", "tokens_used", "inputTokens", "threadId", "keyboard"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});
