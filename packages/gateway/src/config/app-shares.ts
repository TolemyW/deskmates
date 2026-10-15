// Published workspace apps (ADR-0035 decision 2): off unless both URLs are set. The app base host
// is a DNS name of its own, so every publication gets an origin and cookie jar apart from the
// operator UI; the Gateway refuses to start when it is not.

import { isIP } from "node:net";
import { DeskmatesError } from "@deskmates/contracts";
import { type Env, optionalInt } from "./env.js";

export interface AppShareConfig {
  /** `<scheme>://<host>[:port]` of the app origins; a publication is `<label>.<host>`. */
  baseUrl: string;
  /** The operator UI's public origin: the only `Origin` an entry ticket is accepted from. */
  operatorOrigin: string;
  /** The app listener; it serves publications and nothing else. */
  port: number;
  bind: string;
}

export interface AppSharesConfig {
  appShares?: AppShareConfig;
}

function origin(key: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeskmatesError("validation", `${key} is not a URL`, { key });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new DeskmatesError("validation", `${key} must be an http(s) origin with no path`, {
      key,
    });
  return url;
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "").toLowerCase();

export function readAppSharesConfig(env: Env): AppSharesConfig {
  const base = env.APP_SHARE_BASE_URL?.trim() ?? "";
  const operator = env.APP_SHARE_OPERATOR_URL?.trim() ?? "";
  if (base === "" && operator === "") return {};
  if (base === "" || operator === "")
    throw new DeskmatesError(
      "validation",
      "APP_SHARE_BASE_URL and APP_SHARE_OPERATOR_URL are set together or not at all",
      { key: base === "" ? "APP_SHARE_BASE_URL" : "APP_SHARE_OPERATOR_URL" },
    );
  const baseUrl = origin("APP_SHARE_BASE_URL", base);
  const operatorUrl = origin("APP_SHARE_OPERATOR_URL", operator);
  const appHost = bare(baseUrl.hostname);
  const operatorHost = bare(operatorUrl.hostname);
  // A label goes in front of the base host, which an IP literal cannot take; and the operator
  // UI must not share the host or sit under it, or apps could reach its cookies.
  if (isIP(appHost) !== 0 || !appHost.includes("."))
    throw new DeskmatesError(
      "validation",
      "APP_SHARE_BASE_URL needs a DNS name with a parent, such as apps.localhost",
      { key: "APP_SHARE_BASE_URL" },
    );
  if (operatorHost === appHost || operatorHost.endsWith(`.${appHost}`))
    throw new DeskmatesError(
      "validation",
      "APP_SHARE_BASE_URL must not be the operator host or a parent of it",
      { key: "APP_SHARE_BASE_URL" },
    );
  return {
    appShares: {
      baseUrl: `${baseUrl.protocol}//${baseUrl.host}`,
      operatorOrigin: operatorUrl.origin,
      port: optionalInt(env, "APP_SHARE_PORT", 8790),
      bind: env.APP_SHARE_BIND?.trim() || "127.0.0.1",
    },
  };
}
