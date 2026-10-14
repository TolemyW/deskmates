// T1: the egress image's connectivity probe (ADR-0027 amendment 1 decision 14) names the layer
// that fails. Loopback servers stand in for the target; `connect` is redirected to them so the
// probe's own address rules still see the address the Gateway asked for.

import { createServer } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { probe } = await import(
  pathToFileURL(new URL("../../../images/egress/egress-probe.mjs", import.meta.url).pathname).href
);

let httpPort = 0;
let closedPort = 0;
const server = createServer((_req, res) => {
  res.writeHead(204);
  res.end();
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  httpPort = (server.address() as AddressInfo).port;
  const spare = net.createServer();
  await new Promise<void>((r) => spare.listen(0, "127.0.0.1", r));
  closedPort = (spare.address() as AddressInfo).port;
  await new Promise<void>((r) => spare.close(() => r()));
});
afterAll(() => server.close());

/** Connect to loopback on the requested port, whatever address the probe chose. */
const toLoopback = (options: { port: number }) =>
  net.connect({ host: "127.0.0.1", port: options.port });
const options = {
  connect: toLoopback,
  infrastructure: () => false,
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
};

describe("egress probe layers", () => {
  it("reports every layer up to the HTTP status for a granted LAN origin", async () => {
    const result = await probe(
      { url: `http://10.20.30.24:${httpPort}/health`, grant: true },
      options,
    );
    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(result.layers.map((l: { layer: string }) => l.layer)).toEqual(["tcp", "http"]);
  });

  it("names TCP when nothing listens", async () => {
    const result = await probe({ url: `http://10.20.30.24:${closedPort}/`, grant: true }, options);
    expect(result.ok).toBe(false);
    expect(result.layers.at(-1)).toMatchObject({ layer: "tcp", ok: false, detail: "ECONNREFUSED" });
  });

  it("names DNS when a name does not resolve, and skips DNS for a pinned host rule", async () => {
    const failing = {
      ...options,
      lookup: async () => {
        throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
      },
    };
    const dnsFail = await probe({ url: "https://docs.example.org/", grant: false }, failing);
    expect(dnsFail.layers).toEqual([{ layer: "dns", ok: false, detail: "ENOTFOUND" }]);
    const pinned = await probe(
      { url: `http://console.lab.test:${httpPort}/`, address: "10.20.36.35", grant: true },
      failing,
    );
    expect(pinned).toMatchObject({ ok: true, status: 204 });
  });

  it("names TLS when the certificate does not verify", async () => {
    // A plain HTTP listener answering a TLS handshake is a TLS failure, not an HTTP one.
    const result = await probe({ url: `https://10.20.30.24:${httpPort}/`, grant: true }, options);
    expect(result.layers.at(-1)).toMatchObject({ layer: "tls", ok: false });
  });

  it("is a policy denial when a grant hits infrastructure or an allowlisted name is private", async () => {
    const infra = await probe(
      { url: `http://10.20.30.24:${httpPort}/`, grant: true },
      { ...options, infrastructure: () => true },
    );
    expect(infra.layers).toEqual([expect.objectContaining({ layer: "policy", ok: false })]);
    const rebound = await probe(
      { url: "https://intranet.example.org/", grant: false },
      { ...options, lookup: async () => [{ address: "10.0.0.8", family: 4 }] },
    );
    expect(rebound.layers.at(-1)).toMatchObject({ layer: "policy", ok: false });
  });
});
