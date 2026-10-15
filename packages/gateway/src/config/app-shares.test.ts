// T0: app sharing configuration (ADR-0035 decision 2).

import { describe, expect, it } from "vitest";
import { readAppSharesConfig } from "./app-shares.js";

const read = (base: string, operator: string) =>
  readAppSharesConfig({ APP_SHARE_BASE_URL: base, APP_SHARE_OPERATOR_URL: operator });

describe("readAppSharesConfig", () => {
  it("is off without both URLs and refuses one alone", () => {
    expect(readAppSharesConfig({})).toEqual({});
    expect(() => readAppSharesConfig({ APP_SHARE_BASE_URL: "http://apps.localhost" })).toThrow(
      /together/,
    );
  });

  it("accepts a DNS base apart from the operator host", () => {
    expect(read("http://apps.localhost:8790/", "http://127.0.0.1:8081")).toEqual({
      appShares: {
        baseUrl: "http://apps.localhost:8790",
        operatorOrigin: "http://127.0.0.1:8081",
        port: 8790,
        bind: "127.0.0.1",
      },
    });
    expect(
      read("https://apps.example.net", "https://deskmates.example.com").appShares?.baseUrl,
    ).toBe("https://apps.example.net");
  });

  it("accepts the Testbox topology: nip.io base, IP-literal operator, TLS proxy (decision 11)", () => {
    const config = readAppSharesConfig({
      APP_SHARE_BASE_URL: "https://10.20.40.132.nip.io:18443",
      APP_SHARE_OPERATOR_URL: "https://10.20.40.132:18443",
      APP_SHARE_PORT: "18382",
    });
    expect(config).toEqual({
      appShares: {
        baseUrl: "https://10.20.40.132.nip.io:18443",
        operatorOrigin: "https://10.20.40.132:18443",
        port: 18382,
        bind: "127.0.0.1",
      },
    });
    // The default HTTPS port is dropped from the origin, as browsers send it.
    expect(read("https://10.20.40.132.nip.io:443", "https://10.20.40.132").appShares).toMatchObject(
      {
        baseUrl: "https://10.20.40.132.nip.io",
        operatorOrigin: "https://10.20.40.132",
      },
    );
  });

  it("refuses a base that is an IP literal, a bare name, the operator host or its parent", () => {
    for (const [base, operator] of [
      ["http://127.0.0.1:8790", "http://127.0.0.1:8081"],
      ["http://localhost:8790", "http://127.0.0.1:8081"],
      ["http://deskmates.example.com:8790", "http://deskmates.example.com"],
      ["http://example.com", "http://ui.example.com"],
      ["http://apps.localhost/path", "http://127.0.0.1:8081"],
      ["ftp://apps.localhost", "http://127.0.0.1:8081"],
    ])
      expect(() => read(base ?? "", operator ?? ""), base).toThrow();
  });
});
