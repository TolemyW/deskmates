// Environment readers shared by the per-domain config readers. Each throws a `validation` error
// naming the variable, so a typo stops startup where an operator sees it.

import { DeskmatesError } from "@deskmates/contracts";

export type Env = NodeJS.ProcessEnv;

export function required(env: Env, key: string): string {
  const v = env[key]?.trim();
  if (v === undefined || v === "") {
    throw new DeskmatesError("validation", `${key} is required in the environment`, { key });
  }
  return v;
}

export function optionalInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DeskmatesError("validation", `${key} must be a positive integer`, { key, raw });
  }
  return n;
}

/** Like `optionalInt`, but 0 is allowed: it switches a limit off. */
export function optionalLimit(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DeskmatesError("validation", `${key} must be 0 (off) or a positive integer`, {
      key,
      raw,
    });
  }
  return n;
}

/** A CPU core count: 0 (no limit) or a positive number, fractions allowed. */
export function optionalCores(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new DeskmatesError("validation", `${key} must be 0 (no limit) or a positive number`, {
      key,
      raw,
    });
  }
  return n;
}

export function httpUrl(key: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeskmatesError("validation", `${key} is not a URL`, { key });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new DeskmatesError("validation", `${key} must be http or https`, { key });
  if (url.username || url.password)
    throw new DeskmatesError("validation", `${key} must not carry credentials`, { key });
  return raw.replace(/\/+$/, "");
}

/** An optional non-empty value: absent or blank leaves the key out entirely. */
export function optionalValue<K extends string>(
  env: Env,
  name: string,
  key: K,
): Partial<Record<K, string>> {
  const value = env[name]?.trim();
  return value ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}
