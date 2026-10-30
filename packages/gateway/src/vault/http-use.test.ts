// T1 (ADR-0045 decision 6): a token is used in one fixed, bounded host-side request. The URL comes
// from the definition and checked parameters only; the token goes into the declared header after
// every check, never into the URL; the host must pass the egress list and resolve to public
// addresses only; a redirect is refused, a TLS failure reported as such; a write whose outcome is
// unknown is reported unknown and never retried, and a repeat with the same approval returns the
// recorded answer. Oracle: an exact call count. Metric: duplicate writes and unauthorized targets,
// target 0.

import type { VaultRequestDefinition, VaultUseResult } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  CANARY_TOKEN,
  type VaultFixture,
  toolUseOf,
  vaultFixture,
} from "../test-support/vault-fixture.js";
import { type VaultHttpDeps, buildVaultRequest, vaultHttpRequest } from "./http-use.js";
import { setVaultHttp } from "./use.js";
import { paramsProblem } from "./validate.js";

const definition = (extra: Partial<VaultRequestDefinition> = {}): VaultRequestDefinition => ({
  id: "vrq_1",
  name: "Get item",
  method: "GET",
  path: "/v1/items/{id}",
  params: [
    { name: "id", in: "path", type: "string", required: true },
    { name: "q", in: "query", type: "string" },
  ],
  header: { scheme: "bearer" },
  effect: "read",
  ...extra,
});

interface Seen {
  url: string;
  init: RequestInit;
}

function fake(answer: (seen: Seen) => Response | Promise<Response>, addresses = ["93.184.216.34"]) {
  const seen: Seen[] = [];
  const deps: VaultHttpDeps = {
    fetch: async (url, init) => {
      const call = { url, init };
      seen.push(call);
      return answer(call);
    },
    lookup: async () => addresses,
  };
  return { seen, deps };
}

const call = (extra: Partial<Parameters<typeof vaultHttpRequest>[1]> = {}) => ({
  origin: API_ORIGIN,
  definition: definition(),
  params: { id: "42", q: "a b" },
  token: CANARY_TOKEN,
  egressAllowlist: ["*"],
  ...extra,
});

