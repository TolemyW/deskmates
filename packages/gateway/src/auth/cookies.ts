// Session and pre-login cookies. Production uses `__Host-` names, which browsers accept only with
// Secure, Path=/ and no Domain: the cookie is bound to this exact origin over HTTPS. The explicit
// insecure development mode uses different names so a development cookie can never be mistaken
// for, or shadow, a production one.

import type { FastifyRequest } from "fastify";

export type CookieMode = "secure" | "insecure-dev";

export interface CookieNames {
  session: string;
  login: string;
}

export function cookieNames(mode: CookieMode): CookieNames {
  return mode === "secure"
    ? { session: "__Host-deskmates-session", login: "__Host-deskmates-login" }
    : { session: "deskmates-dev-session", login: "deskmates-dev-login" };
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    // The first occurrence wins, matching how browsers order more specific cookies first.
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const value = parseCookies(request.headers.cookie).get(name);
  return value === undefined || value === "" ? undefined : value;
}

/** A Set-Cookie value; `maxAgeSeconds` 0 deletes the cookie. Values are base64url only. */
export function serializeCookie(
  name: string,
  value: string,
  mode: CookieMode,
  maxAgeSeconds: number,
): string {
  const attrs = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mode === "secure") attrs.push("Secure");
  return attrs.join("; ");
}
