import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDohLookup, parseDohUrl } from "./doh-lookup.mjs";
import { connectTarget, createPolicyState } from "./egress-policy.mjs";

const ENDPOINT = "https://223.5.5.5/resolve";

/** A DoH server double: answers by record type, records every request it saw. */
function fakeDoh(byType) {
  const requests = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, init });
    const reply = byType[parsed.searchParams.get("type")];
    if (typeof reply === "function") return reply(init);
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply), {
      headers: { "content-type": "application/dns-json" },
    });
  };
  return { fetch, requests };
}

const NO_DATA = { Status: 0, Answer: [] };

describe("DNS-over-HTTPS lookup (ADR-0010 decision 4a)", () => {
  it("queries A and AAAA as JSON and merges only the address records", async () => {
    const doh = fakeDoh({
      A: {
        Status: 0,
        Answer: [
          { name: "www.example.com.", type: 5, TTL: 60, data: "cdn.example.net." },
          { name: "cdn.example.net.", type: 1, TTL: 60, data: "93.184.215.14" },
          { name: "cdn.example.net.", type: 1, TTL: 60, data: "93.184.215.15" },
        ],
      },
      AAAA: {
        Status: 0,
        Answer: [
          { name: "www.example.com.", type: 5, TTL: 60, data: "cdn.example.net." },
          { name: "cdn.example.net.", type: 28, TTL: 60, data: "2606:2800:21f:cb07::1" },
        ],
      },
    });
    const lookup = createDohLookup(ENDPOINT, { fetch: doh.fetch });
    expect(await lookup("www.example.com")).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "93.184.215.15", family: 4 },
      { address: "2606:2800:21f:cb07::1", family: 6 },
    ]);
    expect(doh.requests.map(({ url }) => url.searchParams.get("type")).sort()).toEqual([
      "A",
      "AAAA",
    ]);
    for (const { url, init } of doh.requests) {
      expect(url.origin).toBe("https://223.5.5.5");
      expect(url.pathname).toBe("/resolve");
      expect(url.searchParams.get("name")).toBe("www.example.com");
      expect(new Headers(init.headers).get("accept")).toBe("application/dns-json");
      // A redirect could name a host, which would go back through the intercepted resolver.
      expect(init.redirect).toBe("error");
    }
  });

  it("accepts a name with only A records (AAAA NODATA is normal)", async () => {
    const doh = fakeDoh({
      A: { Status: 0, Answer: [{ name: "a.test.", type: 1, TTL: 1, data: "1.1.1.1" }] },
      AAAA: { Status: 0 },
    });
    expect(await createDohLookup(ENDPOINT, { fetch: doh.fetch })("a.test")).toEqual([
      { address: "1.1.1.1", family: 4 },
    ]);
  });

  it.each([
    ["NXDOMAIN", { A: { Status: 3 }, AAAA: { Status: 3 } }],
    ["SERVFAIL on one type", { A: { Status: 0, Answer: [] }, AAAA: { Status: 2 } }],
    ["no address at all", { A: NO_DATA, AAAA: NO_DATA }],
    [
      "only a CNAME",
      {
        A: { Status: 0, Answer: [{ name: "x.", type: 5, TTL: 1, data: "y." }] },
        AAAA: NO_DATA,
      },
    ],
    ["malformed JSON", { A: new Response("{not json"), AAAA: NO_DATA }],
    ["a non-object body", { A: new Response("null"), AAAA: NO_DATA }],
    ["an HTTP error", { A: new Response("busy", { status: 503 }), AAAA: NO_DATA }],
    ["a non-array Answer", { A: { Status: 0, Answer: "1.1.1.1" }, AAAA: NO_DATA }],
    [
      "an A row whose data is not IPv4",
      { A: { Status: 0, Answer: [{ type: 1, data: "2001:db8::1" }] }, AAAA: NO_DATA },
    ],
    [
      "an AAAA row whose data is not IPv6",
      { A: NO_DATA, AAAA: { Status: 0, Answer: [{ type: 28, data: "evil.example." }] } },
    ],
    [
      "a network error",
      {
        A: () => {
          throw new TypeError("fetch failed");
        },
        AAAA: NO_DATA,
      },
    ],
  ])("fails closed on %s", async (_label, byType) => {
    const lookup = createDohLookup(ENDPOINT, { fetch: fakeDoh(byType).fetch });
    await expect(lookup("example.com")).rejects.toThrow();
  });

  it("fails closed when the resolver does not answer within the deadline", async () => {
    // Never settles and ignores the abort signal: the deadline must not depend on fetch honouring it.
    const hang = () => new Promise(() => {});
    const lookup = createDohLookup(ENDPOINT, {
      fetch: fakeDoh({ A: hang, AAAA: hang }).fetch,
      timeoutMs: 30,
    });
    const started = Date.now();
    await expect(lookup("slow.example.com")).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("aborts the in-flight query when the deadline passes", async () => {
    let aborted = false;
    const listen = (init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal.reason);
        });
      });
    const lookup = createDohLookup(ENDPOINT, {
      fetch: fakeDoh({ A: listen, AAAA: NO_DATA }).fetch,
      timeoutMs: 30,
    });
    await expect(lookup("slow.example.com")).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it.each([["198.18.0.84"], ["10.1.2.3"], ["127.0.0.1"], ["fd00::1"]])(
    "a DoH answer of %s is still denied by resolvePublic",
    async (address) => {
      const record = address.includes(":")
        ? { type: 28, data: address }
        : { type: 1, data: address };
      const lookup = createDohLookup(ENDPOINT, {
        fetch: fakeDoh({
          A: record.type === 1 ? { Status: 0, Answer: [record] } : NO_DATA,
          AAAA: record.type === 28 ? { Status: 0, Answer: [record] } : NO_DATA,
        }).fetch,
      });
      const state = createPolicyState(["*"]);
      await expect(state.resolvePublic("example.com", lookup)).rejects.toThrow("address denied");
    },
  );

  it("denies when any one DoH answer is non-public, even beside a public one", async () => {
    const lookup = createDohLookup(ENDPOINT, {
      fetch: fakeDoh({
        A: { Status: 0, Answer: [{ type: 1, data: "93.184.215.14" }] },
        AAAA: { Status: 0, Answer: [{ type: 28, data: "fe80::1" }] },
      }).fetch,
    });
    await expect(createPolicyState(["*"]).resolvePublic("example.com", lookup)).rejects.toThrow(
      "address denied",
    );
  });

  it("connects to the exact address that was checked (anti-rebinding)", async () => {
    let calls = 0;
    const lookup = createDohLookup(ENDPOINT, {
      fetch: fakeDoh({
        // A second resolution would answer inward; only the first answer may ever be used.
        A: () => {
          calls += 1;
          const data = calls === 1 ? "93.184.215.14" : "10.0.0.1";
          return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data }] }));
        },
        AAAA: NO_DATA,
      }).fetch,
    });
    const answer = await createPolicyState(["*"]).resolvePublic("example.com", lookup);
    expect(connectTarget(answer, 443)).toEqual({ host: "93.184.215.14", family: 4, port: 443 });
    expect(calls).toBe(1);
  });

  it("the proxy builds both upstream sockets from the checked answer, never the request name", async () => {
    const source = await readFile(new URL("./egress-proxy.mjs", import.meta.url), "utf8");
    const httpPath = source.slice(source.indexOf("http.createServer"), source.indexOf('"connect"'));
    const connectPath = source.slice(source.indexOf('server.on("connect"'));
    expect(httpPath).toMatch(/http\.request\(\s*\{\s*\.\.\.connectTarget\(answer,/);
    expect(connectPath).toMatch(/net\.connect\(connectTarget\(answer,/);
    // No per-request resolver hook and no hostname as the socket target.
    expect(source).not.toMatch(/\blookup:/);
    expect(source).not.toMatch(/host:\s*(target\.hostname|hostname)\b/);
    // The DoH lookup replaces the system resolver only when configured.
    expect(source).toContain("process.env.DESKMATES_DOH_URL");
  });
});

describe("DoH endpoint validation", () => {
  it.each([
    "https://223.5.5.5/resolve",
    "https://1.1.1.1/dns-query",
    "https://[2400:3200::1]/resolve",
    "https://223.5.5.5:8443/resolve?edns_client_subnet=0.0.0.0/0",
  ])("accepts the IP-literal https endpoint %s", (url) => {
    expect(parseDohUrl(url)).toBeInstanceOf(URL);
  });

  it.each([
    ["http://223.5.5.5/resolve", /https/],
    ["https://dns.alidns.com/resolve", /IP literal/],
    ["https://user:pw@223.5.5.5/resolve", /credentials/],
    ["223.5.5.5", /URL/],
    ["", /URL/],
  ])("rejects %s", (url, message) => {
    expect(() => parseDohUrl(url)).toThrow(message);
    expect(() => createDohLookup(url)).toThrow(message);
  });
});
