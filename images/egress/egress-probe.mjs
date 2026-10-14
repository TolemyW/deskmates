// One connectivity preflight from the proxy's own network position (ADR-0027 amendment 1
// decision 14): DNS, TCP, TLS and the HTTP response, each reported as its own layer, so an
// operator sees which one fails. Run by the provider with `node egress-probe.mjs`, the request as
// JSON on stdin, one JSON line on stdout. It never changes policy and holds no credential.
//
// Input: { url, address?, grant }. `address` is a host rule's pinned address (no DNS). `grant`
// says the Gateway admitted the URL through a network-profile grant; without one, a resolved
// non-public address is a policy denial, as the proxy itself would decide.

import { promises as dns } from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { createDohLookup } from "./doh-lookup.mjs";
import { isPublicAddress } from "./egress-policy.mjs";
import { isInfrastructureAddress } from "./lan-grants.mjs";

const TIMEOUT_MS = 5000;

export async function probe(input, options = {}) {
  const lookup =
    options.lookup ??
    (process.env.DESKMATES_DOH_URL
      ? createDohLookup(process.env.DESKMATES_DOH_URL)
      : (host) => dns.lookup(host, { all: true, verbatim: true }));
  const connect = options.connect ?? net.connect;
  const secure = options.tlsConnect ?? tls.connect;
  const layers = [];
  const done = (layer, ok, detail, extra = {}) => {
    layers.push({ layer, ok, ...(detail === undefined ? {} : { detail }) });
    return { ok, layers, ...extra };
  };
  const url = new URL(input.url);
  const https = url.protocol === "https:";
  const port = Number(url.port || (https ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, "");

  let address = input.address;
  if (address === undefined && net.isIP(host) !== 0) address = host;
  if (address === undefined) {
    try {
      const answers = await lookup(host);
      if (!answers.length) return done("dns", false, "no address");
      address = answers[0].address;
      layers.push({ layer: "dns", ok: true, detail: address });
    } catch (error) {
      return done("dns", false, error?.code ?? String(error?.message ?? error));
    }
  }
  const infrastructure =
    options.infrastructure ??
    ((a) => isInfrastructureAddress(a, process.env.DESKMATES_HOST_TARGET));
  if (input.grant && infrastructure(address))
    return done("policy", false, "grant target overlaps the proxy's own networks or the host");
  if (!input.grant && !isPublicAddress(address))
    return done("policy", false, `${address} is not a public address`);

  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const s = connect({ host: address, port });
      s.setTimeout(TIMEOUT_MS, () =>
        s.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
      );
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    layers.push({ layer: "tcp", ok: true, detail: `${address}:${port}` });
  } catch (error) {
    return done("tcp", false, error?.code ?? String(error?.message ?? error));
  }
  if (https) {
    try {
      socket = await new Promise((resolve, reject) => {
        const s = secure({
          socket,
          ...(net.isIP(host) === 0 ? { servername: host } : {}),
          rejectUnauthorized: true,
        });
        s.once("secureConnect", () => resolve(s));
        s.once("error", reject);
      });
      layers.push({ layer: "tls", ok: true });
    } catch (error) {
      socket.destroy();
      return done("tls", false, error?.code ?? String(error?.message ?? error));
    }
  }
  try {
    const status = await new Promise((resolve, reject) => {
      let head = "";
      socket.setTimeout(TIMEOUT_MS, () =>
        reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
      );
      socket.on("data", (chunk) => {
        head += chunk;
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (match) resolve(Number(match[1]));
        else if (head.includes("\r\n")) reject(new Error("not an HTTP response"));
      });
      socket.once("error", reject);
      socket.once("end", () => reject(new Error("closed before a response")));
      socket.write(
        `HEAD ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.destroy();
    return done("http", true, undefined, { status });
  } catch (error) {
    socket.destroy();
    return done("http", false, error?.code ?? String(error?.message ?? error));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const result = await probe(JSON.parse(text)).catch((error) => ({
    ok: false,
    layers: [{ layer: "policy", ok: false, detail: String(error?.message ?? error) }],
  }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
