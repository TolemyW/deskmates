import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface EgressPolicyModule {
  createPolicyState(initialPatterns?: readonly string[]): {
    readonly size: number;
    replace(patterns: readonly string[]): void;
    failClosed(): void;
    resolvePublic(
      hostname: string,
      lookup: (hostname: string) => Promise<readonly { address: string; family: number }[]>,
    ): Promise<{ address: string; family: number }>;
  };
  normalizePatterns(input: readonly string[]): string[];
  hostnameAllowed(hostname: string, patterns: readonly string[]): boolean;
  isPublicAddress(address: string): boolean;
}

const policyUrl = pathToFileURL(
  new URL("../../../images/egress/egress-policy.mjs", import.meta.url).pathname,
).href;
const policy = (await import(policyUrl)) as EgressPolicyModule;
const proxyPath = new URL("../../../images/egress/egress-proxy.mjs", import.meta.url);

describe("egress proxy policy", () => {
  it("overwrites persisted runtime policy with deny-all on every process start", async () => {
    const source = await readFile(proxyPath, "utf8");
    const reset = 'await fs.writeFile(POLICY_FILE, "", { mode: 0o600 });';
    expect(source).toContain(reset);
    expect(source.indexOf(reset)).toBeLessThan(source.indexOf("server.listen(3128"));
    expect(source).not.toContain("process.env.DESKMATES_EGRESS_ALLOWLIST");
    const signalHandler = source.slice(source.indexOf('process.on("SIGHUP"'));
    expect(signalHandler.indexOf("policy.failClosed()")).toBeGreaterThanOrEqual(0);
    expect(signalHandler.indexOf("policy.failClosed()")).toBeLessThan(
      signalHandler.indexOf("loadPolicy().catch"),
    );
  });

  it("invalidates an allowed request whose DNS lookup is pending during revocation", async () => {
    const state = policy.createPolicyState(["api.example.com"]);
    let release: ((answers: readonly { address: string; family: number }[]) => void) | undefined;
    const lookup = new Promise<readonly { address: string; family: number }[]>((resolve) => {
      release = resolve;
    });
    const pending = state.resolvePublic("api.example.com", () => lookup);
    state.replace([]);
    release?.([{ address: "1.1.1.1", family: 4 }]);
    await expect(pending).rejects.toThrow("egress policy changed");
  });

  it("switches immediately to deny-all when a reload fails", async () => {
    const state = policy.createPolicyState(["api.example.com"]);
    state.failClosed();
    await expect(
      state.resolvePublic("api.example.com", async () => [{ address: "1.1.1.1", family: 4 }]),
    ).rejects.toThrow("hostname denied");
  });

  it("uses the workspace exact and wildcard hostname semantics", () => {
    const patterns = policy.normalizePatterns(["Api.Example.com", "*.example.net"]);
    expect(policy.hostnameAllowed("api.example.com", patterns)).toBe(true);
    expect(policy.hostnameAllowed("example.net", patterns)).toBe(true);
    expect(policy.hostnameAllowed("a.b.example.net", patterns)).toBe(true);
    expect(policy.hostnameAllowed("notexample.net", patterns)).toBe(false);
    expect(policy.hostnameAllowed("127.0.0.1", patterns)).toBe(false);
  });

  it("rejects malformed patterns and IP literal allowlist entries", () => {
    expect(() => policy.normalizePatterns(["https://example.com"])).toThrow();
    expect(() => policy.normalizePatterns(["127.0.0.1"])).toThrow();
    expect(() => policy.normalizePatterns(["*.10.0.0.1"])).toThrow();
    expect(() => policy.normalizePatterns(["**"])).toThrow();
    expect(() => policy.normalizePatterns(["*.*"])).toThrow();
  });

  it("accepts '*' only as the sole entry (ADR-0010)", () => {
    expect(policy.normalizePatterns(["*"])).toEqual(["*"]);
    expect(policy.normalizePatterns([" * ", "*"])).toEqual(["*"]);
    expect(() => policy.normalizePatterns(["*", "example.com"])).toThrow();
  });

  it("under '*' resolves any public hostname and connects to its public address", async () => {
    const state = policy.createPolicyState(["*"]);
    const answer = await state.resolvePublic("www.example.org", async () => [
      { address: "93.184.215.14", family: 4 },
    ]);
    expect(answer.address).toBe("93.184.215.14");
  });

  it.each([
    ["10.1.2.3"],
    ["172.16.0.9"],
    ["192.168.5.2"],
    ["198.18.0.84"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["::1"],
    ["fd00::1"],
  ])("under '*' denies a public-looking name that resolves to %s", async (address) => {
    const state = policy.createPolicyState(["*"]);
    await expect(
      state.resolvePublic("intranet.example.com", async () => [
        { address, family: address.includes(":") ? 6 : 4 },
      ]),
    ).rejects.toThrow("address denied");
  });

  it("under '*' denies when any one answer is non-public", async () => {
    const state = policy.createPolicyState(["*"]);
    await expect(
      state.resolvePublic("mixed.example.com", async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "198.18.0.84", family: 4 },
      ]),
    ).rejects.toThrow("address denied");
  });

  it("under '*' denies IP literals and loopback names before any lookup", async () => {
    const state = policy.createPolicyState(["*"]);
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    };
    for (const host of ["1.1.1.1", "127.1", "::1", "[::1]", "localhost", "host.docker.internal"]) {
      await expect(state.resolvePublic(host, lookup), host).rejects.toThrow("hostname denied");
    }
    expect(lookups).toBe(0);
  });

  it("denies new connections once a policy replace (SIGHUP) removes '*'", async () => {
    const state = policy.createPolicyState(["*"]);
    const lookup = async () => [{ address: "1.1.1.1", family: 4 }];
    await expect(state.resolvePublic("example.com", lookup)).resolves.toMatchObject({
      address: "1.1.1.1",
    });
    state.replace(["golden.test"]);
    await expect(state.resolvePublic("example.com", lookup)).rejects.toThrow("hostname denied");
    state.replace([]);
    await expect(state.resolvePublic("golden.test", lookup)).rejects.toThrow("hostname denied");
  });

  it("invalidates a '*' lookup that is pending when '*' is revoked", async () => {
    const state = policy.createPolicyState(["*"]);
    let release: ((answers: readonly { address: string; family: number }[]) => void) | undefined;
    const lookup = new Promise<readonly { address: string; family: number }[]>((resolve) => {
      release = resolve;
    });
    const pending = state.resolvePublic("example.com", () => lookup);
    state.replace(["example.com"]);
    release?.([{ address: "1.1.1.1", family: 4 }]);
    await expect(pending).rejects.toThrow("egress policy changed");
  });

  it.each([
    "0.0.0.0",
    "10.2.3.4",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(policy.isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(policy.isPublicAddress(address)).toBe(true);
    },
  );
});
