// Browser sign-in and session settings (ADR-0022 P1).

import { DeskmatesError } from "@deskmates/contracts";
import { AUTH_CONFIG_DEFAULTS, type AuthConfig } from "../auth/auth-service.js";
import { PASSWORD_MAX_LENGTH } from "../auth/passwords.js";
import { type Env, optionalInt } from "./env.js";

export interface AuthSettings {
  /**
   * Browser sign-in and sessions (ADR-0022 P1). Omitted fields take `AUTH_CONFIG_DEFAULTS`:
   * `__Host-` Secure cookies, 7-day idle and 30-day absolute session expiry, same-origin
   * mutations, OWASP-baseline Argon2id.
   */
  auth?: Partial<AuthConfig>;
}

/**
 * ADR-0022 P1 session settings. `GATEWAY_SESSION_COOKIE=insecure-dev` is the explicit opt-out
 * of Secure cookies for plain-HTTP development; it renames the cookies so it cannot pass for the
 * production mode, and the Gateway logs a warning at startup when it is on.
 */
export function authConfig(env: Env): Partial<AuthConfig> {
  const mode = env.GATEWAY_SESSION_COOKIE?.trim() || "secure";
  if (mode !== "secure" && mode !== "insecure-dev")
    throw new DeskmatesError(
      "validation",
      "GATEWAY_SESSION_COOKIE must be secure or insecure-dev",
      {
        key: "GATEWAY_SESSION_COOKIE",
      },
    );
  const idle = optionalInt(
    env,
    "GATEWAY_SESSION_IDLE_TTL_SECONDS",
    AUTH_CONFIG_DEFAULTS.sessionIdleTtlSeconds,
  );
  const absolute = optionalInt(
    env,
    "GATEWAY_SESSION_ABSOLUTE_TTL_SECONDS",
    AUTH_CONFIG_DEFAULTS.sessionAbsoluteTtlSeconds,
  );
  if (idle > absolute)
    throw new DeskmatesError(
      "validation",
      "GATEWAY_SESSION_IDLE_TTL_SECONDS must not exceed GATEWAY_SESSION_ABSOLUTE_TTL_SECONDS",
    );
  const allowedOrigins = (env.GATEWAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new DeskmatesError("validation", "GATEWAY_ALLOWED_ORIGINS entries must be origins", {
          key: "GATEWAY_ALLOWED_ORIGINS",
        });
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value)
        throw new DeskmatesError(
          "validation",
          "GATEWAY_ALLOWED_ORIGINS entries must be bare http(s) origins such as https://deskmates.example",
          { key: "GATEWAY_ALLOWED_ORIGINS" },
        );
      return url.origin;
    });
  const memoryKiB = optionalInt(
    env,
    "AUTH_ARGON2_MEMORY_KIB",
    AUTH_CONFIG_DEFAULTS.argon2.memoryKiB,
  );
  // OWASP's lowest listed Argon2id memory (7 MiB); calibration may raise it, never go below.
  if (memoryKiB < 7168)
    throw new DeskmatesError("validation", "AUTH_ARGON2_MEMORY_KIB must be at least 7168", {
      key: "AUTH_ARGON2_MEMORY_KIB",
    });
  const passwordMinLength = optionalInt(
    env,
    "GATEWAY_PASSWORD_MIN_LENGTH",
    AUTH_CONFIG_DEFAULTS.passwordMinLength,
  );
  if (passwordMinLength < 1 || passwordMinLength > PASSWORD_MAX_LENGTH)
    throw new DeskmatesError(
      "validation",
      `GATEWAY_PASSWORD_MIN_LENGTH must be between 1 and ${PASSWORD_MAX_LENGTH}`,
      { key: "GATEWAY_PASSWORD_MIN_LENGTH" },
    );
  return {
    cookieMode: mode,
    sessionIdleTtlSeconds: idle,
    sessionAbsoluteTtlSeconds: absolute,
    allowedOrigins,
    passwordMinLength,
    argon2: {
      memoryKiB,
      iterations: optionalInt(
        env,
        "AUTH_ARGON2_ITERATIONS",
        AUTH_CONFIG_DEFAULTS.argon2.iterations,
      ),
      parallelism: optionalInt(
        env,
        "AUTH_ARGON2_PARALLELISM",
        AUTH_CONFIG_DEFAULTS.argon2.parallelism,
      ),
    },
  };
}
