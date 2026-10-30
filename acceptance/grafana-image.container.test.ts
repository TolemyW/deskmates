// T2 (ADR-0046 decision 6 and amendment 1): the Grafana image starts with the generated sqlite
// provisioning, through `stable.sh grafana init` and `start` themselves, against an obs.sqlite in
// WAL mode that a writer still holds open. It answers /analytics/api/health on the host loopback
// and on no other address of the host; a request without `X-WEBAUTH-USER` is not signed in, one
// with it from loopback is signed in as `admin`, a Viewer and not a server administrator, as the
// Gateway's relay would be. As that user it lists the five dashboards, opens the file read-only
// (datasource health) and answers one panel query through the SQLite datasource plugin. A second
// `start` changes nothing; `stop` removes the container.
//
// The stable root is a temporary directory whose only release is this checkout. Every name is
// random, so it never touches a stable installation's Grafana on the same daemon. Building the
// image needs Docker Hub and the plugin catalog, which a release host may not reach, so the test
// runs only when the content-tagged image is already on the daemon (`stable.sh grafana init` or
// `scripts/build-grafana-image.sh` built it) or DESKMATES_T2_BUILD_GRAFANA=1 lets it build. Grafana
// runs on the host network, so this needs a Linux Docker host.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const daemon = process.platform === "linux" && docker("info").status === 0;
const serverArch = daemon ? docker("version", "--format", "{{.Server.Arch}}").stdout.trim() : "";
const arch = serverArch === "arm64" || serverArch === "aarch64" ? "arm64" : "amd64";
const tag = daemon
  ? spawnSync("node", [join(REPO, "scripts/image-tag.mjs"), "grafana", "--arch", arch], {
      encoding: "utf8",
    }).stdout.trim()
  : "";
const built = daemon && docker("image", "inspect", tag).status === 0;
const available = daemon && (built || process.env.DESKMATES_T2_BUILD_GRAFANA === "1");
if (!available)
  console.warn(
    daemon
      ? `[grafana-image] skipped: ${tag} is not built (DESKMATES_T2_BUILD_GRAFANA=1 builds it)`
      : "[grafana-image] skipped: needs Docker on a Linux host",
  );

const nonce = randomBytes(4).toString("hex");
const container = `deskmates-t2-grafana-${nonce}`;
const root = mkdtempSync(join(tmpdir(), "grafana-t2-"));
let port = 0;
let writer: Database.Database | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

function stable(...args: string[]) {
  return spawnSync("bash", [join(REPO, "scripts/stable/stable.sh"), ...args], {
    encoding: "utf8",
    timeout: 900_000,
    env: {
      ...process.env,
      DESKMATES_STABLE_ROOT: root,
      GRAFANA_CONTAINER: container,
      GRAFANA_HEALTH_TIMEOUT: "120",
      IMAGE_ARCH: arch,
    },
  });
}

