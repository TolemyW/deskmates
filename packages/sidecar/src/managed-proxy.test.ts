import { once } from "node:events";
import { type Server, createServer } from "node:http";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOOPBACK_NO_PROXY,
  browserChildEnvironment,
  installManagedFetchProxy,
  managedProxyEnvironment,
  managedProxyUrl,
} from "./managed-proxy.js";

describe("managed sidecar proxy", () => {
  const originalDispatcher = getGlobalDispatcher();
  afterEach(async () => {
    const current = getGlobalDispatcher();
    setGlobalDispatcher(originalDispatcher);
    if (current !== originalDispatcher) await current.close();
  });

  it("derives both proxy variable spellings from one controlled value and bypasses only loopback", () => {
    const env = {
      DESKMATES_EGRESS_PROXY: "http://proxy.internal:3128",
      HTTP_PROXY: "http://attacker.test:8080",
      https_proxy: "http://attacker.test:8080",
      ALL_PROXY: "http://attacker.test:8080",
      NO_PROXY: "host.docker.internal,localhost",
      ANTHROPIC_AUTH_TOKEN: "short-lived-model-token",
    };
    expect(managedProxyUrl(env)).toBe("http://proxy.internal:3128");
    expect(managedProxyEnvironment(env)).toEqual({
      HTTP_PROXY: "http://proxy.internal:3128",
      HTTPS_PROXY: "http://proxy.internal:3128",
      http_proxy: "http://proxy.internal:3128",
      https_proxy: "http://proxy.internal:3128",
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    });
    const child = browserChildEnvironment(env);
    expect(child).toMatchObject(managedProxyEnvironment(env));
    expect(child).not.toHaveProperty("ALL_PROXY");
    expect(child).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(child.NO_PROXY).not.toContain("host.docker.internal");
  });

  it.each([
    "http://user:password@proxy.internal:3128",
    "https://proxy.internal:3128",
    "http://proxy.internal",
    "http://proxy.internal:3128/path",
    "not a URL",
  ])("rejects invalid managed proxy URL %s", (value) => {
    expect(() => managedProxyUrl({ DESKMATES_EGRESS_PROXY: value })).toThrow();
  });

  it("routes reserved host fetch through the proxy while keeping loopback direct", async () => {
    const seen: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      seen.push(request.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (data) => {
        seen.push(String(data).split("\r\n", 1)[0] ?? "");
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied");
      });
    });
    const local = createServer((_request, response) => response.end("local"));
    const ipv6Local = createServer((_request, response) => response.end("ipv6-local"));
    proxy.listen(0, "127.0.0.1");
    local.listen(0, "127.0.0.1");
    await Promise.all([once(proxy, "listening"), once(local, "listening")]);
    // A host without an IPv6 loopback cannot bind ::1; the IPv6 case is skipped there and every
    // other assertion still runs (issue #25).
    const ipv6Available = await listenOrUnavailable(ipv6Local, "::1");
    try {
      const proxyPort = (proxy.address() as { port: number }).port;
      const localPort = (local.address() as { port: number }).port;
      installManagedFetchProxy({ DESKMATES_EGRESS_PROXY: `http://127.0.0.1:${proxyPort}` });
      expect(await (await fetch("http://host.docker.internal:45678/internal/probe")).text()).toBe(
        "proxied",
      );
      expect(await (await fetch(`http://127.0.0.1:${localPort}/local`)).text()).toBe("local");
      if (ipv6Available) {
        const ipv6Port = (ipv6Local.address() as { port: number }).port;
        expect(await (await fetch(`http://[::1]:${ipv6Port}/local`)).text()).toBe("ipv6-local");
      }
      expect(seen).toEqual(["host.docker.internal:45678", "GET /internal/probe HTTP/1.1"]);
    } finally {
      proxy.closeAllConnections();
      local.closeAllConnections();
      ipv6Local.closeAllConnections();
      proxy.close();
      local.close();
      if (ipv6Available) ipv6Local.close();
    }
  });
});

/** Listens on `host`; false when the host has no such address family or address (no IPv6). */
async function listenOrUnavailable(server: Server, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") resolve(false);
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}
