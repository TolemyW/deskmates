// Minimal Docker Engine API client over node:http. The provider needs eight endpoints
// (containers create/start/stop/delete/inspect/list, exec create/start/inspect, commit),
// so a dependency such as dockerode buys little and would hide the hijacked exec stream we
// must demultiplex ourselves anyway. Everything here is transport; Docker semantics live in
// docker-provider.ts.

import http from "node:http";
import type { Socket } from "node:net";
import { DeskmatesError } from "@deskmates/contracts";
import { type DockerEndpoint, describeEndpoint } from "./docker-endpoint.js";

/** Pinned so a daemon upgrade cannot change response shapes under us. Min supported by 20.10+. */
export const DOCKER_API_VERSION = "v1.41";

export interface DockerResponse {
  status: number;
  body: string;
}

export interface HijackedStream {
  socket: Socket;
  /** Bytes that arrived with the 101 response, before the socket was handed over. */
  head: Buffer;
}

export class DockerClient {
  constructor(readonly endpoint: DockerEndpoint) {}

  private baseOptions(): http.RequestOptions {
    return this.endpoint.kind === "unix"
      ? { socketPath: this.endpoint.socketPath }
      : { host: this.endpoint.host, port: this.endpoint.port };
  }

  private wrapError(err: NodeJS.ErrnoException, what: string): DeskmatesError {
    return new DeskmatesError(
      "sandbox_unavailable",
      `Docker daemon unreachable at ${describeEndpoint(this.endpoint)} (${what}): ${err.code ?? err.message}`,
      { endpoint: describeEndpoint(this.endpoint), errno: err.code ?? null },
    );
  }

  /** Plain request; resolves with any status. Callers decide what is an error. */
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<DockerResponse> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          ...this.baseOptions(),
          method,
          path: `/${DOCKER_API_VERSION}${path}`,
          headers: {
            "Content-Type": "application/json",
            ...(payload === undefined ? {} : { "Content-Length": Buffer.byteLength(payload) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", (e) => reject(this.wrapError(e, `${method} ${path}`)));
        },
      );
      if (opts.timeoutMs !== undefined) {
        req.setTimeout(opts.timeoutMs, () => {
          req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`));
        });
      }
      req.on("error", (e: NodeJS.ErrnoException) => reject(this.wrapError(e, `${method} ${path}`)));
      req.end(payload);
    });
  }

  /** Request that must succeed with 2xx; anything else becomes a typed error. */
  async expect<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    okStatuses: readonly number[] = [200, 201, 204],
  ): Promise<{ status: number; json: T }> {
    const res = await this.request(method, path, body);
    if (!okStatuses.includes(res.status)) throw dockerApiError(method, path, res);
    const json = res.body.trim() === "" ? (undefined as unknown as T) : (JSON.parse(res.body) as T);
    return { status: res.status, json };
  }

  /**
   * POST with `Connection: Upgrade` so the daemon hands us the raw stream (exec start / attach).
   * If the daemon answers with a normal response instead of 101, that is an API error.
   */
  hijack(path: string, body: unknown): Promise<HijackedStream> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        ...this.baseOptions(),
        method: "POST",
        path: `/${DOCKER_API_VERSION}${path}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
      });
      req.on("upgrade", (_res, socket, head) => resolve({ socket, head }));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          reject(
            dockerApiError("POST", path, {
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      });
      req.on("error", (e: NodeJS.ErrnoException) => reject(this.wrapError(e, `POST ${path}`)));
      req.end(payload);
    });
  }
}

export function dockerApiError(method: string, path: string, res: DockerResponse): DeskmatesError {
  let message = res.body.trim();
  try {
    const parsed = JSON.parse(res.body) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON; keep the raw body
  }
  const code = res.status === 404 ? "not_found" : "sandbox_unavailable";
  return new DeskmatesError(code, `Docker API ${method} ${path} -> ${res.status}: ${message}`, {
    status: res.status,
    path,
  });
}
