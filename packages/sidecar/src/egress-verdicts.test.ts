// T0: one egress verdict table, every enforcement point (ADR-0010 decision 3). The sidecar's
// navigation, shell-fetch and workflow checks all call contracts `egressAllows`; the egress proxy
// has its own copy of the matcher in plain JavaScript. They must answer every row identically.

import { pathToFileURL } from "node:url";
import { egressAllows } from "@deskmates/contracts";
import { EGRESS_VERDICTS } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import { shellHosts, targetHost } from "./tool-action.js";

interface EgressPolicyModule {
  normalizePatterns(input: readonly string[]): string[];
  hostnameAllowed(hostname: string, patterns: readonly string[]): boolean;
}

const policyUrl = pathToFileURL(
  new URL("../../../images/egress/egress-policy.mjs", import.meta.url).pathname,
).href;
const proxy = (await import(policyUrl)) as EgressPolicyModule;

const label = (row: (typeof EGRESS_VERDICTS)[number]) =>
  `${JSON.stringify(row.host)} under ${JSON.stringify(row.allowlist)}`;

describe("egress verdict table", () => {
  it.each(EGRESS_VERDICTS.map((row) => [label(row), row] as const))(
    "contracts egressAllows: %s",
    (_, row) => {
      expect(egressAllows(row.host, row.allowlist)).toBe(row.allowed);
    },
  );

  it.each(EGRESS_VERDICTS.map((row) => [label(row), row] as const))(
    "egress proxy hostnameAllowed: %s",
    (_, row) => {
      expect(proxy.hostnameAllowed(row.host, proxy.normalizePatterns(row.allowlist))).toBe(
        row.allowed,
      );
    },
  );

  it("reads the host of an IP-literal URL the way the table expects under '*'", () => {
    // The sidecar extracts hosts with the URL parser, so every IPv4 spelling arrives dotted and
    // IPv6 arrives bracketed; none of them may pass `*`.
    for (const url of [
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://[::1]:9222/json",
      "https://10.0.0.1/",
    ]) {
      const host = targetHost({ url });
      expect(host, url).toBeDefined();
      expect(egressAllows(host as string, ["*"]), url).toBe(false);
    }
    const hosts = shellHosts("curl -s http://169.254.169.254/latest https://example.com/");
    expect(hosts.map((h) => egressAllows(h as string, ["*"]))).toEqual([false, true]);
  });
});
