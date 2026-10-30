// Input checks for the Vault's operator routes (ADR-0045 decisions 1, 2 and 6). A refusal names
// the field and never echoes what was sent: a mistyped password must not come back in an error
// body, a log line or a toast (decision 7).

import {
  DeskmatesError,
  VAULT_ENTRY_TYPES,
  VAULT_NAME_MAX,
  VAULT_PARAMS_MAX,
  VAULT_PURPOSE_MAX,
  VAULT_REQUESTS_MAX,
  VAULT_REQUEST_METHODS,
  VAULT_VALUE_MAX,
  type VaultCredentialHeader,
  type VaultEntryType,
  type VaultRequestDefinition,
  type VaultRequestParam,
  vaultOrigin,
} from "@deskmates/contracts";

function refuse(field: string, message: string): never {
  throw new DeskmatesError("validation", message, { field });
}

export function vaultName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
  if (name === "" || name.length > VAULT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))
    refuse("name", `name must be 1 to ${VAULT_NAME_MAX} printable characters`);
  return name;
}

export function vaultPurpose(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > VAULT_PURPOSE_MAX)
    refuse("purpose", `purpose must be text of at most ${VAULT_PURPOSE_MAX} characters`);
  return value.trim() || undefined;
}

export function vaultType(value: unknown): VaultEntryType {
  if (!VAULT_ENTRY_TYPES.includes(value as VaultEntryType))
    refuse("type", `type must be one of ${VAULT_ENTRY_TYPES.join(", ")}`);
  return value as VaultEntryType;
}

export function vaultTargetOrigin(value: unknown): string {
  const origin = vaultOrigin(value);
  if (origin === undefined)
    refuse(
      "targetOrigin",
      "targetOrigin must be an exact https:// origin on a public hostname, with no path",
    );
  return origin;
}

export function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    refuse("expectedRevision", "expectedRevision must be the revision the edit started from");
  return value as number;
}

/**
 * A secret value: present, bounded, and without control characters, so it can neither break a
 * header line nor smuggle a second one (decision 6). Never echoed.
 */
function secretValue(field: string, value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) refuse(field, `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > VAULT_VALUE_MAX)
    refuse(field, `${field} must be text of at most ${VAULT_VALUE_MAX} characters`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
  if (/[\u0000-\u001f\u007f]/.test(value)) refuse(field, `${field} contains a control character`);
  return value;
}

/** The decrypted payload of one entry. Lives in memory for one use only. */
export type VaultPayload = { username: string; password: string } | { token: string };

/** The payload a create or replace stores, checked against the entry's type. */
export function vaultPayload(type: VaultEntryType, body: Record<string, unknown>): VaultPayload {
  if (type === "browser_login") {
    if (body.token !== undefined) refuse("token", "a browser login takes a username and password");
    return {
      username: secretValue("username", body.username, false) ?? "",
      password: secretValue("password", body.password, true) as string,
    };
  }
  if (body.username !== undefined || body.password !== undefined)
    refuse("password", "an HTTP header token takes a token");
  return { token: secretValue("token", body.token, true) as string };
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Headers the host owns or that would change the transport; never a credential header. */
const RESERVED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

function param(raw: unknown, index: number): VaultRequestParam {
  const field = `requests.params[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    refuse(field, "a parameter is an object");
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || !PARAM_NAME.test(p.name))
    refuse(field, "a parameter name is a short identifier");
  if (!["path", "query", "body"].includes(p.in as string))
    refuse(field, "a parameter is in path, query or body");
  if (!["string", "integer", "number", "boolean"].includes(p.type as string))
    refuse(field, "a parameter type is string, integer, number or boolean");
  const out: VaultRequestParam = {
    name: p.name,
    in: p.in as VaultRequestParam["in"],
    type: p.type as VaultRequestParam["type"],
  };
  if (p.required !== undefined) {
    if (typeof p.required !== "boolean") refuse(field, "required is a boolean");
    out.required = p.required;
  }
  if (out.in === "path") out.required = true;
  if (p.maxLength !== undefined) {
    if (
      !Number.isSafeInteger(p.maxLength) ||
      (p.maxLength as number) < 1 ||
      (p.maxLength as number) > 4096
    )
      refuse(field, "maxLength is 1 to 4096");
    out.maxLength = p.maxLength as number;
  }
  if (p.pattern !== undefined) {
    if (typeof p.pattern !== "string" || p.pattern.length > 200) refuse(field, "pattern is text");
    try {
      new RegExp(p.pattern);
    } catch {
      refuse(field, "pattern is not a regular expression");
    }
    out.pattern = p.pattern;
  }
  if (p.enum !== undefined) {
    if (
      !Array.isArray(p.enum) ||
      p.enum.length === 0 ||
      p.enum.length > 50 ||
      !p.enum.every((v) => typeof v === "string" && v.length <= 200)
    )
      refuse(field, "enum is a list of strings");
    out.enum = [...(p.enum as string[])];
  }
  if (out.type !== "string" && (out.pattern || out.enum || out.maxLength))
    refuse(field, "pattern, enum and maxLength apply to strings only");
  return out;
}

