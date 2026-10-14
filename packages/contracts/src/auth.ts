// Browser login and session shapes (ADR-0022 P1). The session itself is an HttpOnly cookie the
// browser holds; nothing here carries it. The CSRF token is safe to keep in page memory: it is
// useless without the cookie and bound to that one session.

import type { IsoTimestamp } from "./ids.js";
import type { UserPreferences } from "./user-preferences.js";

/**
 * The four roles a person holds per workspace (ADR-0022 amendment 6, ADR-0031 decision 7), highest
 * first. A session's tenant-level `role` is the highest one it holds in any workspace of the
 * tenant (none counts as `guest`); routes check the role in the workspace they act on.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** The roles; the name predates per-workspace roles (ADR-0022 amendment 6). */
export const TENANT_ROLES = WORKSPACE_ROLES;
export type TenantRole = WorkspaceRole;

/** The roles an invitation or a created account may carry: never `owner`. */
export const INVITABLE_ROLES = ["admin", "member", "guest"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(value: unknown): value is InvitableRole {
  return value === "admin" || value === "member" || value === "guest";
}

/** A person's role in one workspace, as `GET /auth/session` reports it. */
export interface WorkspaceRoleView {
  workspaceId: string;
  role: WorkspaceRole;
}

/** Header that carries the session-bound (or, for login, pre-session) CSRF token. */
export const CSRF_HEADER = "x-deskmates-csrf";

/**
 * Header naming the tenant a request acts in (ADR-0022). Only a selector: the Gateway checks it
 * against the session's memberships and grants. Absent, the Default Tenant or the first tenant
 * the session may enter is used.
 */
export const TENANT_HEADER = "x-deskmates-tenant";

export interface AuthUserView {
  id: string;
  displayName: string;
  /** The local login name, when the session was opened with one. */
  loginName: string | null;
  /**
   * The person's own uploaded avatar on this Gateway (`/auth/avatar?v=<hash>`), or null for the
   * name-based fallback (ADR-0022 amendment 3). Absent from a Gateway older than migration 0048.
   */
  avatarUrl?: string | null;
}

// Self-service account settings (ADR-0022 amendment 3, issue #26).

/** Longest display name a person may choose, in characters. */
export const DISPLAY_NAME_MAX_LENGTH = 128;
/** Largest avatar upload, in bytes. */
export const AVATAR_MAX_BYTES = 512 * 1024;
/** Image types an avatar may have; the Gateway checks each file's signature against its type. */
export const AVATAR_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

export function isAvatarContentType(value: unknown): value is AvatarContentType {
  return (
    typeof value === "string" && (AVATAR_CONTENT_TYPES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Whether this person can change a local password here:
 * - `available`: a local password exists and this session signed in with it;
 * - `sign_in_with_password`: a local password exists, but this session came through SSO;
 * - `identity_provider`: no local password; the identity provider manages sign-in.
 */
export type PasswordCapability = "available" | "sign_in_with_password" | "identity_provider";

/** Authoritative account facts for the settings page, read from the account on every view. */
export interface AccountView {
  /** The account's local login name, whichever way this session signed in; null when none. */
  localLoginName: string | null;
  password: PasswordCapability;
}

/** `PATCH /auth/profile`: the only field a person changes about themselves here. */
export interface UpdateProfileRequest {
  displayName: string;
}

/** What `PATCH /auth/profile`, `PUT /auth/avatar` and `DELETE /auth/avatar` return. */
export interface ProfileView {
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthTenantView {
  id: string;
  name: string;
  role: TenantRole;
}

export interface AuthSessionTimes {
  authenticatedAt: IsoTimestamp;
  idleExpiresAt: IsoTimestamp;
  absoluteExpiresAt: IsoTimestamp;
}

/** `GET /auth/session` for a signed-in browser. */
export interface AuthenticatedSessionView {
  authenticated: true;
  user: AuthUserView;
  tenant: AuthTenantView;
  session: AuthSessionTimes;
  /** Send as `x-deskmates-csrf` on every POST/PATCH/PUT/DELETE. */
  csrfToken: string;
  /** Every tenant this person belongs to, the current one included (P4 tenant switcher). */
  tenants?: AuthTenantChoice[];
  /** Whether this person may use platform maintenance routes. */
  platformMaintainer?: boolean;
  /** Whether this is the protected root account `admin` (ADR-0022 amendment 6 W2). */
  root?: boolean;
  /**
   * This person's role in each workspace of the tenant (amendment 6 W11); the root is Owner of
   * every one. Absent from a Gateway before per-workspace roles.
   */
  workspaceRoles?: WorkspaceRoleView[];
  /**
   * True while the account still holds a default password (the protected root's `admin`):
   * every product route refuses until `POST /auth/password` changes it (ADR-0031 decision 8).
   */
  passwordChangeRequired?: boolean;
  /** This person's own UI preferences; absent from a Gateway older than migration 0045. */
  preferences?: UserPreferences;
  /** Account facts for the settings page; absent from a Gateway older than migration 0048. */
  account?: AccountView;
}

/** A platform-approved OIDC provider a browser may sign in with (ADR-0022 decision 3). */
export interface SsoProviderView {
  id: string;
  displayName: string;
}

/** `GET /auth/session` before sign-in. */
export interface AnonymousSessionView {
  authenticated: false;
  /** No account exists yet; platform maintenance must bootstrap the Owner from the CLI. */
  setupRequired: boolean;
  /** Pre-session token for `POST /auth/login`, bound to an HttpOnly pre-login cookie. */
  loginCsrf: string;
  /** Active OIDC providers; absent or empty when none is configured. */
  ssoProviders?: SsoProviderView[];
}

export type AuthSessionView = AuthenticatedSessionView | AnonymousSessionView;

export interface LoginRequest {
  loginName: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/**
 * `POST /auth/oidc/:provider/start`. `login` signs a browser in (CSRF: the pre-login token);
 * `link` attaches the external identity to the signed-in account and `tenant_grant` lets the
 * signed-in session enter an SSO-enforced tenant (CSRF: the session token).
 */
export interface OidcStartRequest {
  purpose: "login" | "link" | "tenant_grant";
  /** JIT target for `login`; required for `tenant_grant`. */
  tenantId?: string;
  /** A path on this site to return to; defaults to `/`. */
  returnPath?: string;
  /** For `login`: an `oidc_email` invitation token to accept with this sign-in. */
  invitation?: string;
}

export interface OidcStartResponse {
  /** Open this URL in the same browser; the IdP returns to `/auth/oidc/callback`. */
  authorizationUrl: string;
}

/** Query parameter the callback adds to the return path when a flow fails. */
export const SSO_ERROR_PARAM = "sso_error";

/** A tenant the signed-in person belongs to, for the tenant switcher (ADR-0022 P4). */
export interface AuthTenantChoice {
  id: string;
  name: string;
  role: TenantRole;
  /** False when this session needs SSO evidence for it first (step-up with `ssoProviders`). */
  enterable: boolean;
  ssoProviders: SsoProviderView[];
}

/**
 * `GET /api/members?workspaceId=`: the people of one workspace and their role there (ADR-0022
 * amendment 6 W9). `status` is the workspace membership's.
 */
export interface TenantMemberView {
  userId: string;
  displayName: string;
  loginName: string | null;
  role: TenantRole;
  status: "active" | "removed";
  /** The workspace the role is in; absent from a Gateway before per-workspace roles. */
  workspaceId?: string;
  /** The protected root account: Owner everywhere, never changed or removed. */
  protected?: boolean;
}

/**
 * People lists are offset pages of 25, at most 100 (#113 slice M, pagination plan §3.1): members
 * ordered by status, display name and user id; invitations newest first, then by id.
 */
export const PEOPLE_PAGE_SIZE = 25;

/** `GET /api/members?workspaceId=&role=&status=&offset=&limit=`: one page and the honest total. */
export interface MembersPage {
  members: TenantMemberView[];
  offset: number;
  limit: number;
  total: number;
}

/** `GET /api/invitations?workspaceId=&offset=&limit=`: one page and the honest total. */
export interface InvitationsPage {
  invitations: InvitationView[];
  offset: number;
  limit: number;
  total: number;
}

/** `PATCH /api/members/:userId`: a change in one workspace (`workspaceId`). */
export interface UpdateMemberRequest {
  role?: TenantRole;
  status?: "active" | "removed";
  workspaceId?: string;
}

/**
 * Who may accept an invitation (ADR-0022 P4, amendment 4):
 * - `local_signup`: whoever holds the link, choosing their own username, or joining with the
 *   account they are signed in with;
 * - `local_new`: a new local account with exactly this login name (issued before amendment 4;
 *   still accepted, no longer offered by the People screen);
 * - `local_user`: the existing local account with this login name, from its own session;
 * - `oidc_email`: a login at the provider whose ID token asserts this email as verified.
 */
export type InvitationTargetView =
  | { kind: "local_signup" }
  | { kind: "local_new"; loginName: string }
  | { kind: "local_user"; loginName: string }
  | { kind: "oidc_email"; providerId: string; email: string };

export interface CreateInvitationRequest {
  role: InvitableRole;
  /** The workspace the role is granted in (ADR-0022 amendment 6 W9). */
  workspaceId?: string;
  target: InvitationTargetView;
  /** Defaults to 7 days; at most 30. */
  expiresInSeconds?: number;
}

export interface InvitationView {
  id: string;
  role: InvitableRole;
  /** The workspace the invitation grants its role in. */
  workspaceId?: string;
  target: InvitationTargetView;
  createdBy: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  status: "open" | "accepted" | "revoked" | "expired";
}

/** `POST /api/invitations`: the link is shown once; only a hash of its token is stored. */
export interface CreatedInvitationView {
  invitation: InvitationView;
  /** A path on this site (`/#/invite/<token>`) to hand to the invitee. */
  link: string;
}

/** `GET /auth/invitations/:token`: what the link holder is about to accept. */
export interface InvitationPreview {
  tenantName: string;
  role: InvitableRole;
  /** The workspace the invitation grants its role in. */
  workspaceName?: string;
  target: InvitationTargetView;
  /** For `oidc_email`: the provider to sign in with. */
  provider?: SsoProviderView;
  /** When the link stops working; absent from a Gateway older than migration 0047. */
  expiresAt?: IsoTimestamp;
}

/**
 * Why a known invitation link no longer works: `GET /auth/invitations/:token` and acceptance
 * answer 410 with this as `details.reason` (ADR-0022 amendment 4 I6).
 */
export type InvitationUnusableReason = "used" | "revoked" | "expired";

/**
 * `POST /auth/invitations/accept`. A new account needs a password; a `local_signup` invitation
 * also needs the username the recipient chose (`loginName`). `displayName` is optional and
 * defaults to the normalized login name, while older clients may continue sending it. A signed-in
 * browser accepting `local_signup` or `local_user` sends the token only.
 */
export interface AcceptInvitationRequest {
  token: string;
  loginName?: string;
  displayName?: string;
  password?: string;
}

/** `POST /api/accounts`: an Admin creates a local account in their tenant (amendment 4 I4). */
export interface CreateAccountRequest {
  loginName: string;
  /** Defaults to the normalized login name. */
  displayName?: string;
  role: InvitableRole;
  /** The workspace the role is granted in (ADR-0022 amendment 6 W9). */
  workspaceId?: string;
}

/** The answer to `POST /api/accounts`; the initial password is shown here once and never again. */
export interface CreatedAccountView {
  member: TenantMemberView;
  loginName: string;
  initialPassword: string;
}

// Service principals (ADR-0022 amendment 2): a tenant-scoped machine identity for an external
// agent client. It acts as a Member of exactly one tenant with an opaque bearer token on the
// operator listener; it is neither the operator credential nor a run token.

/** Every service principal token starts with this, so a reader or scrubber can recognise one. */
export const SERVICE_PRINCIPAL_TOKEN_PREFIX = "deskmates-sp.";

export type ServicePrincipalStatus = "active" | "disabled";

/** The tenant roles a service principal may carry: never `owner`. */
export type ServicePrincipalRole = "admin" | "member";

export function isServicePrincipalRole(value: unknown): value is ServicePrincipalRole {
  return value === "admin" || value === "member";
}

export interface ServicePrincipalView {
  id: string;
  tenantId: string;
  name: string;
  /**
   * Its tenant role, checked like a person's (ADR-0022 amendment 1 A10): at creation the
   * creating Admin's own role (an Owner's principal is `admin`), optionally lowered to `member`.
   * Never `owner`.
   */
  role: ServicePrincipalRole;
  status: ServicePrincipalStatus;
  /** Known (priced) USD its runs created today (UTC) may cost before it is refused. */
  dailyUsdCap: number;
  createdBy: string;
  createdAt: IsoTimestamp;
  /** When the current token was issued; null after a restore revoked it. */
  tokenIssuedAt: IsoTimestamp | null;
  disabledAt: IsoTimestamp | null;
}

/** `POST /api/service-principals` and `.../rotate`: the token is shown once, never again. */
export interface IssuedServicePrincipalView {
  servicePrincipal: ServicePrincipalView;
  token: string;
}
