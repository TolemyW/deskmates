// Route Node fetch through the workspace's managed egress proxy. The SDK CLI and browser MCP
// run in separate processes, so they receive the same controlled proxy settings as environment.
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Undici matches the bracketed hostname for IPv6 URLs; curl also accepts the bare spelling.
export const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1],::1";

export function managedProxyUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env.DESKMATES_EGRESS_PROXY;
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DESKMATES_EGRESS_PROXY must be a valid HTTP proxy URL");
  }
  if (
    url.protocol !== "http:" ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("DESKMATES_EGRESS_PROXY must be an unauthenticated HTTP host:port URL");
  }
  return url.origin;
}

/** Never inherit an arbitrary HTTP_PROXY/NO_PROXY from the shared workspace environment. */
export function managedProxyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const proxy = managedProxyUrl(env);
  if (proxy === undefined) return {};
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
  };
}

/** Applies to GatewayClient, browser coordination, and every other Node global fetch call. */
export function installManagedFetchProxy(env: Readonly<Record<string, string | undefined>>): void {
  const proxy = managedProxyUrl(env);
  if (proxy === undefined) return;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: proxy,
      httpsProxy: proxy,
      noProxy: LOOPBACK_NO_PROXY,
    }),
  );
}

/** The browser MCP child must inherit no unrelated proxy settings from the workspace. */
export function browserChildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(?:http|https|all|no)_proxy$/i.test(key)) continue;
    if (key === "ANTHROPIC_AUTH_TOKEN" || key === "ANTHROPIC_API_KEY") continue;
    result[key] = value;
  }
  return { ...result, ...managedProxyEnvironment(env) };
}