function header(raw: unknown): VaultCredentialHeader {
  if (!raw || typeof raw !== "object") refuse("requests.header", "header is an object");
  const h = raw as Record<string, unknown>;
  if (h.scheme === "bearer") return { scheme: "bearer" };
  if (h.scheme === "header") {
    const name = typeof h.name === "string" ? h.name : "";
    if (
      !HEADER_NAME.test(name) ||
      RESERVED_HEADERS.has(name.toLowerCase()) ||
      /^(proxy-|sec-)/i.test(name)
    )
      refuse("requests.header", "the credential header name is not allowed");
    return { scheme: "header", name };
  }
  return refuse("requests.header", "header scheme is bearer or header");
}

/** One request definition as an operator saved it (decision 6). `id` is assigned by the store. */
export function requestDefinition(
  raw: unknown,
  index: number,
): Omit<VaultRequestDefinition, "id"> & { id?: string } {
  const field = `requests[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    refuse(field, "a definition is an object");
  const d = raw as Record<string, unknown>;
  const name = typeof d.name === "string" ? d.name.trim() : "";
  if (name === "" || name.length > VAULT_NAME_MAX) refuse(field, "a definition needs a name");
  const method = d.method as VaultRequestDefinition["method"];
  if (!VAULT_REQUEST_METHODS.includes(method))
    refuse(field, `method is one of ${VAULT_REQUEST_METHODS.join(", ")}`);
  const path = typeof d.path === "string" ? d.path : "";
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 300 ||
    /[?#\s\\]/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === ".")
  )
    refuse(field, "path is an absolute route with no query, fragment or dot segment");
  if (!Array.isArray(d.params ?? [])) refuse(field, "params is a list");
  const params = ((d.params ?? []) as unknown[]).map(param);
  if (params.length > VAULT_PARAMS_MAX) refuse(field, `at most ${VAULT_PARAMS_MAX} parameters`);
  if (new Set(params.map((p) => p.name)).size !== params.length)
    refuse(field, "parameter names are unique");
  const placeholders = [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  const pathParams = params.filter((p) => p.in === "path").map((p) => p.name);
  if (
    placeholders.length !== pathParams.length ||
    !placeholders.every((name) => pathParams.includes(name))
  )
    refuse(field, "every {placeholder} in the path is exactly one path parameter");
  if (method === "GET" && params.some((p) => p.in === "body"))
    refuse(field, "a GET request has no body parameters");
  if (d.effect !== "read" && d.effect !== "write") refuse(field, "effect is read or write");
  const description =
    typeof d.description === "string" && d.description.trim() !== ""
      ? d.description.trim().slice(0, VAULT_PURPOSE_MAX)
      : undefined;
  return {
    ...(typeof d.id === "string" && d.id !== "" ? { id: d.id } : {}),
    name,
    ...(description ? { description } : {}),
    method,
    path,
    params,
    header: header(d.header),
    effect: d.effect,
  };
}

export function requestDefinitions(
  raw: unknown,
): Array<Omit<VaultRequestDefinition, "id"> & { id?: string }> {
  if (!Array.isArray(raw)) refuse("requests", "requests is a list");
  if (raw.length > VAULT_REQUESTS_MAX)
    refuse("requests", `at most ${VAULT_REQUESTS_MAX} request definitions`);
  const out = raw.map(requestDefinition);
  if (new Set(out.map((d) => d.name)).size !== out.length)
    refuse("requests", "request names are unique");
  return out;
}

/**
 * The model's parameter values checked against a definition (decision 6): only declared names,
 * of the declared type and shape. Returns the error message, or undefined when they are valid.
 */
export function paramsProblem(
  definition: VaultRequestDefinition,
  params: Record<string, unknown>,
): string | undefined {
  const declared = new Map(definition.params.map((p) => [p.name, p]));
  for (const name of Object.keys(params))
    if (!declared.has(name)) return `parameter ${name.slice(0, 64)} is not part of this request`;
  for (const p of definition.params) {
    const value = params[p.name];
    if (value === undefined) {
      if (p.required) return `parameter ${p.name} is required`;
      continue;
    }
    if (p.type === "boolean" && typeof value !== "boolean")
      return `parameter ${p.name} is a boolean`;
    if (p.type === "integer" && !Number.isSafeInteger(value))
      return `parameter ${p.name} is an integer`;
    if (p.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
      return `parameter ${p.name} is a number`;
    if (p.type === "string") {
      if (typeof value !== "string") return `parameter ${p.name} is a string`;
      if (value.length > (p.maxLength ?? 256)) return `parameter ${p.name} is too long`;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
      if (/[\u0000-\u001f\u007f]/.test(value)) return `parameter ${p.name} has a control character`;
      if (p.enum && !p.enum.includes(value)) return `parameter ${p.name} is not an allowed value`;
      if (p.pattern && !new RegExp(`^(?:${p.pattern})$`).test(value))
        return `parameter ${p.name} does not match its pattern`;
      if (p.in === "path" && value === "") return `parameter ${p.name} is empty`;
      // `encodeURIComponent` leaves `.` and `..` alone, and a URL resolves them as dot segments:
      // `/v1/items/..` is `/v1/`. A path value stays one plain segment (decision 6).
      if (p.in === "path" && (value === "." || value === ".." || /[/%]/.test(value)))
        return `parameter ${p.name} is not a plain path segment`;
    }
  }
  return undefined;
}
