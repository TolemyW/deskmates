// The app listener (ADR-0035 decisions 2 to 6): one origin per publication, the entry handshake,
// and a byte-level forward to the workspace service through the egress proxy's app relay. It
// serves nothing else: not the operator API, not the UI, not another publication's content.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { GatewayContext } from "../context.js";
import { type AppShareModule, GRANT_MS, appCookieName, appSharesOf } from "./app-share-module.js";
import type { AppShareRow } from "./app-share-store.js";
import { RelayError, connectRelay } from "./relay-client.js";

const ENTER_PATH = "/__deskmates/enter";
const ENTER_BODY_MAX = 4096;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Hop-by-hop headers (RFC 9110 section 7.6.1) never cross the proxy. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Deskmates's own cookie names; never forwarded to an app and never set by one. */
const DESKMATES_COOKIE = /^(__host-|__secure-)?deskmates[-_]/i;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function sendPage(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(page(title, body));
}

/** Every value of cookie `name` in a Cookie header; duplicates are all returned. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
}

/** The Cookie header without Deskmates's cookies (decision 5); undefined when nothing is left. */
export function appCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !DESKMATES_COOKIE.test(part.split("=")[0] ?? ""));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/**
 * An app's `Set-Cookie` values with every `Domain` attribute removed, so they stay host-only, and
 * any naming a Deskmates cookie dropped (decision 5).
 */
export function appSetCookies(values: readonly string[]): string[] {
  return values
    .filter((value) => !DESKMATES_COOKIE.test(value.split("=")[0]?.trim() ?? ""))
    .map((value) =>
      value
        .split(";")
        .filter((attr, i) => i === 0 || !/^\s*domain\s*=/i.test(attr))
        .join(";"),
    );
}

export interface AppIngress {
  server: http.Server;
  close(): Promise<void>;
}

/** Resolve the publication a `Host` header names, or undefined (decision 2). */
function shareForHost(
  shares: AppShareModule,
  baseHost: string,
  host: string | undefined,
): AppShareRow | undefined {
  const value = (host ?? "").toLowerCase();
  const suffix = `.${baseHost}`;
  if (!value.endsWith(suffix)) return undefined;
  const label = value.slice(0, -suffix.length);
  return shares.store.byLabel(label);
}

