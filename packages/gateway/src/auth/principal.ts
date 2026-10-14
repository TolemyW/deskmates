// Who is making an operator request. Routes derive attribution from this, never from a body
// field. Three kinds exist: a signed-in person in one tenant; a service principal, a tenant's
// machine identity for an external agent client (ADR-0022 amendment 2); and the legacy shared
// operator credential, which ADR-0022 keeps only as a single-tenant maintenance bridge.

import type { ServicePrincipalRole, TenantRole } from "@deskmates/contracts";

export interface UserPrincipal {
  kind: "user";
  userId: string;
  displayName: string;
  loginName: string | null;
  sessionId: string;
  tenantId: string;
  role: TenantRole;
}

export interface ServicePrincipal {
  kind: "service";
  servicePrincipalId: string;
  name: string;
  tenantId: string;
  /** Its tenant role, checked like a person's (ADR-0022 amendment 1 A10); never `owner`. */
  role: ServicePrincipalRole;
  /**
   * The key its long-lived connections register under: bound to the principal and to the token
   * hash presented, so disabling or rotating closes exactly what the old token opened.
   */
  liveKey: string;
}

export interface OperatorTokenPrincipal {
  kind: "operator_token";
  tenantId: string;
}

export type Principal = UserPrincipal | ServicePrincipal | OperatorTokenPrincipal;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the operator authentication hook before any `/api/*` handler runs. */
    principal?: Principal;
  }
}

/**
 * The actor label stored for a principal's act. The shared credential keeps the historical
 * `human:web` label: it is the same unattributed operator fact the ledger always recorded.
 */
export function actorLabel(principal: Principal | undefined): string {
  // A route outside the authenticated scope has no actor; fail closed instead of guessing one.
  if (principal === undefined) throw new Error("no authenticated principal on this request");
  switch (principal.kind) {
    case "user":
      return `user:${principal.userId}`;
    case "service":
      return `service:${principal.servicePrincipalId}`;
    case "operator_token":
      return "human:web";
  }
}

/**
 * The key a long-lived connection (event stream, desktop) registers under so revocation can
 * reach it: the session for a person, the token-bound key for a service principal. The operator
 * credential has none; it is revoked by changing the deployment's configuration.
 */
export function liveKeyOf(principal: Principal | undefined): string | undefined {
  if (principal?.kind === "user") return principal.sessionId;
  if (principal?.kind === "service") return principal.liveKey;
  return undefined;
}