describe("vault HTTP use", () => {
  it("builds the URL from the definition and inserts the token in the declared header only", async () => {
    const { seen, deps } = fake(() => Response.json({ id: "42" }));
    const outcome = await vaultHttpRequest(deps, call());
    expect(outcome).toMatchObject({ status: "completed", httpStatus: 200, body: '{"id":"42"}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${API_ORIGIN}/v1/items/42?q=a+b`);
    expect(seen[0]?.url).not.toContain(CANARY_TOKEN);
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CANARY_TOKEN}`,
    );
    expect(seen[0]?.init.redirect).toBe("manual");
    const named = fake(() => new Response("ok"));
    await vaultHttpRequest(
      named.deps,
      call({ definition: definition({ header: { scheme: "header", name: "X-Api-Key" } }) }),
    );
    const headers = named.seen[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(CANARY_TOKEN);
    expect(headers.authorization).toBeUndefined();
  });

  it("keeps a path parameter inside its segment and its origin", () => {
    const built = buildVaultRequest(API_ORIGIN, definition(), { id: "../../admin?x=1#y" });
    expect(built.url).toBe(`${API_ORIGIN}/v1/items/..%2F..%2Fadmin%3Fx%3D1%23y`);
    const body = buildVaultRequest(
      API_ORIGIN,
      definition({
        method: "POST",
        params: [{ name: "note", in: "body", type: "string" }],
        path: "/v1/notes",
      }),
      { note: "hi" },
    );
    expect(body).toEqual({ url: `${API_ORIGIN}/v1/notes`, body: '{"note":"hi"}' });
  });

  it("refuses a dot segment that would move the route", () => {
    // `DELETE /v1/items/{id}` with `..` would be `/v1/`; `/v1/users/{id}/keys` would be `/v1/keys`.
    for (const id of ["..", "."])
      expect(() => buildVaultRequest(API_ORIGIN, definition(), { id })).toThrow(
        "request left its route",
      );
    const keys = definition({ path: "/v1/users/{id}/keys" });
    expect(() => buildVaultRequest(API_ORIGIN, keys, { id: ".." })).toThrow(
      "request left its route",
    );
    expect(buildVaultRequest(API_ORIGIN, keys, { id: "..." }).url).toBe(
      `${API_ORIGIN}/v1/users/.../keys`,
    );
    for (const id of ["..", ".", "a/b", "%2e%2e", "../../admin"])
      expect(paramsProblem(definition(), { id }), id).toBe(
        "parameter id is not a plain path segment",
      );
    expect(paramsProblem(definition(), { id: "item-1.v2" })).toBeUndefined();
  });

  it("refuses a host outside the egress list or on a private address before sending", async () => {
    const { seen, deps } = fake(() => new Response("ok"));
    expect(
      (await vaultHttpRequest(deps, call({ egressAllowlist: ["other.example.test"] }))).status,
    ).toBe("egress_refused");
    const rebound = fake(() => new Response("ok"), ["93.184.216.34", "10.0.0.7"]);
    expect((await vaultHttpRequest(rebound.deps, call())).status).toBe("address_refused");
    const metadata = fake(() => new Response("ok"), ["169.254.169.254"]);
    expect((await vaultHttpRequest(metadata.deps, call())).status).toBe("address_refused");
    expect(seen.length + rebound.seen.length + metadata.seen.length).toBe(0);
  });

  it("refuses a redirect, reports TLS and auth failures, and returns no response header", async () => {
    const redirect = fake(
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }),
    );
    expect(await vaultHttpRequest(redirect.deps, call())).toMatchObject({
      status: "redirect_refused",
      httpStatus: 302,
    });
    const tls = fake(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
      });
    });
    expect((await vaultHttpRequest(tls.deps, call())).status).toBe("tls_failed");
    const auth = fake(
      () =>
        new Response("no", { status: 401, headers: { "set-cookie": "sid=synthetic-cookie-1" } }),
    );
    const refused = await vaultHttpRequest(auth.deps, call());
    expect(refused.status).toBe("auth_failed");
    expect(JSON.stringify(refused)).not.toContain("synthetic-cookie-1");
  });

  it("withholds a body that echoes the token in any known form", async () => {
    for (const echo of [
      CANARY_TOKEN,
      Buffer.from(CANARY_TOKEN).toString("base64"),
      encodeURIComponent(CANARY_TOKEN),
    ]) {
      const { deps } = fake(() => Response.json({ seen: `Bearer ${echo}` }));
      const outcome = await vaultHttpRequest(deps, call());
      expect(outcome.status).toBe("result_withheld");
      expect(outcome.body).toBeUndefined();
    }
  });

  it("reports an interrupted write as unknown, a read as a network error", async () => {
    const reset = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    };
    const write = fake(reset);
    expect(
      (
        await vaultHttpRequest(
          write.deps,
          call({ definition: definition({ method: "POST", effect: "write" }) }),
        )
      ).status,
    ).toBe("unknown");
    const read = fake(reset);
    expect((await vaultHttpRequest(read.deps, call())).status).toBe("network_error");
    expect(write.seen).toHaveLength(1);
  });
});

describe("vault_request through the Gateway", () => {
  let f: VaultFixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });

  it("validates parameters, runs once per approval and records no token", async () => {
    f = await vaultFixture();
    const entry = await f.tokenEntry(f.a, "write");
    const requestId = entry.requests[0]?.id ?? "";
    const { seen, deps } = fake(() => Response.json({ ok: true, echo: `token=${CANARY_TOKEN}` }));
    setVaultHttp(f.h.app.deskmates.ctx, deps);
    const { approvalId } = await f.approve(f.a, f.action(entry, "request", requestId));
    const body = {
      entryId: entry.id,
      revision: entry.revision,
      requestId,
      approvalId,
      toolUseId: toolUseOf(approvalId),
    };
    const invalid = await f.run<VaultUseResult>(f.a, "POST", "/vault/request", {
      ...body,
      params: { id: "1", header: "X-Evil: 1" },
    });
    expect(invalid.json.status).toBe("invalid_params");
    expect(seen).toHaveLength(0);

    const second = await f.approve(f.a, f.action(entry, "request", requestId));
    const sent = {
      ...body,
      ...second,
      toolUseId: toolUseOf(second.approvalId),
      params: { id: "1", note: "n" },
    };
    const first = await f.run<VaultUseResult>(f.a, "POST", "/vault/request", sent);
    expect(first.json).toMatchObject({ status: "result_withheld", httpStatus: 200 });
    const repeat = await f.run<VaultUseResult>(f.a, "POST", "/vault/request", sent);
    expect(repeat.json).toMatchObject({ status: "result_withheld", recorded: true });
    expect(seen).toHaveLength(1);
    const dump = f.h.app.deskmates.ctx.db.serialize().toString("latin1");
    expect(dump).not.toContain(CANARY_TOKEN);
  });
});
