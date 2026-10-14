// T0: the shared web transport adds the tenant and CSRF headers by rule, serialises JSON and raw
// bodies, parses answers leniently, and surfaces failures as typed ApiErrors with a 401 signal.

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/types.js";
import { createHttpTransport, query, stripUndefined } from "./http-transport.js";

interface Seen {
  url: string;
  init: RequestInit;
}

function recorder(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const ok = (body: unknown = { a: 1 }, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("http transport", () => {
  it("prefixes the base URL and sends the tenant on every method, CSRF only on unsafe ones", async () => {
    let csrf = "c1";
    const { fetch, seen } = recorder(() => ok());
    const t = createHttpTransport({
      baseUrl: "https://gw.test",
      fetch,
      tenantId: "tn_1",
      csrfToken: () => csrf,
    });
    await t.json("GET", "/api/x");
    await t.json("POST", "/api/x", { b: 2 });
    csrf = "c2";
    await t.json("DELETE", "/api/x");
    expect(seen.map((s) => [s.init.method, s.url, s.init.headers, s.init.body])).toEqual([
      [
        "GET",
        "https://gw.test/api/x",
        { accept: "application/json", "x-deskmates-tenant": "tn_1" },
        undefined,
      ],
      [
        "POST",
        "https://gw.test/api/x",
        {
          accept: "application/json",
          "x-deskmates-csrf": "c1",
          "x-deskmates-tenant": "tn_1",
          "content-type": "application/json",
        },
        '{"b":2}',
      ],
      [
        "DELETE",
        "https://gw.test/api/x",
        { accept: "application/json", "x-deskmates-csrf": "c2", "x-deskmates-tenant": "tn_1" },
        undefined,
      ],
    ]);
    for (const s of seen) {
      expect(s.init.credentials).toBe("same-origin");
      expect("cache" in s.init).toBe(false);
      expect("signal" in s.init).toBe(false);
    }
  });

  it("lets one call override the CSRF token and tenant, but never sends CSRF on GET", async () => {
    const { fetch, seen } = recorder(() => ok());
    const t = createHttpTransport({ fetch, cache: "no-store", csrfToken: () => "getter" });
    await t.request("POST", "/auth/x", { csrf: "explicit", tenantId: "tn_2" });
    await t.request("GET", "/auth/session", { csrf: "explicit", tenantId: "tn_3" });
    expect(seen.map((s) => s.init.headers)).toEqual([
      { accept: "application/json", "x-deskmates-csrf": "explicit", "x-deskmates-tenant": "tn_2" },
      { accept: "application/json", "x-deskmates-tenant": "tn_3" },
    ]);
    expect(seen.every((s) => s.init.cache === "no-store")).toBe(true);
  });

  it("sends a raw Blob body with its own content type", async () => {
    const { fetch, seen } = recorder(() => ok());
    const image = new Blob(["png"]);
    await createHttpTransport({ fetch }).request("PUT", "/auth/avatar", {
      body: { blob: image, contentType: "image/png" },
    });
    expect(seen[0]?.init.body).toBe(image);
    expect(seen[0]?.init.headers).toEqual({
      accept: "application/json",
      "content-type": "image/png",
    });
  });

  it("resolves an empty or unparsable OK body as undefined", async () => {
    const answers = [new Response("", { status: 200 }), new Response("<html>", { status: 200 })];
    const { fetch } = recorder(() => answers.shift() as Response);
    const t = createHttpTransport({ fetch });
    await expect(t.json("GET", "/a")).resolves.toBeUndefined();
    await expect(t.json("GET", "/b")).resolves.toBeUndefined();
  });

  it("types failures, falls back to method and path, and signals only a 401", async () => {
    const onUnauthorized = vi.fn();
    const answers = [
      new Response(JSON.stringify({ code: "conflict", message: "Changed", details: { v: 2 } }), {
        status: 409,
      }),
      new Response("nope", { status: 401 }),
    ];
    const { fetch } = recorder(() => answers.shift() as Response);
    const t = createHttpTransport({ fetch, onUnauthorized });
    const conflict = await t.json("PATCH", "/api/a").catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict).toMatchObject({ code: "conflict", message: "Changed", status: 409 });
    expect((conflict as ApiError).details).toEqual({ v: 2 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    await expect(t.json("GET", "/api/b?x=1")).rejects.toMatchObject({
      code: "unknown",
      message: "GET /api/b?x=1 failed with 401",
      status: 401,
      details: {},
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("turns a thrown fetch into a network ApiError", async () => {
    const t = createHttpTransport({
      fetch: (async () => {
        throw new TypeError("offline");
      }) as typeof globalThis.fetch,
    });
    await expect(t.json("GET", "/a")).rejects.toMatchObject({
      name: "ApiError",
      code: "network",
      message: "offline",
      status: 0,
    });
  });

  it("downloads bytes with a binary accept, extra headers and an abort signal", async () => {
    const { fetch, seen } = recorder(
      () => new Response("abcd", { status: 206, headers: { "content-range": "bytes 0-3/9" } }),
    );
    const signal = new AbortController().signal;
    const res = await createHttpTransport({ fetch, tenantId: "tn_1" }).download("/f", {
      headers: { range: "bytes=0-3" },
      signal,
    });
    expect(await res.text()).toBe("abcd");
    expect(res.headers.get("content-range")).toBe("bytes 0-3/9");
    expect(seen[0]?.init).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/octet-stream, application/json",
        "x-deskmates-tenant": "tn_1",
        range: "bytes=0-3",
      },
      signal,
    });
  });

  it("rejects a failed download with the typed error and the 401 signal", async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = recorder(() => ok({ code: "not_found", message: "gone" }, 401));
    await expect(
      createHttpTransport({ fetch, onUnauthorized }).download("/f"),
    ).rejects.toMatchObject({ code: "not_found", status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("looks the global fetch up per call when none is injected", async () => {
    const t = createHttpTransport();
    const spy = vi.fn(async () => ok({ late: true }));
    vi.stubGlobal("fetch", spy);
    try {
      await expect(t.json("GET", "/late")).resolves.toEqual({ late: true });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds query strings from defined, non-empty values and strips undefined fields", () => {
    expect(query({ a: "x y", b: undefined, c: "", d: 0 })).toBe("?a=x+y&d=0");
    expect(query({ a: undefined })).toBe("");
    expect(stripUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});
