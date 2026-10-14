// Browser sign-in calls (ADR-0022 P1). The session is an HttpOnly cookie the browser holds and
// this code never sees; it handles only the CSRF tokens the Gateway returns. Nothing here writes
// to localStorage, sessionStorage or a URL.

import type { AuthSessionView, AuthenticatedSessionView } from "@deskmates/contracts";
import { createHttpTransport } from "../platform/http-transport.js";

export interface AuthClientOptions {
  baseUrl?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface AuthClient {
  getSession(): Promise<AuthSessionView>;
  login(loginName: string, password: string, loginCsrf: string): Promise<AuthenticatedSessionView>;
  logout(csrfToken: string): Promise<void>;
  logoutAll(csrfToken: string): Promise<void>;
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const t = createHttpTransport({ ...options, cache: "no-store" });
  const call = <T>(method: "GET" | "POST", path: string, csrf?: string, body?: unknown) =>
    t.request<T>(method, path, {
      ...(csrf ? { csrf } : {}),
      ...(body === undefined ? {} : { body: { json: body } }),
    });

  return {
    getSession: () => call<AuthSessionView>("GET", "/auth/session"),
    login: (loginName, password, loginCsrf) =>
      call<AuthenticatedSessionView>("POST", "/auth/login", loginCsrf, { loginName, password }),
    logout: async (csrfToken) => {
      await call("POST", "/auth/logout", csrfToken);
    },
    logoutAll: async (csrfToken) => {
      await call("POST", "/auth/logout-all", csrfToken);
    },
  };
}
