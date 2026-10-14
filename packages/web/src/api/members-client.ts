// Tenant membership, invitations, SSO and tenant switching (ADR-0022 P4). Kept apart from the
// operator `ApiClient` so screens that never manage people do not depend on it. Like every
// client here it sends only the CSRF token and the tenant selector; the session is the HttpOnly
// cookie the browser holds.

import type {
  AuthSessionView,
  AuthenticatedSessionView,
  CreateAccountRequest,
  CreateInvitationRequest,
  CreatedAccountView,
  CreatedInvitationView,
  InvitationPreview,
  InvitationsPage,
  MembersPage,
  OidcStartRequest,
  OidcStartResponse,
  TenantMemberView,
  TenantRole,
  UpdateMemberRequest,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
  UserPreferences,
} from "@deskmates/contracts";
import { PAGE_LIMIT_MAX } from "@deskmates/contracts";
import { createHttpTransport } from "../platform/http-transport.js";

export interface MembersClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  csrfToken?: () => string | undefined;
  tenantId?: string;
  onUnauthorized?: () => void;
}

/**
 * People are managed per workspace (ADR-0022 amendment 6 W9): every call names one, as a query
 * parameter on reads and in the body of writes. Without one the Gateway acts on the tenant's only
 * workspace and answers 400 `workspace_required` when there are several.
 */
export interface MembersClient {
  /**
   * Every person of the workspace, read 100 a page until the total (#113 slice M): for name
   * maps such as the actor directory, never for a list a person pages through.
   */
  listMembers(workspaceId?: string): Promise<TenantMemberView[]>;
  /** One page of the workspace's people, optionally of one role or status (#113 slice M). */
  pageMembers(workspaceId: string | undefined, page: MembersPageRequest): Promise<MembersPage>;
  updateMember(userId: string, change: UpdateMemberRequest): Promise<void>;
  /** One page of the workspace's invitations, newest first (#113 slice M). */
  pageInvitations(
    workspaceId: string | undefined,
    page: { offset?: number; limit?: number },
  ): Promise<InvitationsPage>;
  createInvitation(input: CreateInvitationRequest): Promise<CreatedInvitationView>;
  revokeInvitation(id: string, workspaceId?: string): Promise<void>;
  /**
   * An Admin creates a local account (ADR-0022 amendment 4); the answer carries the initial
   * password once. The caller shows it and forgets it; nothing here keeps it.
   */
  createAccount(input: CreateAccountRequest): Promise<CreatedAccountView>;
  /** The signed-in person's own UI preferences (issue #22); every preference after the change. */
  updatePreferences(change: UpdatePreferencesRequest): Promise<UserPreferences>;
}

/** Sign-in calls that work before or across tenants. */
export interface SessionFlows {
  /** `GET /auth/session` as a tab in `tenantId` sees it. */
  getSession(tenantId?: string): Promise<AuthSessionView>;
  startSso(providerId: string, request: OidcStartRequest, csrf: string): Promise<OidcStartResponse>;
  previewInvitation(token: string): Promise<InvitationPreview>;
  acceptInvitation(
    body: { token: string; loginName?: string; displayName?: string; password?: string },
    csrf: string,
  ): Promise<AuthenticatedSessionView | { joined: true; tenantId: string }>;
}

function call<T>(
  options: MembersClientOptions,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  extra: { csrf?: string; tenantId?: string } = {},
): Promise<T> {
  return createHttpTransport({ ...options, cache: "no-store" }).request<T>(method, path, {
    ...extra,
    ...(body === undefined ? {} : { body: { json: body } }),
  });
}

/** A People page request (#113 slice M); every key optional, the Gateway's defaults apply. */
export interface MembersPageRequest {
  offset?: number;
  limit?: number;
  role?: TenantRole;
  status?: TenantMemberView["status"];
}

/** `?workspaceId=&role=&status=&offset=&limit=`, with only the keys that are set. */
function pageQuery(workspaceId: string | undefined, page: MembersPageRequest = {}): string {
  const params = new URLSearchParams();
  if (workspaceId !== undefined) params.set("workspaceId", workspaceId);
  if (page.role !== undefined) params.set("role", page.role);
  if (page.status !== undefined) params.set("status", page.status);
  if (page.offset !== undefined && page.offset > 0) params.set("offset", String(page.offset));
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function createMembersClient(options: MembersClientOptions = {}): MembersClient {
  return {
    listMembers: async (workspaceId) => {
      const all: TenantMemberView[] = [];
      for (;;) {
        const page = await call<Partial<MembersPage>>(
          options,
          "GET",
          `/api/members${pageQuery(workspaceId, {
            ...(all.length > 0 ? { offset: all.length } : {}),
            limit: PAGE_LIMIT_MAX,
          })}`,
        );
        const rows = page.members ?? [];
        all.push(...rows);
        // An older Gateway answers the whole list with no total: that is everything.
        if (rows.length === 0 || page.total === undefined || all.length >= page.total) return all;
      }
    },
    pageMembers: (workspaceId, page) =>
      call(options, "GET", `/api/members${pageQuery(workspaceId, page)}`),
    updateMember: async (userId, change) => {
      await call(options, "PATCH", `/api/members/${encodeURIComponent(userId)}`, change);
    },
    pageInvitations: (workspaceId, page) =>
      call(options, "GET", `/api/invitations${pageQuery(workspaceId, page)}`),
    createInvitation: (input) => call(options, "POST", "/api/invitations", input),
    revokeInvitation: async (id, workspaceId) => {
      await call(
        options,
        "DELETE",
        `/api/invitations/${encodeURIComponent(id)}`,
        workspaceId === undefined ? undefined : { workspaceId },
      );
    },
    createAccount: (input) => call(options, "POST", "/api/accounts", input),
    updatePreferences: async (change) =>
      (await call<UpdatePreferencesResponse>(options, "PATCH", "/auth/preferences", change))
        .preferences,
  };
}

export function createSessionFlows(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): SessionFlows {
  return {
    getSession: (tenantId) =>
      call(options, "GET", "/auth/session", undefined, tenantId ? { tenantId } : {}),
    startSso: (providerId, request, csrf) =>
      call(options, "POST", `/auth/oidc/${encodeURIComponent(providerId)}/start`, request, {
        csrf,
      }),
    previewInvitation: (token) =>
      call(options, "GET", `/auth/invitations/${encodeURIComponent(token)}`),
    acceptInvitation: (body, csrf) =>
      call(options, "POST", "/auth/invitations/accept", body, { csrf }),
  };
}
