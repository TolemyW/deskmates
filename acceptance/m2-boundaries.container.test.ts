// T2 B4 closeout: exercise the production split listeners and two real Docker workspaces.
// This suite owns every resource it creates. Select the candidate workspace image by Docker
// image ID in WORKSPACE_IMAGE (required whenever Docker is reachable) and the proxy with
// EGRESS_PROXY_IMAGE; both images must be available locally.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle, WorkspaceId } from "@deskmates/contracts";
import { NOVNC_CONTAINER_PORT } from "@deskmates/contracts";
import { type GatewayConfig, buildGateway, buildOperatorGateway } from "@deskmates/gateway";
import { DockerProvider, networkName, proxyName } from "@deskmates/sandbox-docker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressProxyImage, requireImageId, testDockerProviderOptions } from "./support/docker.js";

const IMAGE = process.env.WORKSPACE_IMAGE?.trim() ?? "";
const PROXY_IMAGE = egressProxyImage();
const suffix = randomUUID().slice(0, 8);
const ids = [`b4-boundary-a-${suffix}`, `b4-boundary-b-${suffix}`] as WorkspaceId[];
const [firstId, secondId] = ids;
if (!firstId || !secondId) throw new Error("two workspace IDs required");
const provider = new DockerProvider(testDockerProviderOptions());
// The listed public host the reachability cases fetch. Any public site the test host can reach
// proves the policy; on Testbox the international path comes and goes with a desktop proxy
// (2026-09-28), so its release gate uses a domestic site.
const PUBLIC_HOST = process.env.DESKMATES_T2_PUBLIC_HOST?.trim() || "example.com";
const temp = mkdtempSync(join(tmpdir(), `deskmates-b4-${suffix}-`));
const credential = randomBytes(36).toString("hex");
const config: GatewayConfig = {
  port: 0,
  bind: "0.0.0.0",
  operatorPort: 0,
  operatorBind: "127.0.0.1",
  operatorToken: credential,
  dbPath: join(temp, "gateway.sqlite"),
  secretsKey: "",
  modelBaseUrl: "http://127.0.0.1:1",
  modelAuthToken: "unused",
  defaultModel: "fixture-model",
  cheapModel: "fixture-model",
  defaultRuntime: "claude-agent-sdk",
  sandboxProvider: "docker",
  workspaceImage: IMAGE,
  egressImage: PROXY_IMAGE,
  gatewayBaseUrl: undefined,
  modelTokenTtlSeconds: 3600,
  threadPayloadMaxTokens: 16000,
  shortWaitSeconds: 1,
  runTimeoutSeconds: 60,
  workspaceMemoryLimitMb: 4096,
  cronTimeZone: "UTC",
  webhookBodyMaxBytes: 65536,
  webhookQueueMax: 20,
  maxTurns: 5,
  channelStateDir: join(temp, "channels"),
  modelPrices: [],
};
const sandbox = buildGateway(config, provider, { startCron: false });
const operator = buildOperatorGateway(sandbox.deskmates);
let sandboxUrl = "";
let operatorUrl = "";
const handles: SandboxHandle[] = [];
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function localImageExists(image: string): Promise<boolean> {
  const result = await provider.client.request("GET", `/images/${encodeURIComponent(image)}/json`);
  return result.status === 200;
}

const available = await provider.client
  .request("GET", "/_ping", undefined, { timeoutMs: 3000 })
  .then(
    (result) => result.status === 200,
    () => false,
  );
if (!available) console.warn("[m2-boundaries] skipped: Docker unavailable");

function portOf(app: typeof sandbox): number {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("listener has no TCP address");
  return address.port;
}

async function exec(handle: SandboxHandle, script: string): Promise<{ code: number; out: string }> {
  const result = await provider.exec(handle, { cmd: ["sh", "-c", script], timeoutMs: 12_000 });
  return { code: result.exitCode, out: `${result.stdout}${result.stderr}` };
}

