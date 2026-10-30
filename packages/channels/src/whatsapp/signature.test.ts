import { describe, expect, it } from "vitest";
import { signBody, verifySignature, verifyTokenMatches } from "./signature.js";

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

describe("hub.verify_token", () => {
  it("accepts only the exact token, through a constant-time digest comparison", () => {
    expect(verifyTokenMatches("verify-token", "verify-token")).toBe(true);
    expect(verifyTokenMatches(null, "verify-token")).toBe(false);
    expect(verifyTokenMatches("", "verify-token")).toBe(false);
    expect(verifyTokenMatches("verify-toke", "verify-token")).toBe(false);
    expect(verifyTokenMatches("verify-token-and-more", "verify-token")).toBe(false);
    expect(verifyTokenMatches("VERIFY-TOKEN", "verify-token")).toBe(false);
  });

  it("is what the listener and the plugin compare with, never ===", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["server.ts", "plugin.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain("verifyTokenMatches(");
      expect(source, file).not.toMatch(/verify_?[tT]oken"?\)?\s*===|===\s*\S*verifyToken\b/);
    }
  });
});
