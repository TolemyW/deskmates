import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "./signature.js";

describe("X-Hub-Signature-256", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  const secret = "app-secret-1234";

  it("accepts the HMAC of the raw body under the app secret", () => {
    expect(verifySignature(body, signBody(body, secret), secret)).toBe(true);
    expect(signBody(body, secret)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("rejects a missing header, another secret, a changed body and a truncated digest", () => {
    const good = signBody(body, secret);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, [good], secret)).toBe(false);
    expect(verifySignature(body, signBody(body, "other"), secret)).toBe(false);
    expect(verifySignature(Buffer.from(`${body.toString()} `), good, secret)).toBe(false);
    expect(verifySignature(body, good.slice(0, -1), secret)).toBe(false);
    expect(verifySignature(body, good.toUpperCase(), secret)).toBe(false);
  });
});
