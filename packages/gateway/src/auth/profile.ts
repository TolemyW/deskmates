// A person's own profile (ADR-0022 amendment 3): display name and avatar validation. Pure
// functions; storage is in `UserStore`, routes in `api/profile-routes.ts`.

import {
  AVATAR_MAX_BYTES,
  type AccountView,
  type AvatarContentType,
  DISPLAY_NAME_MAX_LENGTH,
  DeskmatesError,
  isAvatarContentType,
} from "@deskmates/contracts";
import type { UserStore } from "./user-store.js";

// C0 and C1 control characters, DEL included. A display name is shown in lists and messages, so
// nothing that moves the cursor or hides text is accepted.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** A display name as stored: trimmed, 1 to 128 characters, no control characters. */
export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string")
    throw new DeskmatesError("validation", "displayName must be a string");
  const name = raw.normalize("NFC").trim();
  if (name.length === 0) throw new DeskmatesError("validation", "display name is required");
  if ([...name].length > DISPLAY_NAME_MAX_LENGTH)
    throw new DeskmatesError(
      "validation",
      `display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
    );
  if (CONTROL.test(name))
    throw new DeskmatesError("validation", "display name must not contain control characters");
  return name;
}

function startsWith(bytes: Buffer, signature: ReadonlyArray<number>, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** Whether the bytes carry the file signature of `type`. */
function hasSignature(bytes: Buffer, type: AvatarContentType): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, PNG);
    case "image/jpeg":
      return startsWith(bytes, JPEG);
    case "image/webp":
      return startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8);
  }
}

/**
 * Check an uploaded avatar: an accepted type, a non-empty body within the limit, and a file
 * signature that matches the declared type. Anything else (SVG, GIF, a renamed file) is refused.
 */
export function checkAvatar(contentType: string | undefined, body: unknown): AvatarContentType {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!isAvatarContentType(type))
    throw new DeskmatesError("validation", "an avatar must be a PNG, JPEG or WebP image", {
      reason: "avatar_type",
    });
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw new DeskmatesError("validation", "the avatar image is empty", { reason: "avatar_empty" });
  if (body.length > AVATAR_MAX_BYTES)
    throw new DeskmatesError("payload_too_large", "the avatar image is too large", {
      reason: "avatar_size",
      maxBytes: AVATAR_MAX_BYTES,
    });
  if (!hasSignature(body, type))
    throw new DeskmatesError("validation", "the file is not the image type it claims to be", {
      reason: "avatar_type",
    });
  return type;
}

/** The URL the session view names for a stored avatar; a new image is a new URL. */
export function avatarUrl(sha256: string): string {
  return `/auth/avatar?v=${sha256.slice(0, 16)}`;
}

/**
 * Account facts for the settings page, from the account rows rather than from how this session
 * signed in or whether `loginName` is null (ADR-0022 amendment 3 P5).
 */
export function accountView(users: UserStore, userId: string, sessionLoginId: string): AccountView {
  const local = users.localPassword(userId);
  if (!local?.hasPassword)
    return { localLoginName: local?.loginName ?? null, password: "identity_provider" };
  const signedInWithPassword = users.getLogin(sessionLoginId)?.provider === "local";
  return {
    localLoginName: local.loginName,
    password: signedInWithPassword ? "available" : "sign_in_with_password",
  };
}
