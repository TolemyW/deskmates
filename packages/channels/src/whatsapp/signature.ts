// Webhook authenticity (ADR-0017 decision 5): Meta signs the raw body with the app secret and
// sends `X-Hub-Signature-256: sha256=<hex>`. The comparison is constant-time and the body is the
// bytes as received, before any parsing. The subscription handshake's verify token is compared
// constant-time too.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";

export function signBody(rawBody: Buffer, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(signBody(rawBody, appSecret), "utf8");
  const given = Buffer.from(header.trim(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Meta's subscription handshake (`hub.verify_token`). Both sides are hashed first, so the
 * comparison is constant-time and does not reveal the token's length.
 */
export function verifyTokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}
