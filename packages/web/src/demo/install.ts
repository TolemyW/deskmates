// Installs the in-browser mock Gateway: `fetch` for `/api/*` and an `EventSource` that the mock
// pushes frames into. Demo only; the real UI never imports this module (main.tsx does not).

import type { GatewayEvent } from "../api/types.js";
import { type CostAlertFixture, MockGateway } from "./mock-gateway.js";

type Listener = (event: Event) => void;

/** A minimal EventSource the mock can push into; the UI's subscription code sees the real API. */
export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances = new Set<MockEventSource>();
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: Listener | null = null;
  onerror: Listener | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly threadId: string | undefined;

  constructor(url: string | URL) {
    this.url = String(url);
    const query = new URL(this.url, "http://mock").searchParams;
    this.threadId = query.get("threadId") ?? undefined;
    MockEventSource.instances.add(this);
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.dispatch("open", new Event("open"));
    }, 10);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatch(event.type, event);
    return true;
  }

  close(): void {
    this.readyState = 2;
    MockEventSource.instances.delete(this);
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Deliver a Gateway frame to this stream if its filter accepts it. */
  deliver(event: GatewayEvent): void {
    if (this.readyState !== 1) return;
    const threadId = "threadId" in event ? event.threadId : undefined;
    if (this.threadId !== undefined && threadId !== this.threadId) return;
    const message = new MessageEvent(event.type, { data: JSON.stringify(event) });
    this.onmessage?.(message);
    this.dispatch(event.type, message);
    this.dispatch("message", message);
  }
}

/**
 * The demo is signed in; signing out ends the page's demo session until a reload. `?signedOut=1`
 * starts signed out, to preview an invitation as its recipient sees it.
 */
let demoSignedIn = new URLSearchParams(window.location.search).get("signedOut") !== "1";

/**
 * Demo invitation links (issue #25): `demo-signup` is an open sign-up link, `demo-legacy` an
 * issued `local_new` invitation, and `demo-used`, `demo-revoked`, `demo-expired` unusable ones.
 * Choosing the username `taken` shows the collision.
 */
