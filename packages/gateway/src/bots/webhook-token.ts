// The per-bot webhook token behind `POST /hooks/:botId/:token`. Like `run_tokens`, only the
// SHA-256 is stored: the plaintext is returned once, when the bot is created or the token is
// rotated, and the Gateway cannot show it again.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url. Long enough that guessing it is not a threat model. */
export function newWebhookToken(): string {
  return `whk_${randomBytes(32).toString("base64url")}`;
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function webhookTokenMatches(token: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const presented = Buffer.from(hashWebhookToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presented.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(presented, stored);
}