/** Grafana's API under the sub path, signed in the way the Gateway's relay signs in. */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/analytics${path}`, {
    ...init,
    headers: {
      "x-webauth-user": "admin",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

/** Whether something accepts a TCP connection at `host:port`. */
function listening(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

beforeAll(async () => {
  if (!available) return;
  port = await freePort();
  mkdirSync(join(root, "releases"));
  symlinkSync(REPO, join(root, "releases", "v0.0.0"));
  symlinkSync("releases/v0.0.0", join(root, "current"));
  mkdirSync(join(root, "shared", "data"), { recursive: true });
  writeFileSync(
    join(root, "shared", ".env"),
    [
      "GATEWAY_DB=./data/gateway.sqlite",
      "OBSERVABILITY_SINK=sqlite",
      `OBSERVABILITY_GRAFANA_PORT=${port}`,
      "",
    ].join("\n"),
  );
  // The obs file as the sqlite sink leaves it: its schema, WAL mode, one run, the writer open.
  writer = new Database(join(root, "shared", "data", "obs.sqlite"));
  writer.pragma("journal_mode = WAL");
  writer.exec(readFileSync(join(REPO, "packages/gateway/observability/sqlite.sql"), "utf8"));
  writer
    .prepare(
      "INSERT INTO run_states (batch_id, observed_at, run_id, workspace_id, bot_id, status, terminal, created_at) VALUES ('b1', ?, 'run_t2', 'ws', 'bot', 'failed', 1, ?)",
    )
    .run(new Date().toISOString(), new Date().toISOString());
}, 60_000);

afterAll(() => {
  if (available) {
    docker("rm", "-f", container);
    writer?.close();
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!available)("images/grafana with stable.sh grafana", () => {
  it("init builds the image and start brings Grafana up with the obs datasource", async () => {
    const init = stable("grafana", "init");
    expect(init.status, `${init.stdout}\n${init.stderr}`).toBe(0);
    const start = stable("grafana", "start");
    expect(start.status, `${start.stdout}\n${start.stderr}`).toBe(0);

    const health = await fetch(`http://127.0.0.1:${port}/analytics/api/health`);
    expect(health.status).toBe(200);
    // Amendment 1 decision 11: the host loopback only, never the host's network addresses.
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a !== undefined && a.family === "IPv4" && !a.internal)
      .map((a) => a?.address as string);
    for (const address of external) expect(await listening(address), address).toBe(false);

    const check = await api("/api/datasources/uid/deskmates-obs/health");
    expect(check.status, await check.clone().text()).toBe(200);

    const search = (await (await api("/api/search?tag=deskmates")).json()) as { uid: string }[];
    // ADR-0046 amendment 2 decision 18: agent runs and the four focus dashboards.
    expect(search.map((d) => d.uid).sort()).toEqual([
      "deskmates-agent-runs",
      "deskmates-approvals",
      "deskmates-model-latency",
      "deskmates-prompt-cache",
      "deskmates-tool-calls",
    ]);
  }, 900_000);

  it("signs in only with the relay's header, and then as the Viewer admin (amendment 1)", async () => {
    const anonymous = await fetch(`http://127.0.0.1:${port}/analytics/api/user`);
    expect(anonymous.status).toBe(401);
    // Basic authentication is off, and there is no administrator whose password it could carry.
    const basic = await fetch(`http://127.0.0.1:${port}/analytics/api/user`, {
      headers: { authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}` },
    });
    expect(basic.status).toBe(401);

    const user = (await (await api("/api/user")).json()) as {
      login: string;
      isGrafanaAdmin: boolean;
    };
    expect(user).toMatchObject({ login: "admin", isGrafanaAdmin: false });
    const orgs = (await (await api("/api/user/orgs")).json()) as { orgId: number; role: string }[];
    expect(orgs).toEqual([expect.objectContaining({ orgId: 1, role: "Viewer" })]);
    // A Viewer reads, and cannot change, the provisioned datasource.
    const edit = await api("/api/datasources/uid/deskmates-obs", { method: "DELETE" });
    expect(edit.status).toBe(403);
  }, 60_000);

  it("answers a panel query through the plugin, read-only", async () => {
    const sql = "SELECT count(*) AS runs FROM run_metrics";
    const response = await api("/api/ds/query", {
      method: "POST",
      body: JSON.stringify({
        from: "now-1h",
        to: "now",
        queries: [
          {
            refId: "A",
            datasource: { type: "frser-sqlite-datasource", uid: "deskmates-obs" },
            queryType: "table",
            rawQueryText: sql,
            queryText: sql,
          },
        ],
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const frames = (JSON.parse(body) as { results: { A: { frames: unknown[] } } }).results.A.frames;
    expect(JSON.stringify(frames)).toContain("[1]");
    const write = await api("/api/ds/query", {
      method: "POST",
      body: JSON.stringify({
        queries: [
          {
            refId: "B",
            datasource: { type: "frser-sqlite-datasource", uid: "deskmates-obs" },
            queryType: "table",
            rawQueryText: "DELETE FROM run_states",
            queryText: "DELETE FROM run_states",
          },
        ],
      }),
    });
    await write.text();
    expect(writer?.prepare("SELECT count(*) AS n FROM run_states").get()).toEqual({ n: 1 });
  }, 60_000);

  it("a second start changes nothing and stop removes the container", () => {
    const again = stable("grafana", "start");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/nothing to change/);
    expect(stable("grafana", "stop").status).toBe(0);
    expect(docker("container", "inspect", container).status).not.toBe(0);
  }, 120_000);
});
