// Model endpoint configuration for T3. Read from the environment, falling back to the repo-root
// `.env` for values the shell did not export (the Gateway's `main()` reads the same file). No
// model name is ever a literal here: a missing variable makes the T3 suites skip by name.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MODEL_ENV_KEYS = [
  "MODEL_BASE_URL",
  "MODEL_AUTH_TOKEN",
  "DEFAULT_MODEL",
  "CHEAP_MODEL",
] as const;

export interface ModelEnv {
  modelBaseUrl: string;
  modelAuthToken: string;
  defaultModel: string;
  cheapModel: string;
}

let dotEnvLoaded = false;

/** Fill unset variables from `<repo>/.env`, once. Exported variables always win. */
export function loadDotEnv(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const file = join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}

/** Names of the T3 variables that are unset or empty. */
export function missingModelEnv(): string[] {
  loadDotEnv();
  return MODEL_ENV_KEYS.filter((k) => (process.env[k] ?? "").trim() === "");
}

/** The four T3 variables; throws with the missing names so a test cannot run half-configured. */
export function modelEnv(): ModelEnv {
  const missing = missingModelEnv();
  if (missing.length > 0) {
    throw new Error(`T3 needs ${missing.join(", ")} (see .env.example)`);
  }
  const get = (k: (typeof MODEL_ENV_KEYS)[number]): string => (process.env[k] ?? "").trim();
  return {
    modelBaseUrl: get("MODEL_BASE_URL").replace(/\/+$/, ""),
    modelAuthToken: get("MODEL_AUTH_TOKEN"),
    defaultModel: get("DEFAULT_MODEL"),
    cheapModel: get("CHEAP_MODEL"),
  };
}

/** Suffix for a `describe` title so a skipped T3 suite says what it needs. */
export function skipReason(missing: readonly string[], dockerUp: boolean): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`set ${missing.join(", ")}`);
  if (!dockerUp) parts.push("start Docker (colima start)");
  return parts.length > 0 ? ` [skipped: ${parts.join("; ")}]` : "";
}
