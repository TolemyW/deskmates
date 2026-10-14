import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GROUP_ROUTING_DEFAULT,
  MAX_TURNS_DEFAULT,
  MODEL_TOKEN_TTL_SECONDS_DEFAULT,
  RUN_TIMEOUT_SECONDS_DEFAULT,
  WEBHOOK_BODY_MAX_BYTES_DEFAULT,
  WEBHOOK_QUEUE_MAX_DEFAULT,
  WORKSPACE_CPU_LIMIT_DEFAULT,
  WORKSPACE_MEMORY_LIMIT_MB_DEFAULT,
  loadConfig,
} from "./config.js";

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));

const PACKAGES_DIR = join(SRC_DIR, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Every `packages/*\/src` tree, so a model list in a React component is scanned too. */
function walkPackageSources(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src");
    if (existsSync(src) && statSync(src).isDirectory()) walk(src, out);
  }
  return out;
}

const BASE_ENV = {
  GATEWAY_OPERATOR_TOKEN: "operator-config-test-token-32-bytes-minimum",
  MODEL_BASE_URL: "http://upstream.test/",
  MODEL_AUTH_TOKEN: "upstream-secret",
  DEFAULT_MODEL: "model-a",
  CHEAP_MODEL: "model-b",
};

describe("config", () => {
  it("defaults browser sessions to Secure cookies and the ADR-0022 lifetimes", () => {
    expect(loadConfig(BASE_ENV).auth).toEqual({
      cookieMode: "secure",
      sessionIdleTtlSeconds: 7 * 24 * 3600,
      sessionAbsoluteTtlSeconds: 30 * 24 * 3600,
      allowedOrigins: [],
      argon2: { memoryKiB: 19_456, iterations: 2, parallelism: 1 },
      passwordMinLength: 12,
    });
  });

  it("validates session cookie, lifetime, origin and Argon2 settings", () => {
    const c = loadConfig({
      ...BASE_ENV,
      GATEWAY_SESSION_COOKIE: "insecure-dev",
      GATEWAY_SESSION_IDLE_TTL_SECONDS: "600",
      GATEWAY_SESSION_ABSOLUTE_TTL_SECONDS: "3600",
      GATEWAY_ALLOWED_ORIGINS: "https://deskmates.example, http://localhost:5173",
      AUTH_ARGON2_MEMORY_KIB: "65536",
      AUTH_ARGON2_ITERATIONS: "3",
      GATEWAY_PASSWORD_MIN_LENGTH: "5",
    });
    expect(c.auth).toMatchObject({
      cookieMode: "insecure-dev",
      sessionIdleTtlSeconds: 600,
      sessionAbsoluteTtlSeconds: 3600,
      allowedOrigins: ["https://deskmates.example", "http://localhost:5173"],
      argon2: { memoryKiB: 65536, iterations: 3, parallelism: 1 },
      passwordMinLength: 5,
    });
    expect(loadConfig(BASE_ENV).auth?.passwordMinLength).toBe(12);
    for (const bad of ["0", "1025", "-3"])
      expect(() => loadConfig({ ...BASE_ENV, GATEWAY_PASSWORD_MIN_LENGTH: bad }), bad).toThrow(
        /GATEWAY_PASSWORD_MIN_LENGTH/,
      );
    expect(() => loadConfig({ ...BASE_ENV, GATEWAY_SESSION_COOKIE: "off" })).toThrow(
      /GATEWAY_SESSION_COOKIE/,
    );
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        GATEWAY_SESSION_IDLE_TTL_SECONDS: "7200",
        GATEWAY_SESSION_ABSOLUTE_TTL_SECONDS: "3600",
      }),
    ).toThrow(/must not exceed/);
    for (const bad of [
      "*",
      "https://deskmates.example/path",
      "deskmates.example",
      "ftp://x.example",
    ])
      expect(() => loadConfig({ ...BASE_ENV, GATEWAY_ALLOWED_ORIGINS: bad }), bad).toThrow(
        /GATEWAY_ALLOWED_ORIGINS/,
      );
    expect(() => loadConfig({ ...BASE_ENV, AUTH_ARGON2_MEMORY_KIB: "1024" })).toThrow(
      /at least 7168/,
    );
  });

  it("requires DEFAULT_MODEL and CHEAP_MODEL (ADR-0002 item 7)", () => {
    expect(() => loadConfig({ ...BASE_ENV, DEFAULT_MODEL: "" })).toThrow(/DEFAULT_MODEL/);
    expect(() => loadConfig({ ...BASE_ENV, CHEAP_MODEL: undefined })).toThrow(/CHEAP_MODEL/);
  });

  it("applies defaults and strips trailing slashes", () => {
    const c = loadConfig(BASE_ENV);
    expect(c.port).toBe(8080);
    expect(c.bind).toBe("0.0.0.0");
    expect(c.operatorPort).toBe(8081);
    expect(c.operatorBind).toBe("127.0.0.1");
    expect(c.egressImage).toBe("deskmates/egress-proxy:dev");
    expect(c.modelBaseUrl).toBe("http://upstream.test");
    expect(c.modelTokenTtlSeconds).toBe(MODEL_TOKEN_TTL_SECONDS_DEFAULT);
    expect(c.gatewayBaseUrl).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, MODEL_TOKEN_TTL_SECONDS: "60" }).modelTokenTtlSeconds).toBe(
      60,
    );
    expect(c.runTimeoutSeconds).toBe(RUN_TIMEOUT_SECONDS_DEFAULT);
    expect(loadConfig({ ...BASE_ENV, RUN_TIMEOUT_SECONDS: "90" }).runTimeoutSeconds).toBe(90);
    expect(() => loadConfig({ ...BASE_ENV, RUN_TIMEOUT_SECONDS: "0" })).toThrow(
      /RUN_TIMEOUT_SECONDS/,
    );
  });

  it("reads EGRESS_PROXY_DNS as a list of IP addresses and fails startup on a bad one (ADR-0010)", () => {
    expect(loadConfig(BASE_ENV).egressProxyDns).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, EGRESS_PROXY_DNS: "" }).egressProxyDns).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, EGRESS_PROXY_DNS: "  " }).egressProxyDns).toBeUndefined();
    expect(
      loadConfig({ ...BASE_ENV, EGRESS_PROXY_DNS: "223.5.5.5, 8.8.8.8,2001:4860:4860::8888" })
        .egressProxyDns,
    ).toEqual(["223.5.5.5", "8.8.8.8", "2001:4860:4860::8888"]);
    for (const bad of ["dns.google", "8.8.8.8:53", "223.5.5.5,,8.8.8.8", "300.1.1.1", "8.8.8.8,"]) {
      expect(() => loadConfig({ ...BASE_ENV, EGRESS_PROXY_DNS: bad }), bad).toThrow(
        /EGRESS_PROXY_DNS/,
      );
    }
  });

  it("validates operator-only private egress configuration", () => {
    const target = {
      workspaceId: "ws_a",
      hostname: "intranet.test",
      address: "10.2.3.4",
      port: 443,
      expiresAt: "2099-01-01T00:00:00Z",
    };
    expect(loadConfig(BASE_ENV).privateEgressTargets).toBeUndefined();
    expect(
      loadConfig({ ...BASE_ENV, EGRESS_PRIVATE_TARGETS: JSON.stringify([target]) })
        .privateEgressTargets,
    ).toEqual([target]);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        EGRESS_PRIVATE_TARGETS: JSON.stringify([{ ...target, address: "127.0.0.1" }]),
      }),
    ).toThrow();
    expect(() => loadConfig({ ...BASE_ENV, EGRESS_PRIVATE_TARGETS: "broken" })).toThrow();
  });

  it("reads EGRESS_PROXY_DOH_URL as an https URL on an IP literal and fails startup otherwise (ADR-0010 4a)", () => {
    expect(loadConfig(BASE_ENV).egressProxyDohUrl).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, EGRESS_PROXY_DOH_URL: "" }).egressProxyDohUrl).toBeUndefined();
    expect(
      loadConfig({ ...BASE_ENV, EGRESS_PROXY_DOH_URL: "  " }).egressProxyDohUrl,
    ).toBeUndefined();
    for (const good of [
      "https://223.5.5.5/resolve",
      " https://1.1.1.1/dns-query ",
      "https://[2400:3200::1]/resolve",
    ]) {
      expect(loadConfig({ ...BASE_ENV, EGRESS_PROXY_DOH_URL: good }).egressProxyDohUrl).toBe(
        good.trim(),
      );
    }
    for (const bad of [
      "http://223.5.5.5/resolve",
      // Resolving the resolver's own name would go through the intercepted port-53 path.
      "https://dns.alidns.com/resolve",
      "https://user:pw@223.5.5.5/resolve",
      "223.5.5.5",
      "not a url",
    ]) {
      expect(() => loadConfig({ ...BASE_ENV, EGRESS_PROXY_DOH_URL: bad }), bad).toThrow(
        /EGRESS_PROXY_DOH_URL/,
      );
    }
  });

  it("requires a deployment-grade operator credential and reads split listener settings", () => {
    expect(() => loadConfig({ ...BASE_ENV, GATEWAY_OPERATOR_TOKEN: undefined })).toThrow(
      /GATEWAY_OPERATOR_TOKEN/,
    );
    expect(() => loadConfig({ ...BASE_ENV, GATEWAY_OPERATOR_TOKEN: "short" })).toThrow(/8 bytes/);
    // An 8-hex-digit credential (the first group of a UUID) is the shortest accepted
    // (ADR-0006 amendment 3).
    expect(loadConfig({ ...BASE_ENV, GATEWAY_OPERATOR_TOKEN: "3f9a1c7e" }).operatorToken).toBe(
      "3f9a1c7e",
    );
    expect(
      loadConfig({
        ...BASE_ENV,
        GATEWAY_BIND: "127.0.0.2",
        OPERATOR_PORT: "9090",
        OPERATOR_BIND: "127.0.0.3",
      }),
    ).toMatchObject({ bind: "127.0.0.2", operatorPort: 9090, operatorBind: "127.0.0.3" });
  });

  it("reads the operator UI directory, leaving static serving off when unset", () => {
    expect(loadConfig(BASE_ENV).webDistDir).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, WEB_DIST_DIR: "  " }).webDistDir).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, WEB_DIST_DIR: " packages/web/dist " }).webDistDir).toBe(
      "packages/web/dist",
    );
  });

  it("reads the tenancy mode and tenant limits (ADR-0022 P3/P4), single by default", () => {
    expect(loadConfig(BASE_ENV)).toMatchObject({
      tenancy: "single",
      tenantMaxQueuedRuns: 200,
      tenantApiRequestsPerMinute: 1200,
      tenantMaxEventStreams: 200,
      tenantMaxDesktopConnections: 32,
      workspaceDiskQuotaMb: 0,
    });
    expect(
      loadConfig({
        ...BASE_ENV,
        TENANT_MAX_QUEUED_RUNS: "0",
        TENANT_API_REQUESTS_PER_MINUTE: "60",
        TENANT_MAX_EVENT_STREAMS: "10",
        TENANT_MAX_DESKTOP_CONNECTIONS: "0",
        WORKSPACE_DISK_QUOTA_MB: "2048",
      }),
    ).toMatchObject({
      tenantMaxQueuedRuns: 0,
      tenantApiRequestsPerMinute: 60,
      tenantMaxEventStreams: 10,
      tenantMaxDesktopConnections: 0,
      workspaceDiskQuotaMb: 2048,
    });
    expect(loadConfig({ ...BASE_ENV, DESKMATES_TENANCY: "multi" })).toMatchObject({
      tenancy: "multi",
    });
    expect(() => loadConfig({ ...BASE_ENV, DESKMATES_TENANCY: "many" })).toThrow(/single or multi/);
  });

  it("reads the running release label, leaving it unset when empty", () => {
    expect(loadConfig(BASE_ENV).release).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, DESKMATES_RELEASE: " " }).release).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, DESKMATES_RELEASE: " v0.2.0 " }).release).toBe("v0.2.0");
  });

  it("keeps origin coordination opt-in and rejects unknown modes", () => {
    expect(loadConfig(BASE_ENV).browserCoordinationMode).toBe("tab-v1");
    expect(loadConfig({ ...BASE_ENV, BROWSER_COORDINATION_MODE: "" }).browserCoordinationMode).toBe(
      "tab-v1",
    );
    expect(
      loadConfig({ ...BASE_ENV, BROWSER_COORDINATION_MODE: "origin-v2" }).browserCoordinationMode,
    ).toBe("origin-v2");
    expect(() => loadConfig({ ...BASE_ENV, BROWSER_COORDINATION_MODE: "origin" })).toThrow(
      /BROWSER_COORDINATION_MODE/,
    );
  });

  it("keeps the per-bot working directory opt-in and rejects unknown modes (issue #88)", () => {
    expect(loadConfig(BASE_ENV).botWorkdir).toBe("shared");
    expect(loadConfig({ ...BASE_ENV, DESKMATES_BOT_WORKDIR: "" }).botWorkdir).toBe("shared");
    expect(loadConfig({ ...BASE_ENV, DESKMATES_BOT_WORKDIR: "per-bot" }).botWorkdir).toBe(
      "per-bot",
    );
    expect(() => loadConfig({ ...BASE_ENV, DESKMATES_BOT_WORKDIR: "worktree" })).toThrow(
      /DESKMATES_BOT_WORKDIR/,
    );
  });

  it("keeps inline snapshots opt-in and rejects unknown modes", () => {
    expect(loadConfig(BASE_ENV).browserSnapshotMode).toBe("explicit-v1");
    expect(loadConfig({ ...BASE_ENV, BROWSER_SNAPSHOT_MODE: "" }).browserSnapshotMode).toBe(
      "explicit-v1",
    );
    expect(
      loadConfig({ ...BASE_ENV, BROWSER_SNAPSHOT_MODE: "inline-v2" }).browserSnapshotMode,
    ).toBe("inline-v2");
    expect(() => loadConfig({ ...BASE_ENV, BROWSER_SNAPSHOT_MODE: "inline" })).toThrow(
      /BROWSER_SNAPSHOT_MODE/,
    );
  });

  it("reads the group routing knob, defaults it and rejects unknown values", () => {
    expect(loadConfig(BASE_ENV).groupRouting).toBe(GROUP_ROUTING_DEFAULT);
    expect(loadConfig({ ...BASE_ENV, DESKMATES_GROUP_ROUTING: "" }).groupRouting).toBe(
      GROUP_ROUTING_DEFAULT,
    );
    expect(loadConfig({ ...BASE_ENV, DESKMATES_GROUP_ROUTING: "walk-v1" }).groupRouting).toBe(
      "walk-v1",
    );
    expect(loadConfig({ ...BASE_ENV, DESKMATES_GROUP_ROUTING: "owner-v1" }).groupRouting).toBe(
      "owner-v1",
    );
    expect(() => loadConfig({ ...BASE_ENV, DESKMATES_GROUP_ROUTING: "owner" })).toThrow(
      /DESKMATES_GROUP_ROUTING/,
    );
  });

  it("reads the trigger knobs and rejects a time zone that is not an IANA one", () => {
    const c = loadConfig(BASE_ENV);
    expect(c.cronTimeZone).toBeUndefined();
    expect(c.webhookBodyMaxBytes).toBe(WEBHOOK_BODY_MAX_BYTES_DEFAULT);
    expect(c.webhookQueueMax).toBe(WEBHOOK_QUEUE_MAX_DEFAULT);
    expect(loadConfig({ ...BASE_ENV, CRON_TIMEZONE: "Asia/Shanghai" }).cronTimeZone).toBe(
      "Asia/Shanghai",
    );
    expect(() => loadConfig({ ...BASE_ENV, CRON_TIMEZONE: "Mars/Olympus" })).toThrow(
      /CRON_TIMEZONE/,
    );
    expect(loadConfig({ ...BASE_ENV, WEBHOOK_QUEUE_MAX: "5" }).webhookQueueMax).toBe(5);
    expect(() => loadConfig({ ...BASE_ENV, WEBHOOK_BODY_MAX_BYTES: "0" })).toThrow(
      /WEBHOOK_BODY_MAX_BYTES/,
    );
  });

  it("reads the ADR-0013 integration runtime settings together or not at all", () => {
    expect(loadConfig(BASE_ENV).integrationRuntime).toBeUndefined();
    expect(
      loadConfig({
        ...BASE_ENV,
        INTEGRATION_RUNTIME_URL: "http://integration-runtime:3000/",
        INTEGRATION_RUNTIME_ADMIN_TOKEN: "adm",
        INTEGRATION_OAUTH_CALLBACK_URL: "https://gw.example.test/api/integrations/oauth/callback",
      }).integrationRuntime,
    ).toEqual({
      url: "http://integration-runtime:3000",
      adminToken: "adm",
      oauthCallbackUrl: "https://gw.example.test/api/integrations/oauth/callback",
    });
    expect(
      loadConfig({
        ...BASE_ENV,
        INTEGRATION_RUNTIME_URL: "http://rt:3000",
        INTEGRATION_RUNTIME_ADMIN_TOKEN: "adm",
      }).integrationRuntime,
    ).toEqual({ url: "http://rt:3000", adminToken: "adm" });
    for (const bad of [
      { INTEGRATION_RUNTIME_URL: "http://rt:3000" },
      { INTEGRATION_RUNTIME_ADMIN_TOKEN: "adm" },
      { INTEGRATION_OAUTH_CALLBACK_URL: "https://gw/cb" },
      { INTEGRATION_RUNTIME_URL: "ftp://rt", INTEGRATION_RUNTIME_ADMIN_TOKEN: "adm" },
      {
        INTEGRATION_RUNTIME_URL: "http://rt",
        INTEGRATION_RUNTIME_ADMIN_TOKEN: "adm",
        INTEGRATION_OAUTH_CALLBACK_URL: "not a url",
      },
    ])
      expect(() => loadConfig({ ...BASE_ENV, ...bad }), JSON.stringify(bad)).toThrow(
        /INTEGRATION_/,
      );
  });

  it("reads the ADR-0014 download cap, 1 GiB by default", () => {
    expect(loadConfig(BASE_ENV).fileDownloadMaxBytes).toBe(1024 * 1024 * 1024);
    expect(
      loadConfig({ ...BASE_ENV, FILE_DOWNLOAD_MAX_BYTES: "4194304" }).fileDownloadMaxBytes,
    ).toBe(4194304);
    expect(() => loadConfig({ ...BASE_ENV, FILE_DOWNLOAD_MAX_BYTES: "0" })).toThrow(
      /FILE_DOWNLOAD_MAX_BYTES/,
    );
  });

  it("caps a workspace container's memory, defaulting when the knob is unset", () => {
    // Issue #69: four live SDK sessions plus Chromium do not fit 4 GiB.
    expect(WORKSPACE_MEMORY_LIMIT_MB_DEFAULT).toBe(8192);
    expect(loadConfig(BASE_ENV).workspaceMemoryLimitMb).toBe(WORKSPACE_MEMORY_LIMIT_MB_DEFAULT);
    expect(
      loadConfig({ ...BASE_ENV, WORKSPACE_MEMORY_LIMIT_MB: "2048" }).workspaceMemoryLimitMb,
    ).toBe(2048);
    expect(loadConfig({ ...BASE_ENV, WORKSPACE_MEMORY_LIMIT_MB: "" }).workspaceMemoryLimitMb).toBe(
      WORKSPACE_MEMORY_LIMIT_MB_DEFAULT,
    );
    for (const bad of ["0", "-1", "lots"]) {
      expect(() => loadConfig({ ...BASE_ENV, WORKSPACE_MEMORY_LIMIT_MB: bad })).toThrow(
        /WORKSPACE_MEMORY_LIMIT_MB/,
      );
    }
  });

  it("caps a workspace container's CPU in cores, fractions allowed, 0 for none (ADR-0022 amd. 5)", () => {
    expect(loadConfig(BASE_ENV).workspaceCpuLimit).toBe(WORKSPACE_CPU_LIMIT_DEFAULT);
    expect(WORKSPACE_CPU_LIMIT_DEFAULT).toBe(4);
    expect(loadConfig({ ...BASE_ENV, WORKSPACE_CPU_LIMIT: "1.5" }).workspaceCpuLimit).toBe(1.5);
    expect(loadConfig({ ...BASE_ENV, WORKSPACE_CPU_LIMIT: "0" }).workspaceCpuLimit).toBe(0);
    expect(loadConfig({ ...BASE_ENV, WORKSPACE_CPU_LIMIT: " " }).workspaceCpuLimit).toBe(
      WORKSPACE_CPU_LIMIT_DEFAULT,
    );
    for (const bad of ["-1", "lots", "Infinity"]) {
      expect(() => loadConfig({ ...BASE_ENV, WORKSPACE_CPU_LIMIT: bad })).toThrow(
        /WORKSPACE_CPU_LIMIT/,
      );
    }
  });

  it("caps the SDK turns of one run, defaulting when the knob is unset", () => {
    // Issue #69: 50 was below what the stable deployment already runs.
    expect(MAX_TURNS_DEFAULT).toBe(80);
    expect(loadConfig(BASE_ENV).maxTurns).toBe(MAX_TURNS_DEFAULT);
    expect(loadConfig({ ...BASE_ENV, DESKMATES_MAX_TURNS: "12" }).maxTurns).toBe(12);
    expect(loadConfig({ ...BASE_ENV, DESKMATES_MAX_TURNS: "" }).maxTurns).toBe(MAX_TURNS_DEFAULT);
    for (const bad of ["0", "-3", "many"]) {
      expect(() => loadConfig({ ...BASE_ENV, DESKMATES_MAX_TURNS: bad })).toThrow(
        /DESKMATES_MAX_TURNS/,
      );
    }
  });

  it("parses MODEL_PRICES and fails startup on a bad table", () => {
    expect(loadConfig(BASE_ENV).modelPrices).toEqual([]);
    const good = JSON.stringify([
      { model: "model-a", inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheCreatePerM: 3.75 },
      {
        model: "model-b",
        inputPerM: 1,
        outputPerM: 5,
        cacheReadPerM: 0.1,
        cacheCreatePerM: 1.25,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const parsed = loadConfig({ ...BASE_ENV, MODEL_PRICES: good }).modelPrices;
    expect(parsed).toHaveLength(2);
    // An undated row prices everything, including runs that started before it was written.
    expect(parsed[0]?.effectiveFrom).toBe("1970-01-01T00:00:00.000Z");
    expect(parsed[1]?.effectiveFrom).toBe("2026-01-01T00:00:00.000Z");

    for (const bad of [
      "{",
      '{"model": "model-a"}',
      '[{"model": "", "inputPerM": 1, "outputPerM": 1, "cacheReadPerM": 1, "cacheCreatePerM": 1}]',
      '[{"model": "model-a", "inputPerM": "3", "outputPerM": 1, "cacheReadPerM": 1, "cacheCreatePerM": 1}]',
      '[{"model": "model-a", "inputPerM": -1, "outputPerM": 1, "cacheReadPerM": 1, "cacheCreatePerM": 1}]',
      '[{"model": "model-a", "inputPerM": 1, "outputPerM": 1, "cacheReadPerM": 1, "cacheCreatePerM": 1, "effectiveFrom": "soon"}]',
    ]) {
      expect(() => loadConfig({ ...BASE_ENV, MODEL_PRICES: bad }), bad).toThrow(/MODEL_PRICES/);
    }
  });

  it("documents every knob it reads in .env.example", () => {
    const example = readFileSync(join(SRC_DIR, "../../../.env.example"), "utf8");
    for (const key of [
      "WORKSPACE_MEMORY_LIMIT_MB",
      "WORKSPACE_CPU_LIMIT",
      "RUN_TIMEOUT_SECONDS",
      "WORKSPACE_IMAGE",
      "EGRESS_PROXY_IMAGE",
      "CRON_TIMEZONE",
      "WEBHOOK_BODY_MAX_BYTES",
      "WEBHOOK_QUEUE_MAX",
      "DESKMATES_MAX_TURNS",
      "MODEL_PRICES",
      "GATEWAY_OPERATOR_TOKEN",
      "GATEWAY_BIND",
      "OPERATOR_PORT",
      "OPERATOR_BIND",
      "WEB_DIST_DIR",
      "DESKMATES_RELEASE",
      "FILE_DOWNLOAD_MAX_BYTES",
      "INTEGRATION_RUNTIME_URL",
      "INTEGRATION_RUNTIME_ADMIN_TOKEN",
      "INTEGRATION_OAUTH_CALLBACK_URL",
      "CLI_SMALL_FAST_MODEL",
      "FALLBACK_MODEL",
    ]) {
      expect(example, `missing ${key}`).toContain(key);
    }
  });
});

describe("no model name literal under packages/*/src (ADR-0002 item 7, AGENTS.md)", () => {
  it("finds no vendor model-name prefix in any source file", () => {
    // Both strings are assembled from fragments so this file does not match its own pattern.
    const unfragment = (s: string) => s.replace("|", "");
    const pattern = new RegExp(
      ["cla|ude-", "gp|t-", "gl|m-", "deep|seek"].map(unfragment).join("|"),
      "i",
    );
    // The SDK's own package name contains a matching fragment and is imported by the sidecar and
    // the testkit; it names a dependency, not a model, so it is removed before the pattern runs.
    const sdkPackage = ["@anthropic-ai/cla|ude-agent-sdk"].map(unfragment)[0] as string;
    const offenders = walkPackageSources().filter((f) =>
      pattern.test(readFileSync(f, "utf8").split(sdkPackage).join("")),
    );
    expect(offenders).toEqual([]);
  });
});

it("keeps browser strategy opt-in", () => {
  expect(loadConfig(BASE_ENV).browserExecutionMode).toBeUndefined();
  expect(
    loadConfig({ ...BASE_ENV, BROWSER_EXECUTION_MODE: "vision-cli-v2" }).browserExecutionMode,
  ).toBe("vision-cli-v2");
  expect(() => loadConfig({ ...BASE_ENV, BROWSER_EXECUTION_MODE: "unknown" })).toThrow();
});

it("reads no run-concurrency cap: the retired knobs change nothing (ADR-0022 amendment 5)", () => {
  const config = loadConfig({
    ...BASE_ENV,
    WORKSPACE_MAX_CONCURRENT_RUNS: "0",
    TENANT_MAX_CONCURRENT_RUNS: "1",
  });
  expect(config).toEqual(loadConfig(BASE_ENV));
});

it("reads CLI_SMALL_FAST_MODEL as an optional model id (ADR-0023 decision 1)", () => {
  expect(loadConfig(BASE_ENV).cliSmallFastModel).toBeUndefined();
  expect("cliSmallFastModel" in loadConfig({ ...BASE_ENV, CLI_SMALL_FAST_MODEL: "  " })).toBe(
    false,
  );
  expect(loadConfig({ ...BASE_ENV, CLI_SMALL_FAST_MODEL: " small-fast " }).cliSmallFastModel).toBe(
    "small-fast",
  );
});

it("reads FALLBACK_MODEL as one optional model id (ADR-0023 decision 3)", () => {
  expect("fallbackModel" in loadConfig(BASE_ENV)).toBe(false);
  expect(loadConfig({ ...BASE_ENV, FALLBACK_MODEL: " fallback-a " }).fallbackModel).toBe(
    "fallback-a",
  );
  for (const bad of ["fallback-a,fallback-b", "fallback a"]) {
    expect(() => loadConfig({ ...BASE_ENV, FALLBACK_MODEL: bad }), bad).toThrow(/FALLBACK_MODEL/);
  }
});