async function inspect(name: string): Promise<{
  Id: string;
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}> {
  const result = await provider.client.expect<{
    Id: string;
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }>("GET", `/containers/${name}/json`);
  return result.json;
}

describe.skipIf(!available)("M2 B4 live boundaries", () => {
  beforeAll(async () => {
    requireImageId(IMAGE, "WORKSPACE_IMAGE");
    for (const image of [IMAGE, PROXY_IMAGE]) {
      if (!(await localImageExists(image)))
        throw new Error(`image ${image} is not present locally`);
    }
    await sandbox.listen({ port: 0, host: "0.0.0.0" });
    await operator.listen({ port: 0, host: "127.0.0.1" });
    sandboxUrl = `http://127.0.0.1:${portOf(sandbox)}`;
    operatorUrl = `http://127.0.0.1:${portOf(operator)}`;
    for (const id of ids) {
      handles.push(
        await provider.create({
          workspaceId: id,
          image: IMAGE,
          env: {
            DESKMATES_VNC_PASSWORD: randomBytes(4).toString("hex"),
            DESKMATES_VNC_VIEW_PASSWORD: randomBytes(4).toString("hex"),
          },
          volumes: { "/work": `deskmates-b4-volume-${id}` },
          ports: [NOVNC_CONTAINER_PORT],
          egressAllowlist: [],
        }),
      );
    }
  }, 180_000);

  afterAll(async () => {
    for (const handle of handles.reverse()) await provider.destroy(handle).catch(() => undefined);
    for (const id of ids) {
      await provider.client
        .request("DELETE", `/volumes/deskmates-b4-volume-${id}?force=true`)
        .catch(() => undefined);
    }
    await operator.close();
    await sandbox.close();
  }, 90_000);

  it("separates host and workspace routes and credentials", async () => {
    const api = `${operatorUrl}/api/workspaces`;
    expect((await fetch(api)).status).toBe(401);
    expect((await fetch(api, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${api}?token=${credential}`)).status).toBe(401);
    expect((await fetch(api, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(
      200,
    );
    expect(
      (
        await fetch(`${sandboxUrl}/api/workspaces`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${operatorUrl}/healthz`)).status).toBe(404);
    expect((await fetch(`${operatorUrl}/api/events`)).status).toBe(401);
    // ADR-0022 decision 4: no credential in a URL, the SSE feed included.
    expect((await fetch(`${operatorUrl}/api/events?token=${credential}`)).status).toBe(401);
    const eventAbort = new AbortController();
    try {
      const events = await fetch(`${operatorUrl}/api/events`, {
        headers: { authorization: `Bearer ${credential}` },
        signal: eventAbort.signal,
      });
      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      eventAbort.abort();
    }
    expect((await fetch(`${operatorUrl}/v1/messages`, { method: "POST" })).status).toBe(404);
    expect(
      (await fetch(`${operatorUrl}/internal/runs/missing/events`, { method: "POST" })).status,
    ).toBe(404);
    for (const handle of handles) {
      const result = await exec(
        handle,
        `curl --silent --output /dev/null --write-out '%{http_code}' http://host.docker.internal:${portOf(sandbox)}/api/workspaces`,
      );
      expect(result.code).toBe(0);
      expect(result.out.trim()).toBe("404");
      const health = await exec(
        handle,
        `curl --silent --output /dev/null --write-out '%{http_code}' http://host.docker.internal:${portOf(sandbox)}/healthz`,
      );
      expect(health.out.trim()).toBe("200");
      const directHost = await exec(
        handle,
        `curl --silent --max-time 2 --noproxy '*' http://host.docker.internal:${portOf(sandbox)}/healthz`,
      );
      expect(directHost.code).not.toBe(0);
      const operatorFromWorkspace = await exec(
        handle,
        `curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' --noproxy '*' http://host.docker.internal:${portOf(operator)}/api/workspaces`,
      );
      expect(operatorFromWorkspace.code).not.toBe(0);
    }
  }, 45_000);

  it("records the direct host-service exception", async () => {
    const service = createServer((_request, response) => response.end("host-service-visible"));
    await new Promise<void>((resolve) => service.listen(0, "0.0.0.0", resolve));
    try {
      const address = service.address();
      if (!address || typeof address === "string") throw new Error("host fixture has no port");
      for (const handle of handles) {
        const result = await exec(
          handle,
          `curl --silent --max-time 3 http://host.docker.internal:${address.port}/`,
        );
        expect(result).toEqual({ code: 0, out: "host-service-visible" });
      }
      console.info(
        "[m2-boundaries] host exception: arbitrary HTTP service bound to 0.0.0.0 is reachable at host.docker.internal",
      );
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  }, 20_000);

  it("keeps an in-flight host request alive when public policy is revoked", async () => {
    const handle = handles[0];
    if (!handle) throw new Error("first workspace handle missing");
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("before");
      started();
      await finish;
      response.end("after");
    });
    await new Promise<void>((resolve) => service.listen(0, "0.0.0.0", resolve));
    try {
      const address = service.address();
      if (!address || typeof address === "string") throw new Error("host fixture has no port");
      const transfer = provider.exec(handle, {
        cmd: [
          "curl",
          "--silent",
          "--show-error",
          "--max-time",
          "10",
          `http://host.docker.internal:${address.port}/`,
        ],
        timeoutMs: 12_000,
      });
      await Promise.race([
        entered,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("host request never reached fixture")), 5000),
        ),
      ]);
      await provider.updateEgress(handle, [PUBLIC_HOST]);
      await provider.updateEgress(handle, []);
      release();
      const result = await transfer;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("beforeafter");
    } finally {
      release();
      service.closeAllConnections();
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  }, 30_000);

  it("keeps sibling files, processes and network endpoints separate", async () => {
    const [a, b] = handles;
    if (!a || !b) throw new Error("two handles required");
    const aInspect = await inspect(a.providerRef);
    const bInspect = await inspect(b.providerRef);
    expect(Object.keys(aInspect.NetworkSettings.Networks)).toEqual([networkName(firstId)]);
    expect(Object.keys(bInspect.NetworkSettings.Networks)).toEqual([networkName(secondId)]);
    const marker = `boundary-${suffix}`;
    expect(
      (
        await exec(
          a,
          `printf ${marker} > /work/b4-marker; (node -e 'setInterval(() => {}, 1000)' ${marker}) >/dev/null 2>&1 </dev/null & echo $! > /work/b4-pid`,
        )
      ).code,
    ).toBe(0);
    expect((await exec(b, "test ! -e /work/b4-marker && test ! -e /work/b4-pid")).code).toBe(0);
    const processView = await exec(b, "ps -eo args");
    expect(processView.out).not.toContain(marker);
    const aIp = aInspect.NetworkSettings.Networks[networkName(firstId)]?.IPAddress;
    if (!aIp) throw new Error("first workspace has no network address");
    const bIp = bInspect.NetworkSettings.Networks[networkName(secondId)]?.IPAddress;
    if (!bIp) throw new Error("second workspace has no network address");
    expect(aIp).not.toBe(bIp);
    const ownScreen = await exec(
      a,
      "curl --silent --max-time 3 --output /dev/null --write-out '%{http_code}' --noproxy '*' http://127.0.0.1:6080/vnc.html",
    );
    expect(ownScreen.out.trim()).toBe("200");
    const direct = await exec(
      b,
      `curl --silent --max-time 2 --noproxy '*' http://${aIp}:6080/vnc.html`,
    );
    expect(direct.code).not.toBe(0);
    const proxy = await inspect(proxyName(firstId));
    const proxyIp = proxy.NetworkSettings.Networks[networkName(firstId)]?.IPAddress;
    if (!proxyIp) throw new Error("first proxy has no network address");
    const directProxy = await exec(
      b,
      `curl --silent --max-time 2 --noproxy '*' http://${proxyIp}:3128/`,
    );
    expect(directProxy.code).not.toBe(0);
    console.info(
      `[m2-boundaries] networks ${networkName(firstId)} ${networkName(secondId)}; workspace image ${IMAGE}; proxy image ${PROXY_IMAGE}`,
    );
  }, 45_000);

  it("denies unlisted egress and direct network bypass; restart begins deny-all", async () => {
    const handle = handles[0];
    if (!handle) throw new Error("first workspace handle missing");
    const denied = await exec(
      handle,
      `curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://${PUBLIC_HOST}/`,
    );
    expect(denied.out.trim()).toBe("403");
    const literal = await exec(
      handle,
      "curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' --proxy http://egress-proxy:3128 http://93.184.215.14/",
    );
    expect(literal.out.trim()).toBe("403");
    await provider.updateEgress(handle, [PUBLIC_HOST]);
    const allowed = await exec(
      handle,
      `curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' https://${PUBLIC_HOST}/`,
    );
    expect(allowed.code, allowed.out).toBe(0);
    expect(allowed.out.trim()).toMatch(/^2\d\d$/);
    const unlisted = await exec(
      handle,
      "curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://example.org/",
    );
    expect(unlisted.out.trim()).toBe("403");
    const direct = await exec(
      handle,
      `curl --silent --max-time 3 --noproxy '*' https://${PUBLIC_HOST}/`,
    );
    expect(direct.code).not.toBe(0);
    const dnsBypass = await exec(handle, `getent ahosts ${PUBLIC_HOST}`);
    expect(dnsBypass.code).not.toBe(0);
    await provider.updateEgress(handle, []);
    const revoked = await exec(
      handle,
      `curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://${PUBLIC_HOST}/`,
    );
    expect(revoked.out.trim()).toBe("403");
    await provider.updateEgress(handle, [PUBLIC_HOST]);
    const proxy = await inspect(proxyName(firstId));
    await provider.client.request("POST", `/containers/${proxy.Id}/restart?t=1`);
    // Docker reports the restart before the proxy binds. Connection refused during boot is
    // fail-closed too; once it listens, the first policy response must still be a denial.
    let afterRestart = { code: -1, out: "" };
    const restartDeadline = Date.now() + 10_000;
    while (Date.now() < restartDeadline) {
      afterRestart = await exec(
        handle,
        `curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' http://${PUBLIC_HOST}/`,
      );
      if (afterRestart.out.trim() !== "000") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(afterRestart.out.trim()).toBe("403");
    await provider.updateEgress(handle, []);
  }, 45_000);

  it("under '*' reaches a public name but never a private address or IP literal (ADR-0010)", async () => {
    const handle = handles[0];
    if (!handle) throw new Error("first workspace handle missing");
    // `--noproxy ''` overrides the workspace NO_PROXY so loopback names are asked of the proxy too.
    const status = async (url: string): Promise<string> =>
      (
        await exec(
          handle,
          `curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' --noproxy '' --proxy http://egress-proxy:3128 ${url}`,
        )
      ).out.trim();
    await provider.updateEgress(handle, ["*"]);
    try {
      expect(await status(`https://${PUBLIC_HOST}/`)).toMatch(/^2\d\d$/);
      // `egress-proxy` is a hostname, so `*` admits the name; it resolves to the proxy's own
      // private address on the workspace network, which the resolved-address check refuses.
      expect(await status("http://egress-proxy/")).toBe("403");
      expect(await status("http://localhost/")).toBe("403");
      expect(await status("http://93.184.215.14/")).toBe("403");
      expect(await status("http://169.254.169.254/latest/meta-data/")).toBe("403");
      expect(await status("http://[::1]/")).toBe("403");
      await provider.updateEgress(handle, []);
      expect(await status(`http://${PUBLIC_HOST}/`)).toBe("403");
    } finally {
      await provider.updateEgress(handle, []);
    }
  }, 60_000);
});