function demoInvitation(token: string): Response | Record<string, unknown> {
  const unusable = { "demo-used": "used", "demo-revoked": "revoked", "demo-expired": "expired" }[
    token
  ];
  if (unusable)
    return new Response(
      JSON.stringify({
        code: "invitation_unusable",
        message: `This invitation is ${unusable}`,
        details: { reason: unusable },
      }),
      { status: 410, headers: { "content-type": "application/json" } },
    );
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  if (token === "demo-signup")
    return { tenantName: "Demo", role: "member", target: { kind: "local_signup" }, expiresAt };
  if (token === "demo-legacy")
    return {
      tenantName: "Demo",
      role: "member",
      target: { kind: "local_new", loginName: "reserved" },
      expiresAt,
    };
  return new Response(
    JSON.stringify({ code: "token_rejected", message: "not valid", details: {} }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}
/** The demo person's UI preferences (the language of issue #23), kept until a reload. */
let demoPreferences: Record<string, unknown> = {};
/**
 * The demo person's own account (issue #26), kept until a reload. Nothing here is a real
 * account. `?account=sso` previews an SSO-only person; `?account=mixed` one whose password exists
 * but who signed in through SSO. The demo's current password is {@link DEMO_PASSWORD}.
 */
const DEMO_PASSWORD = "demo password";
const demoAccountMode = new URLSearchParams(window.location.search).get("account");
const demoProfile = {
  displayName: "Demo operator",
  // A data URL, because the demo has no Gateway to serve `/auth/avatar`.
  avatarUrl: null as string | null,
  password: DEMO_PASSWORD,
  csrf: 1,
};

function demoAccount(): { localLoginName: string | null; password: string } {
  if (demoAccountMode === "sso") return { localLoginName: null, password: "identity_provider" };
  if (demoAccountMode === "mixed")
    return { localLoginName: "demo", password: "sign_in_with_password" };
  return { localLoginName: "demo", password: "available" };
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function demoAuth(
  method: string,
  path: string,
  body?: unknown,
  rawBody?: BodyInit | null,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const profile = () => ({
    displayName: demoProfile.displayName,
    avatarUrl: demoProfile.avatarUrl,
  });
  if (method === "GET" && path === "/auth/session") {
    const account = demoAccount();
    return json(
      demoSignedIn
        ? {
            authenticated: true,
            user: {
              id: "usr_demo",
              displayName: demoProfile.displayName,
              loginName: account.password === "available" ? "demo" : null,
              avatarUrl: demoProfile.avatarUrl,
            },
            tenant: { id: "tnt_default", name: "Demo", role: "owner" },
            session: {
              authenticatedAt: new Date().toISOString(),
              idleExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
            csrfToken: `demo-${demoProfile.csrf}`,
            // The demo operator keeps the installation too, so every screen offers everything.
            platformMaintainer: true,
            preferences: demoPreferences,
            account,
          }
        : { authenticated: false, setupRequired: false, loginCsrf: "demo" },
    );
  }
  if (method === "GET" && path.startsWith("/auth/invitations/")) {
    const preview = demoInvitation(decodeURIComponent(path.slice("/auth/invitations/".length)));
    return preview instanceof Response ? preview : json(preview);
  }
  if (method === "POST" && path === "/auth/invitations/accept") {
    const accept = (body ?? {}) as Record<string, unknown>;
    const preview = demoInvitation(String(accept.token ?? ""));
    if (preview instanceof Response) return preview;
    if (accept.loginName === undefined && demoSignedIn)
      return json({ joined: true, tenantId: "tnt_default" });
    if (accept.loginName === "taken")
      return json(
        {
          code: "invalid_transition",
          message: "That username is already taken",
          details: { reason: "login_name_taken" },
        },
        409,
      );
    if (typeof accept.password !== "string" || accept.password.length < 12)
      return json(
        { code: "validation", message: "password must be at least 12 characters", details: {} },
        400,
      );
    demoProfile.displayName =
      typeof accept.displayName === "string"
        ? accept.displayName
        : String(accept.loginName ?? demoProfile.displayName);
    demoSignedIn = true;
    return demoAuth("GET", "/auth/session");
  }
  if (method === "PATCH" && path === "/auth/profile") {
    const name = (body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 128)
      return json({ code: "validation", message: "display name is required", details: {} }, 400);
    demoProfile.displayName = name.trim();
    return json(profile());
  }
  if (method === "PUT" && path === "/auth/avatar") {
    if (!(rawBody instanceof Blob) || rawBody.size === 0)
      return json({ code: "validation", message: "the avatar image is empty", details: {} }, 400);
    demoProfile.avatarUrl = await blobAsDataUrl(rawBody);
    return json(profile());
  }
  if (method === "DELETE" && path === "/auth/avatar") {
    demoProfile.avatarUrl = null;
    return json(profile());
  }
  if (method === "POST" && path === "/auth/password") {
    const change = body as { currentPassword?: string; newPassword?: string } | undefined;
    if (demoAccount().password !== "available")
      return json(
        {
          code: "invalid_transition",
          message: "This session did not sign in with a password",
          details: {},
        },
        409,
      );
    if ((change?.newPassword ?? "").length < 12)
      return json(
        { code: "validation", message: "password must be at least 12 characters", details: {} },
        400,
      );
    if (change?.currentPassword !== demoProfile.password)
      return json(
        { code: "forbidden", message: "Current password is incorrect", details: {} },
        403,
      );
    demoProfile.password = change.newPassword as string;
    demoProfile.csrf += 1;
    return demoAuth("GET", "/auth/session");
  }
  if (method === "POST" && (path === "/auth/logout" || path === "/auth/logout-all")) {
    demoSignedIn = false;
    return json({ signedOut: true });
  }
  if (method === "PATCH" && path === "/auth/preferences") {
    if (typeof body === "object" && body !== null && !Array.isArray(body))
      demoPreferences = { ...demoPreferences, ...(body as Record<string, unknown>) };
    return json({ preferences: demoPreferences });
  }
  if (method === "POST" && path === "/auth/login") {
    demoSignedIn = true;
    return demoAuth("GET", "/auth/session");
  }
  return json({ code: "not_found", message: "not found", details: {} }, 404);
}

export function installMockGateway(): MockGateway {
  const requested = new URLSearchParams(window.location.search).get("costAlerts");
  const fixture: CostAlertFixture =
    requested === "populated" || requested === "failure" ? requested : "empty";
  const gateway = new MockGateway((event) => {
    for (const source of MockEventSource.instances) source.deliver(event);
  }, fixture);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("/")
      ? url
      : new URL(url, window.location.href).pathname + new URL(url, window.location.href).search;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (path.startsWith("/auth/")) return demoAuth(method, path, body, init?.body);
    if (!path.startsWith("/api/")) return realFetch(input, init);
    const result = await gateway.handle(method, path, body);
    if (result.blob) {
      return new Response(result.blob, { status: result.status });
    }
    return new Response(JSON.stringify(result.json), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  (window as unknown as { EventSource: typeof EventSource }).EventSource =
    MockEventSource as unknown as typeof EventSource;
  return gateway;
}
