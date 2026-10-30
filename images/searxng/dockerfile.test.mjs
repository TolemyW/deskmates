// T0 (ADR-0049 decision 14): what the SearXNG image promises, checked without Docker. The base is
// pinned to an exact release and index digest; the build copies only settings.yml; the settings
// turn JSON on, the limiter, image proxy and metrics off, and bind to loopback; no secret is baked
// in; and stable.sh passes the secret from its state directory and runs on the host loopback.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("./Dockerfile");
const settings = read("./settings.yml");
const stableSh = read("../../scripts/stable/stable.sh");

const from = dockerfile.match(/^FROM (\S+)$/m)?.[1] ?? "";

describe("images/searxng/Dockerfile", () => {
  it("builds FROM the official image at an exact release and index digest", () => {
    expect(from).toMatch(
      /^searxng\/searxng:\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{9}@sha256:[0-9a-f]{64}$/,
    );
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1);
  });

  it("copies only the settings and bakes in no secret", () => {
    const copies = [...dockerfile.matchAll(/^(COPY|ADD) (.+)$/gm)].map((m) => m[0]);
    expect(copies).toEqual(["COPY settings.yml /etc/searxng/settings.yml"]);
    expect(dockerfile).not.toMatch(/SEARXNG_SECRET=/);
    expect(dockerfile).toMatch(/SEARXNG_BIND_ADDRESS=127\.0\.0\.1/);
  });
});

describe("images/searxng/settings.yml", () => {
  it("answers JSON, keeps SearXNG's defaults otherwise, and serves one trusted client", () => {
    expect(settings).toMatch(/^use_default_settings: true$/m);
    expect(settings).toMatch(/formats:\n\s+- html\n\s+- json/);
    expect(settings).toMatch(/^\s+limiter: false$/m);
    expect(settings).toMatch(/^\s+image_proxy: false$/m);
    expect(settings).toMatch(/^\s+public_instance: false$/m);
    expect(settings).toMatch(/^\s+enable_metrics: false$/m);
    expect(settings).toMatch(/^\s+bind_address: "127\.0\.0\.1"$/m);
    // The placeholder SearXNG refuses to start with; the real key comes from SEARXNG_SECRET.
    expect(settings).toMatch(/^\s+secret_key: "ultrasecretkey"$/m);
  });
});

describe("stable.sh searxng", () => {
  it("passes the secret from its state file and binds the host loopback", () => {
    expect(stableSh).toContain('--env-file "$SEARXNG_STATE/env"');
    expect(stableSh).toContain("-e SEARXNG_BIND_ADDRESS=127.0.0.1");
    expect(stableSh).toContain('-e "SEARXNG_PORT=$SX_PORT"');
  });
});
