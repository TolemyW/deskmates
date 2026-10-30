// The built operator UI (`npm run build -w packages/web`), served by the operator listener when
// WEB_DIST_DIR is set. ADR-0006 decision 2 puts "the web UI in production" on that listener; the
// sandbox listener never registers this handler.
//
// The files are the public JavaScript bundle and hold no secret, so they need no credential. The
// handler is a GET wildcard on the root app, outside the authenticated `/api` scope: Fastify
// matches a registered route before a wildcard, so every `/api/*` route keeps its operator-auth
// hook, and a request that reaches this handler for an `/api`, `/analytics` (the Grafana relay),
// `/hooks` or sandbox-listener path gets the ordinary 404 rather than the UI.

import { realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { DeskmatesError } from "@deskmates/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

/** Paths that belong to an API family (either listener). They are never answered with the UI. */
const RESERVED_PATH = /^\/(?:analytics|api|hooks|internal|v1|healthz)(?:\/|$)/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** Vite writes content-hashed file names under `assets/`; a changed file gets a new name. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Resolve WEB_DIST_DIR to a real directory that contains `index.html`, or fail startup with a
 * message naming the variable. Returns the canonical path used for every containment check.
 */
export function resolveWebDistDir(dir: string): string {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new DeskmatesError(
      "validation",
      `WEB_DIST_DIR ${dir} does not exist or is not a directory; build the UI with npm run build -w packages/web or unset WEB_DIST_DIR`,
      { key: "WEB_DIST_DIR" },
    );
  }
  let hasIndex = false;
  try {
    hasIndex = statSync(join(root, "index.html")).isFile();
  } catch {
    hasIndex = false;
  }
  if (!hasIndex) {
    throw new DeskmatesError(
      "validation",
      `WEB_DIST_DIR ${dir} has no index.html; build the UI with npm run build -w packages/web or unset WEB_DIST_DIR`,
      { key: "WEB_DIST_DIR" },
    );
  }
  return root;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Register the static UI on the operator listener. `root` comes from `resolveWebDistDir`. */
export function registerStaticUi(app: FastifyInstance, root: string): void {
  const indexPath = join(root, "index.html");

  const send = async (reply: FastifyReply, file: string, cacheControl: string) => {
    const body = await readFile(file);
    return reply
      .header(
        "content-type",
        CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      )
      .header("cache-control", cacheControl)
      .header("x-content-type-options", "nosniff")
      .send(body);
  };

  const notFound = (reply: FastifyReply) => {
    reply.callNotFound();
    return reply;
  };

  app.get("/*", async (request, reply) => {
    const rawPath = request.url.split("?", 1)[0] ?? "/";
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      throw new DeskmatesError("validation", "malformed request path");
    }
    if (RESERVED_PATH.test(pathname) || RESERVED_PATH.test(rawPath)) return notFound(reply);
    // No dot segments, hidden files, backslashes or NUL bytes, in any encoding: a traversal
    // attempt is refused outright rather than normalised into something that might exist.
    if (pathname.includes("\0") || pathname.includes("\\")) return notFound(reply);
    const segments = pathname.split("/").filter((s) => s !== "");
    if (segments.some((s) => s.startsWith("."))) return notFound(reply);
    if (segments.length === 0) return send(reply, indexPath, "no-cache");

    const candidate = join(root, ...segments);
    if (!inside(root, candidate)) return notFound(reply);
    let file: string | undefined;
    try {
      const real = await realpath(candidate);
      // A symlink inside the directory must not lead out of it.
      if (inside(root, real) && (await stat(real)).isFile()) file = real;
    } catch {
      file = undefined;
    }
    if (file !== undefined) {
      if (file === indexPath) return send(reply, file, "no-cache");
      return send(reply, file, segments[0] === "assets" ? IMMUTABLE : "no-cache");
    }
    // A missing asset or file-like path is a 404: answering a script request with HTML would
    // hide a stale bundle behind a parse error. Everything else is a client-side route.
    const last = segments[segments.length - 1] ?? "";
    if (segments[0] === "assets" || extname(last) !== "") return notFound(reply);
    return send(reply, indexPath, "no-cache");
  });
}
