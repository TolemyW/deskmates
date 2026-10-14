// The single bearer token every route but /healthz requires. Compared in constant time over
// sha256 digests so neither the value nor its length leaks through timing.

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m?.[1]) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}
