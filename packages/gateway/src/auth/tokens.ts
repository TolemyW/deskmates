// Opaque secrets for browser sessions. A session token is 256 random bits; the database keeps
// only its SHA-256. The CSRF token is derived from the session token, so it is bound to exactly
// one session and needs no storage of its own.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`deskmates-csrf:${sessionToken}`, "utf8").digest("base64url");
}

export function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
