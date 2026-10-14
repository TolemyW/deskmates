export interface Api {
  baseUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export function createApi(base: string, token: string, fetchImpl = fetch): Api {
  const url = new URL(base);
  if (
    !token ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Set SCENARIO_GATEWAY_URL to an HTTP(S) origin and SCENARIO_OPERATOR_TOKEN to its operator token",
    );
  }
  return {
    baseUrl: url.origin,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (!path.startsWith("/api/")) throw new Error("Only operator API paths are supported");
      let response: Response;
      try {
        response = await fetchImpl(`${url.origin}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new Error(
          `${method} ${path}: transport failed; outcome may be unknown, do not retry writes automatically`,
        );
      }
      if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
      return response.json() as Promise<T>;
    },
  };
}

export const segment = (value: string): string => encodeURIComponent(value);
