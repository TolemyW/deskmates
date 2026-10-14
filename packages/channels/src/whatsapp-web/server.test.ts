import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebServer } from "./server.js";

const token = "operator-test-token-long-enough-for-tests";
let server: Server;
let base: string;
const session = {
  snapshot: () => ({
    phase: "qr" as const,
    account: null,
    qr: "data:image/png;base64,test-qr",
    qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    error: null,
    reconnects: 0,
    inboundFailures: 0,
  }),
  connect: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
};
beforeEach(async () => {
  vi.clearAllMocks();
  server = createWebServer(session, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(
  () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);
const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);

describe("connection page and operator API", () => {
  it("serves an inert shell without credential or QR disclosure", async () => {
    const res = await request("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Connect WhatsApp");
    expect(html).not.toContain(token);
    expect(html).not.toContain("test-qr");
    expect(html).not.toMatch(/localStorage|sessionStorage/);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects query tokens, wrong credentials and unauthenticated mutations", async () => {
    for (const [path, init] of [
      ["/api/status", {}],
      [`/api/status?token=${token}`, {}],
      ["/api/status", { headers: { authorization: "Bearer wrong" } }],
      ["/api/connect", { method: "POST" }],
      ["/api/logout", { method: "POST" }],
    ] as [string, RequestInit][]) {
      const res = await request(path, init);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("test-qr");
    }
    expect(session.connect).not.toHaveBeenCalled();
    expect(session.logout).not.toHaveBeenCalled();
  });
  it("returns the current QR only with Bearer authentication and no cache", async () => {
    const res = await request("/api/status", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: "qr", qr: "data:image/png;base64,test-qr" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects cross-origin requests even with a correct credential", async () => {
    const res = await request("/api/connect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(session.connect).not.toHaveBeenCalled();
  });
  it("starts and logs out only through authenticated POST", async () => {
    const headers = { authorization: `Bearer ${token}`, origin: base };
    expect((await request("/api/connect", { headers })).status).toBe(405);
    expect((await request("/api/connect", { method: "POST", headers })).status).toBe(200);
    expect((await request("/api/logout", { method: "POST", headers })).status).toBe(200);
    expect(session.connect).toHaveBeenCalledTimes(1);
    expect(session.logout).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized bodies without changing the connection", async () => {
    const res = await request("/api/connect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "x".repeat(1025),
    });
    expect(res.status).toBe(413);
    expect(session.connect).not.toHaveBeenCalled();
  });
});
