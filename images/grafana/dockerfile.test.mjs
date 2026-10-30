// T0 (ADR-0046 decision 6): what the Grafana image promises, checked without Docker. The base is
// pinned to an exact release and digest; the SQLite datasource plugin is installed at build time,
// at an exact version, outside the directory stable.sh mounts over; nothing is set to download a
// plugin or phone home at run time; and the plugin installed is the one the generated sqlite
// provisioning names. `acceptance/grafana-image.container.test.ts` starts the image for real.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("./Dockerfile");
const datasource = read(
  "../../observability/grafana/sqlite/provisioning/datasources/deskmates.yaml",
);
const runSh = read("../../scripts/stable/stable.sh");

const from = dockerfile.match(/^FROM (\S+)$/m)?.[1] ?? "";
const env = Object.fromEntries(
  [...dockerfile.matchAll(/(GF_[A-Z_]+)=(\S+)/g)].map((m) => [m[1], m[2].replace(/\s*\\$/, "")]),
);

describe("images/grafana/Dockerfile", () => {
  it("builds FROM the official image at an exact version and index digest", () => {
    expect(from).toMatch(/^grafana\/grafana:\d+\.\d+\.\d+(-ubuntu)?@sha256:[0-9a-f]{64}$/);
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1);
  });

  it("installs the SQLite datasource plugin at build time, at an exact version", () => {
    const version = dockerfile.match(/^ARG SQLITE_DATASOURCE_VERSION=(\S+)$/m)?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toMatch(
      /grafana cli --pluginsDir \/opt\/deskmates\/grafana-plugins\s*\\\s*plugins install frser-sqlite-datasource "\$\{SQLITE_DATASOURCE_VERSION\}"/,
    );
    expect(env.GF_PATHS_PLUGINS).toBe("/opt/deskmates/grafana-plugins");
    // stable.sh mounts Grafana's state over /var/lib/grafana, which would hide a plugin there.
    expect(runSh).toContain(':/var/lib/grafana"');
    expect(env.GF_PATHS_PLUGINS.startsWith("/var/lib/grafana")).toBe(false);
  });

  it("downloads nothing and reports nothing when the container runs", () => {
    expect(dockerfile).not.toMatch(/GF_INSTALL_PLUGINS|GF_PLUGINS_PREINSTALL=/);
    expect(env).toMatchObject({
      GF_PLUGINS_PREINSTALL_DISABLED: "true",
      GF_ANALYTICS_REPORTING_ENABLED: "false",
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
    });
    expect(dockerfile).not.toMatch(/^(COPY|ADD) /m);
  });

  it("preinstalls the plugin the generated sqlite datasource uses", () => {
    expect(datasource).toMatch(/^\s+type: frser-sqlite-datasource$/m);
    expect(datasource).toMatch(/pathOptions: "\?mode=ro"/);
  });
});
