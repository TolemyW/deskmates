// The per-run environment file. `injectEnv` renders the map to `KEY=VALUE` lines and writes it
// to a tmpfs path inside the container (mode 0600, delivered over exec stdin, never argv or the
// container's create spec), so the short-lived model token is visible neither in `docker inspect`
// nor in the host's process list. The sidecar reads this file at start.
//
// Format: one `KEY=VALUE` per line, no quoting, no `export`, no comments, LF line endings,
// values taken verbatim up to the end of the line. Keys and values are validated so the file
// can be parsed by splitting on the first `=` of each line.

import { DeskmatesError } from "@deskmates/contracts";

/** Default location. The container gets a tmpfs mounted at its parent directory. */
export const ENV_FILE_PATH = "/run/deskmates/env";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function renderEnvFile(env: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const value = env[key] ?? "";
    if (!KEY_RE.test(key)) {
      throw new DeskmatesError("validation", `invalid environment variable name: ${key}`);
    }
    if (/[\n\r\0]/.test(value)) {
      throw new DeskmatesError("validation", `environment value for ${key} contains a line break`);
    }
    lines.push(`${key}=${value}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Inverse of renderEnvFile; the sidecar's reader must behave the same way. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}
