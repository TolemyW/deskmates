// T1 helpers for the ADR-0022 browser session: a minimal cookie jar over real HTTP, the way a
// same-origin browser would present cookies, Origin and the CSRF header.

import { CSRF_HEADER } from "@deskmates/contracts";
import type { AuthConfig } from "../auth/auth-service.js";

/** Cheap Argon2id so route tests stay fast; production parameters are tested separately. */
export const FAST_AUTH: Partial<AuthConfig> = {
  argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 },
  liveSweepMs: 25,
};

export const TEST_PASSWORD = "correct horse battery staple";

export interface SetCookie {
  name: string;
  value: string;
  attributes: string[];
}

export function parseSetCookies(response: Response): SetCookie[] {
  return response.headers.getSetCookie().map((line) => {
    const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
  });
}

/** A browser profile: one cookie jar, one origin. */
export class BrowserJar {
  readonly cookies = new Map<string, string>();
  csrf: string | undefined;

  constructor(
    readonly baseUrl: string,
    /** The Origin this browser sends; defaults to the Gateway's own (same-origin UI). */
    readonly origin: string = baseUrl,
  ) {}

  private absorb(response: Response): void {
    for (const cookie of parseSetCookies(response)) {
      const maxAge = cookie.attributes.find((a) => a.toLowerCase().startsWith("max-age="));
      if (cookie.value === "" || maxAge?.toLowerCase() === "max-age=0")
        this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async fetch(
    method: string,
    path: string,
    options: {
      body?: unknown;
      /** Raw bytes with their own content type instead of a JSON body (upload parts). */
      raw?: { bytes: Uint8Array; contentType: string };
      csrf?: string | null | undefined;
      origin?: string | null;
      headers?: Record<string, string>;
      /** `manual` keeps a redirect's Set-Cookie and Location visible, as a browser would. */
      redirect?: "manual";
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    const origin = options.origin === undefined ? this.origin : options.origin;
    if (origin !== null && method !== "GET") headers.origin = origin;
    const csrf = options.csrf === undefined ? this.csrf : options.csrf;
    if (csrf !== null && csrf !== undefined && method !== "GET") headers[CSRF_HEADER] = csrf;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.raw) headers["content-type"] = options.raw.contentType;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.raw ? { body: options.raw.bytes } : {}),
      ...(options.redirect ? { redirect: options.redirect } : {}),
    });
    this.absorb(response);
    return response;
  }

  async json<T>(
    method: string,
    path: string,
    options: Parameters<BrowserJar["fetch"]>[2] = {},
  ): Promise<{ status: number; json: T; response: Response }> {
    const response = await this.fetch(method, path, options);
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : undefined) as T, response };
  }

  /** The UI's sign-in: read the pre-login token, then post the credentials with it. */
  async signIn(loginName: string, password: string = TEST_PASSWORD): Promise<Response> {
    const anonymous = await this.json<{ loginCsrf?: string; csrfToken?: string }>(
      "GET",
      "/auth/session",
    );
    const response = await this.fetch("POST", "/auth/login", {
      body: { loginName, password },
      csrf: anonymous.json.loginCsrf ?? null,
    });
    if (response.ok) {
      const view = (await response.clone().json()) as { csrfToken: string };
      this.csrf = view.csrfToken;
    }
    return response;
  }
}
