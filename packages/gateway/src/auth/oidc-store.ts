// Platform-approved OIDC providers, the tenants that trust them, and single-use login
// transactions (ADR-0022 decision 3). A provider's issuer, client and redirect URI are set by
// platform maintenance only; no request can name a discovery URL. A transaction is keyed by the
// SHA-256 of its `state`, bound to the browser that started it, and consumed at most once.

import { DeskmatesError } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import { hashToken, newOpaqueToken } from "./tokens.js";

export const OIDC_TRANSACTION_TTL_SECONDS = 10 * 60;
/**
 * Open sign-in transactions (started before any session) the database holds at once. A backstop
 * behind the per-address start limit: it bounds the table whatever the number of addresses.
 */
export const OIDC_MAX_OPEN_PRELOGIN_TRANSACTIONS = 5000;
export const SSO_MAX_AUTH_AGE_SECONDS_DEFAULT = 12 * 60 * 60;
const CALLBACK_PATH = "/auth/oidc/callback";

export type OidcPurpose = "login" | "link" | "tenant_grant";

export interface OidcProvider {
  id: string;
  displayName: string;
  issuer: string;
  clientId: string;
  /** Secrets Store id of the client secret; null for a public client (PKCE only). */
  clientSecretId: string | null;
  redirectUri: string;
  scopes: string;
  status: "active" | "disabled";
}

export interface TenantSsoLink {
  tenantId: string;
  providerId: string;
  /** `member`: an unknown subject of this issuer may join this tenant as a Member; else none. */
  jitRole: "member" | null;
  maxAuthAgeSeconds: number;
}

export interface OidcTransaction {
  providerId: string;
  purpose: OidcPurpose;
  tenantId: string | null;
  sessionId: string | null;
  browserBindingHash: string;
  codeVerifier: string;
  nonce: string;
  returnPath: string;
  /** The invitation an invited sign-in carries to its callback (P4). */
  invitationId?: string | null;
  expiresAt: string;
}

interface ProviderRow {
  id: string;
  display_name: string;
  issuer: string;
  client_id: string;
  client_secret_id: string | null;
  redirect_uri: string;
  scopes: string;
  status: "active" | "disabled";
}

interface LinkRow {
  tenant_id: string;
  provider_id: string;
  jit_role: "member" | null;
  max_auth_age_seconds: number;
}

