// The signed-in person's own account settings (ADR-0022 amendment 3, issue #26): display name,
// avatar and password. Every call acts on the session's own account; none names a user. Like the
// other clients it sends only the CSRF token (and tenant selector); the session is the HttpOnly
// cookie. Passwords pass through `changePassword` once and are never stored or logged here.

import type {
  AuthenticatedSessionView,
  AvatarContentType,
  IssuedServicePrincipalView,
  ProfileView,
} from "@deskmates/contracts";
import { type HttpBody, type HttpMethod, createHttpTransport } from "../platform/http-transport.js";

export interface AccountClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  csrfToken: () => string | undefined;
  tenantId?: string;
  onUnauthorized?: () => void;
}

export interface AccountClient {
  updateDisplayName(displayName: string): Promise<ProfileView>;
  uploadAvatar(image: Blob, contentType: AvatarContentType): Promise<ProfileView>;
  removeAvatar(): Promise<ProfileView>;
  /** `POST /auth/password`; the answer is the rotated session, with a new CSRF token. */
  changePassword(currentPassword: string, newPassword: string): Promise<AuthenticatedSessionView>;
  /**
   * `POST /api/service-principals`: a token for an agent the person runs (Account settings,
   * "Connect an agent"). Admins and Owners only; the token is in the answer once and nowhere else.
   */
  createAgentToken(name: string): Promise<IssuedServicePrincipalView>;
}

export function createAccountClient(options: AccountClientOptions): AccountClient {
  const t = createHttpTransport({ ...options, cache: "no-store" });
  // A wrong current password is 403 and a lost session is 401; only the latter signs out.
  const call = <T>(method: HttpMethod, path: string, body?: HttpBody) =>
    t.request<T>(method, path, body === undefined ? {} : { body });

  return {
    updateDisplayName: (displayName) =>
      call<ProfileView>("PATCH", "/auth/profile", { json: { displayName } }),
    uploadAvatar: (image, contentType) =>
      call<ProfileView>("PUT", "/auth/avatar", { blob: image, contentType }),
    removeAvatar: () => call<ProfileView>("DELETE", "/auth/avatar"),
    changePassword: (currentPassword, newPassword) =>
      call<AuthenticatedSessionView>("POST", "/auth/password", {
        json: { currentPassword, newPassword },
      }),
    createAgentToken: (name) =>
      call<IssuedServicePrincipalView>("POST", "/api/service-principals", { json: { name } }),
  };
}