export function createAppIngress(ctx: GatewayContext): AppIngress {
  const shares = appSharesOf(ctx);
  const config = shares.enabled();
  const base = new URL(config.baseUrl);
  const baseHost = base.host.toLowerCase();
  const cookie = appCookieName(config.baseUrl);
  const secure = base.protocol === "https:";
  const live = new Set<Socket>();

  const resolve = (req: IncomingMessage) => {
    const row = shareForHost(shares, baseHost, req.headers.host);
    if (!row || row.revokedAt !== null) return undefined;
    return row;
  };

  const notFound = (res: ServerResponse) =>
    sendPage(res, 404, "Not found", "<p>No published app answers at this address.</p>");

  const entryHint = (res: ServerResponse, row: AppShareRow, path: string) => {
    // The web entry route `#/apps/<share>?ws=<workspace>&path=` (web features/app-shares/route.ts).
    const query = new URLSearchParams({ ws: row.workspaceId, path });
    const href = `${config.operatorOrigin}/#/apps/${encodeURIComponent(row.id)}?${query.toString()}`;
    sendPage(
      res,
      401,
      "Open this app from Deskmates",
      `<p>This app was published in a Deskmates workspace. Members of that workspace open it while signed in to Deskmates.</p><p><a href="${escapeHtml(href)}">Sign in and open it</a></p>`,
    );
  };

  const enter = (req: IncomingMessage, res: ServerResponse, row: AppShareRow) => {
    // The ticket comes only from the operator UI's own page (decision 3).
    if (req.method !== "POST" || req.headers.origin !== config.operatorOrigin) {
      sendPage(res, 403, "Not allowed", "<p>Open the app from Deskmates.</p>");
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > ENTER_BODY_MAX) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const redeemed = shares.redeem(row, form.get("ticket") ?? "");
      if (!redeemed) {
        sendPage(res, 403, "This link has expired", "<p>Open the app from Deskmates again.</p>");
        return;
      }
      res.writeHead(303, {
        location: redeemed.path,
        "set-cookie": `${cookie}=${redeemed.grant}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GRANT_MS / 1000}${secure ? "; Secure" : ""}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end();
    });
  };

  /** The request's grant, after the Origin rule for unsafe methods (decision 5). */
  const admitted = (req: IncomingMessage, row: AppShareRow, upgrade: boolean) => {
    const origin = req.headers.origin;
    const own = `${base.protocol}//${req.headers.host?.toLowerCase()}`;
    if (
      (upgrade || !SAFE_METHODS.has(req.method ?? "GET")) &&
      origin !== undefined &&
      origin !== own
    )
      return "cross_origin" as const;
    return shares.grantFor(row, cookieValues(req.headers.cookie, cookie)) ?? ("no_grant" as const);
  };

  const forwardHeaders = (
    req: IncomingMessage,
    upgrade: boolean,
  ): Record<string, string | string[]> => {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "cookie") continue;
      if (HOP_BY_HOP.has(name) && !(upgrade && (name === "upgrade" || name === "connection")))
        continue;
      headers[name] = value;
    }
    const cookies = appCookieHeader(req.headers.cookie);
    if (cookies) headers.cookie = cookies;
    headers["x-forwarded-proto"] = base.protocol.slice(0, -1);
    headers["x-forwarded-host"] = req.headers.host ?? "";
    if (!upgrade) headers.connection = "close";
    return headers;
  };

  const unavailable = (res: ServerResponse, err: unknown) => {
    const missing = err instanceof RelayError && err.reason === "relay_missing";
    sendPage(
      res,
      502,
      "This app is not running",
      missing
        ? "<p>The workspace is stopped or predates app sharing. Start the workspace and ask a bot to start the app again.</p>"
        : "<p>Nothing answers on the published port. Ask a bot to start the app again (listening on 0.0.0.0).</p>",
    );
  };

  const server = http.createServer((req, res) => {
    const row = resolve(req);
    if (!row) return notFound(res);
    const path = req.url ?? "/";
    if (path === ENTER_PATH || path.startsWith(`${ENTER_PATH}?`)) return enter(req, res, row);
    const grant = admitted(req, row, false);
    if (grant === "cross_origin")
      return sendPage(res, 403, "Not allowed", "<p>Cross-origin requests are refused.</p>");
    if (grant === "no_grant") {
      if (req.method === "GET" || req.method === "HEAD") return entryHint(res, row, path);
      return sendPage(res, 401, "Not signed in", "<p>Open the app from Deskmates.</p>");
    }
    void (async () => {
      let upstream: Socket;
      try {
        upstream = await connectRelay((await shares.relayTarget(row.workspaceId)) ?? {}, row.port);
      } catch (err) {
        unavailable(res, err);
        return;
      }
      shares.track(row.id, grant.sessionId, grant.tenantId, upstream);
      const proxied = http.request(
        {
          method: req.method,
          path,
          headers: forwardHeaders(req, false),
          // The relay sends nothing until the app answers the request written on this socket.
          createConnection: () => upstream.resume(),
        },
        (answer) => {
          const headers: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(answer.headers)) {
            if (value === undefined || HOP_BY_HOP.has(name)) continue;
            headers[name] =
              name === "set-cookie" ? appSetCookies(Array.isArray(value) ? value : [value]) : value;
          }
          res.writeHead(answer.statusCode ?? 502, headers);
          res.flushHeaders();
          answer.pipe(res);
          answer.on("error", () => res.destroy());
        },
      );
      proxied.on("error", () => {
        if (!res.headersSent) unavailable(res, new RelayError("not_running"));
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(proxied);
    })();
  });

  server.on("connection", (socket: Socket) => {
    live.add(socket);
    socket.once("close", () => live.delete(socket));
  });

  // WebSocket and any other upgrade: the same checks, then raw bytes both ways (decision 6).
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const row = resolve(req);
    if (!row) return refuse("404 Not Found");
    const grant = admitted(req, row, true);
    if (grant === "cross_origin") return refuse("403 Forbidden");
    if (grant === "no_grant") return refuse("401 Unauthorized");
    void (async () => {
      let upstream: Socket;
      try {
        upstream = await connectRelay((await shares.relayTarget(row.workspaceId)) ?? {}, row.port);
      } catch {
        refuse("502 Bad Gateway");
        return;
      }
      shares.track(row.id, grant.sessionId, grant.tenantId, upstream);
      const lines = [`${req.method} ${req.url ?? "/"} HTTP/1.1`];
      for (const [name, value] of Object.entries(forwardHeaders(req, true)))
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.resume();
    })();
  });

  return {
    server,
    close: () =>
      new Promise((done) => {
        for (const socket of live) socket.destroy();
        server.close(() => done());
      }),
  };
}
