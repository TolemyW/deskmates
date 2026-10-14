import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Server, createServer } from "node:http";
import { connectionPage } from "./page.js";
import type { WebSession } from "./session.js";

export function createWebServer(
  session: Pick<WebSession, "snapshot" | "connect" | "logout">,
  operatorToken: string,
): Server {
  const tokenHash = createHash("sha256").update(operatorToken).digest();
  return createServer((req, res) => {
    void handle().catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Connection operation failed" }));
    });
    async function handle(): Promise<void> {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/" && req.method === "GET") {
        const nonce = randomBytes(18).toString("base64");
        res.setHeader(
          "content-security-policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(connectionPage(nonce));
        return;
      }
      if (!url.pathname.startsWith("/api/")) return json(404, { error: "Not found" });
      const supplied = req.headers.authorization ?? "";
      const hash = createHash("sha256")
        .update(supplied.startsWith("Bearer ") ? supplied.slice(7) : "")
        .digest();
      if (!timingSafeEqual(hash, tokenHash)) return json(401, { error: "Unauthorized" });
      if (req.headers.origin) {
        let origin: URL;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          return json(403, { error: "Origin refused" });
        }
        if (origin.host !== req.headers.host || !["http:", "https:"].includes(origin.protocol)) {
          return json(403, { error: "Origin refused" });
        }
      }
      if (req.headers["sec-fetch-site"] === "cross-site")
        return json(403, { error: "Origin refused" });
      if (url.pathname === "/api/status" && req.method === "GET")
        return json(200, session.snapshot());
      if (req.method !== "POST") return json(405, { error: "Method not allowed" });
      // These operations have no payload; drain and cap untrusted bodies before mutation.
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk as Buffer);
        if (bytes > 1024) return json(413, { error: "Body too large" });
      }
      if (url.pathname === "/api/connect") await session.connect();
      else if (url.pathname === "/api/logout") await session.logout();
      else return json(404, { error: "Not found" });
      return json(200, session.snapshot());
    }
  });
}