interface TransactionRow {
  provider_id: string;
  purpose: OidcPurpose;
  tenant_id: string | null;
  session_id: string | null;
  browser_binding_hash: string;
  code_verifier: string;
  nonce: string;
  return_path: string;
  invitation_id: string | null;
  expires_at: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function toProvider(row: ProviderRow): OidcProvider {
  return {
    id: row.id,
    displayName: row.display_name,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecretId: row.client_secret_id,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    status: row.status,
  };
}

function toLink(row: LinkRow): TenantSsoLink {
  return {
    tenantId: row.tenant_id,
    providerId: row.provider_id,
    jitRole: row.jit_role,
    maxAuthAgeSeconds: row.max_auth_age_seconds,
  };
}

/** Loopback hosts may use plain HTTP for local development; every other issuer needs HTTPS. */
function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function absoluteUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeskmatesError("validation", `${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url)))
    throw new DeskmatesError("validation", `${name} must use https (http only on loopback)`);
  if (url.username || url.password || url.hash)
    throw new DeskmatesError("validation", `${name} must not carry credentials or a fragment`);
  return url;
}

/**
 * A safe place to send the browser after sign-in: a path on this origin. `//host` and `/\host`
 * are protocol-relative in browsers, so both are refused, as is anything but printable ASCII (encode it first).
 */
export function safeReturnPath(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "/";
  if (
    typeof raw !== "string" ||
    raw.length > 512 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    [...raw].some((ch) => ch.charCodeAt(0) < 0x21 || ch.charCodeAt(0) > 0x7e)
  )
    throw new DeskmatesError("validation", "returnPath must be a path on this site");
  return raw;
}

export class OidcStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly secrets: SecretsStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  /** Register a provider (platform maintenance). The issuer is pinned here and nowhere else. */
  addProvider(input: {
    id: string;
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes?: string;
  }): OidcProvider {
    if (!PROVIDER_ID.test(input.id))
      throw new DeskmatesError("validation", "provider id must be 1-64 of a-z, 0-9 and '-'");
    const displayName = input.displayName.trim();
    if (!displayName) throw new DeskmatesError("validation", "display name is required");
    absoluteUrl("issuer", input.issuer);
    const redirect = absoluteUrl("redirect URI", input.redirectUri);
    if (redirect.pathname !== CALLBACK_PATH || redirect.search)
      throw new DeskmatesError("validation", `redirect URI path must be exactly ${CALLBACK_PATH}`);
    if (!input.clientId.trim()) throw new DeskmatesError("validation", "client id is required");
    const scopes = (input.scopes ?? "openid email profile").trim().split(/\s+/);
    if (!scopes.includes("openid"))
      throw new DeskmatesError("validation", "scopes must include openid");
    return this.db
      .transaction(() => {
        if (this.getProvider(input.id))
          throw new DeskmatesError("invalid_transition", "provider id already exists");
        if (this.db.prepare("SELECT 1 FROM oidc_providers WHERE issuer = ?").get(input.issuer))
          throw new DeskmatesError(
            "invalid_transition",
            "a provider for this issuer already exists",
          );
        const secretId =
          input.clientSecret === undefined || input.clientSecret === ""
            ? null
            : this.secrets.put("oidc_provider", input.id, input.clientSecret);
        const at = this.now();
        this.db
          .prepare(
            `INSERT INTO oidc_providers (id, display_name, issuer, client_id, client_secret_id,
               redirect_uri, scopes, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            input.id,
            displayName,
            input.issuer,
            input.clientId.trim(),
            secretId,
            redirect.href,
            scopes.join(" "),
            at,
            at,
          );
        return this.getProvider(input.id) as OidcProvider;
      })
      .immediate();
  }

  getProvider(id: string): OidcProvider | undefined {
    const row = this.db.prepare("SELECT * FROM oidc_providers WHERE id = ?").get(id) as
      | ProviderRow
      | undefined;
    return row ? toProvider(row) : undefined;
  }

  listProviders(): OidcProvider[] {
    return (this.db.prepare("SELECT * FROM oidc_providers ORDER BY id").all() as ProviderRow[]).map(
      toProvider,
    );
  }

  /** Disabling a provider stops it admitting anywhere on the next request. */
  setProviderStatus(id: string, status: OidcProvider["status"]): OidcProvider {
    const result = this.db
      .prepare("UPDATE oidc_providers SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), id);
    if (result.changes === 0) throw new DeskmatesError("not_found", "provider not found");
    return this.getProvider(id) as OidcProvider;
  }

  clientSecret(provider: OidcProvider): string | undefined {
    return provider.clientSecretId === null ? undefined : this.secrets.get(provider.clientSecretId);
  }

  /** Let a tenant trust a provider, or change how (platform maintenance). */
  linkTenant(
    tenantId: string,
    providerId: string,
    options: { jitRole?: "member" | null; maxAuthAgeSeconds?: number } = {},
  ): TenantSsoLink {
    const age = options.maxAuthAgeSeconds ?? SSO_MAX_AUTH_AGE_SECONDS_DEFAULT;
    if (!Number.isInteger(age) || age <= 0)
      throw new DeskmatesError("validation", "max auth age must be a positive number of seconds");
    if (options.jitRole !== undefined && options.jitRole !== null && options.jitRole !== "member")
      throw new DeskmatesError("validation", "just-in-time accounts may only be Members");
    if (!this.getProvider(providerId)) throw new DeskmatesError("not_found", "provider not found");
    if (!this.db.prepare("SELECT 1 FROM tenants WHERE id = ?").get(tenantId))
      throw new DeskmatesError("not_found", "tenant not found");
    this.db
      .prepare(
        `INSERT INTO tenant_sso_providers (tenant_id, provider_id, jit_role, max_auth_age_seconds, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, provider_id) DO UPDATE SET jit_role = excluded.jit_role,
           max_auth_age_seconds = excluded.max_auth_age_seconds`,
      )
      .run(tenantId, providerId, options.jitRole ?? null, age, this.now());
    return this.tenantLink(tenantId, providerId) as TenantSsoLink;
  }

  /** Unlinking takes effect on the next request: grants re-read the tenant's issuers. */
  unlinkTenant(tenantId: string, providerId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM tenant_sso_providers WHERE tenant_id = ? AND provider_id = ?")
        .run(tenantId, providerId).changes > 0
    );
  }

  tenantLink(tenantId: string, providerId: string): TenantSsoLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM tenant_sso_providers WHERE tenant_id = ? AND provider_id = ?")
      .get(tenantId, providerId) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  /**
   * Active tenants that admit an unknown subject of this provider as a Member (`--jit member`),
   * in id order. The sign-in page names no tenant; when this is exactly one, that is the tenant
   * such a sign-in is for.
   */
  jitTenants(providerId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT l.tenant_id FROM tenant_sso_providers l JOIN tenants t ON t.id = l.tenant_id
           WHERE l.provider_id = ? AND l.jit_role = 'member' AND t.status = 'active'
           ORDER BY l.tenant_id`,
        )
        .all(providerId) as { tenant_id: string }[]
    ).map((row) => row.tenant_id);
  }

  /** Active providers a tenant trusts, for the step-up choice. */
  tenantProviders(tenantId: string): OidcProvider[] {
    return (
      this.db
        .prepare(
          `SELECT p.* FROM oidc_providers p JOIN tenant_sso_providers l ON l.provider_id = p.id
           WHERE l.tenant_id = ? AND p.status = 'active' ORDER BY p.id`,
        )
        .all(tenantId) as ProviderRow[]
    ).map(toProvider);
  }

  /**
   * Remember a logout token's `jti`; false when this provider already sent it (a replay).
   * Expired entries are dropped on the way.
   */
  rememberLogoutToken(providerId: string, jti: string, keepSeconds: number): boolean {
    const now = this.clock();
    this.db.prepare("DELETE FROM oidc_logout_tokens WHERE expires_at <= ?").run(now.toISOString());
    const result = this.db
      .prepare(
        `INSERT INTO oidc_logout_tokens (jti_hash, provider_id, received_at, expires_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (jti_hash) DO NOTHING`,
      )
      .run(
        hashToken(`${providerId}\u0000${jti}`),
        providerId,
        now.toISOString(),
        new Date(now.getTime() + keepSeconds * 1000).toISOString(),
      );
    return result.changes === 1;
  }

  /** Open a transaction; returns the raw `state` for the authorization redirect. */
  createTransaction(input: Omit<OidcTransaction, "expiresAt">): string {
    const now = this.clock();
    this.db
      .prepare("DELETE FROM oidc_login_transactions WHERE expires_at <= ?")
      .run(now.toISOString());
    if (input.sessionId === null) {
      const open = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM oidc_login_transactions WHERE session_id IS NULL AND consumed_at IS NULL",
          )
          .get() as { n: number }
      ).n;
      if (open >= OIDC_MAX_OPEN_PRELOGIN_TRANSACTIONS)
        throw new DeskmatesError(
          "rate_limited",
          "too many sign-ins in progress; try again shortly",
          {
            retryAfterSeconds: 60,
          },
        );
    }
    const state = newOpaqueToken();
    this.db
      .prepare(
        `INSERT INTO oidc_login_transactions (state_hash, provider_id, purpose, tenant_id, session_id,
           browser_binding_hash, code_verifier, nonce, return_path, invitation_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(state),
        input.providerId,
        input.purpose,
        input.tenantId,
        input.sessionId,
        input.browserBindingHash,
        input.codeVerifier,
        input.nonce,
        safeReturnPath(input.returnPath),
        input.invitationId ?? null,
        now.toISOString(),
        new Date(now.getTime() + OIDC_TRANSACTION_TTL_SECONDS * 1000).toISOString(),
      );
    return state;
  }

  /**
   * Consume a transaction by its state: one atomic update, so a replayed or concurrent callback
   * with the same state finds nothing. Expired transactions are never returned.
   */
  consumeTransaction(state: string): OidcTransaction | undefined {
    if (state.length === 0 || state.length > 256) return undefined;
    const now = this.now();
    const row = this.db
      .prepare(
        `UPDATE oidc_login_transactions SET consumed_at = ?
         WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING provider_id, purpose, tenant_id, session_id, browser_binding_hash,
           code_verifier, nonce, return_path, invitation_id, expires_at`,
      )
      .get(now, hashToken(state), now) as TransactionRow | undefined;
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      purpose: row.purpose,
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      browserBindingHash: row.browser_binding_hash,
      codeVerifier: row.code_verifier,
      nonce: row.nonce,
      returnPath: row.return_path,
      invitationId: row.invitation_id,
      expiresAt: row.expires_at,
    };
  }
}
