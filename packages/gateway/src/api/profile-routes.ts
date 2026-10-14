// Self-service account settings (ADR-0022 amendment 3, issue #26). A signed-in person changes
// their own display name and avatar. Registered inside the operator authentication scope, so the
// session cookie, same-origin and CSRF checks apply as for any `/api` mutation; every route has
// the `authenticated` policy. No route takes a user id: the account is always the caller's.
// The operator credential and service principals have no person and are refused with 400.
//
// The avatar is the raw request body (`image/png`, `image/jpeg` or `image/webp`), stored as a BLOB
// and served back only to its owner. Password change stays `POST /auth/password` (auth-routes).

import {
  AVATAR_MAX_BYTES,
  DeskmatesError,
  type ProfileView,
  type UpdateProfileRequest,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { avatarUrl, checkAvatar, normalizeDisplayName } from "../auth/profile.js";
import type { GatewayContext } from "../context.js";

/** The person behind the request; the operator credential and service principals have none. */
function callerUserId(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal?.kind !== "user")
    throw new DeskmatesError("validation", "only a signed-in person has a profile", {
      reason: "no_user",
    });
  return principal.userId;
}

function parseProfileChange(body: unknown): UpdateProfileRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new DeskmatesError("validation", "body must be an object");
  const extra = Object.keys(body).filter((key) => key !== "displayName");
  if (extra.length > 0)
    throw new DeskmatesError("validation", `unknown field ${extra[0]}`, {
      reason: "unknown_field",
    });
  return { displayName: normalizeDisplayName((body as Record<string, unknown>).displayName) };
}

export function registerProfileRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const users = ctx.auth.users;
  const profile = (userId: string): ProfileView => {
    const user = users.getUser(userId);
    if (!user) throw new DeskmatesError("not_found", "user not found");
    const avatar = users.avatarMeta(userId);
    return { displayName: user.displayName, avatarUrl: avatar ? avatarUrl(avatar.sha256) : null };
  };

  app.patch("/auth/profile", async (request, reply): Promise<ProfileView> => {
    reply.header("cache-control", "no-store");
    const userId = callerUserId(request);
    const change = parseProfileChange(request.body);
    users.setDisplayName(userId, change.displayName);
    return profile(userId);
  });

  app.delete("/auth/avatar", async (request, reply): Promise<ProfileView> => {
    reply.header("cache-control", "no-store");
    const userId = callerUserId(request);
    users.removeAvatar(userId);
    return profile(userId);
  });

  app.get("/auth/avatar", async (request, reply) => {
    const userId = callerUserId(request);
    const avatar = users.getAvatar(userId);
    reply.header("cache-control", "no-store");
    if (!avatar) throw new DeskmatesError("not_found", "no avatar");
    // The bytes were signature-checked on upload; these headers keep a browser from treating
    // them as anything but an image of the stored type, even when opened directly.
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    reply.header("content-disposition", "inline");
    reply.type(avatar.contentType);
    return reply.send(avatar.bytes);
  });

  // The upload's parser takes any `image/*` body as raw bytes, up to the limit, only for this
  // route; the handler decides which types it accepts so a refusal is a clear 400, not a 415.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      /^image\/[a-z0-9.+-]+$/i,
      { parseAs: "buffer", bodyLimit: AVATAR_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.put("/auth/avatar", async (request, reply): Promise<ProfileView> => {
      reply.header("cache-control", "no-store");
      const userId = callerUserId(request);
      const type = checkAvatar(request.headers["content-type"], request.body);
      users.setAvatar(userId, type, request.body as Buffer);
      return profile(userId);
    });
  });
}
