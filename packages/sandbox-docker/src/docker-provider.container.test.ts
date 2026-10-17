// T2: DockerProvider against a real Docker daemon, using alpine so the run stays fast.
// Skips with a message when the daemon is unreachable (colima stopped, no Docker).

import { randomUUID } from "node:crypto";
import {
  NOVNC_CONTAINER_PORT,
  type SandboxHandle,
  type WorkspaceId,
  isDeskmatesError,
} from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_PROXY_IMAGE,
  DockerProvider,
  MANAGED_LABEL,
  WORKSPACE_LABEL,
  containerName,
  networkName,
  proxyName,
} from "./docker-provider.js";
import { ENV_FILE_PATH, renderEnvFile } from "./env-file.js";
import { requireEgressImage } from "./testing/image-preflight.js";

const IMAGE = "alpine:3.20";
/**
 * Keeps the alpine container alive, and exits on SIGTERM. A bare `sleep infinity` as PID 1 has
 * no default signal handlers, so every stop (destroy, a stale-sandbox recreate) waited out the
 * provider's full 10 s stop timeout before the kill; that wait tested nothing.
 */
const ALPINE_COMMAND = ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"];
const EGRESS_IMAGE = process.env.EGRESS_PROXY_IMAGE?.trim() || DEFAULT_EGRESS_PROXY_IMAGE;

async function dockerReachable(p: DockerProvider): Promise<boolean> {
  try {
    const res = await p.client.request("GET", "/_ping", undefined, { timeoutMs: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

const provider = new DockerProvider({
  containerCommand: ALPINE_COMMAND,
  egressProxyImage: EGRESS_IMAGE,
});
const available = await dockerReachable(provider);
if (!available) {
  console.warn("[docker-provider.container.test] Docker daemon unreachable; skipping T2 tests.");
}

describe.skipIf(!available)("DockerProvider (T2, real Docker, alpine)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-ws-${suffix}` as WorkspaceId;
  const volume = `deskmates-t2-work-${suffix}`;
  let handle: SandboxHandle;
  let snapshotRef: string | undefined;

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
    if (snapshotRef) await provider.client.request("DELETE", `/images/${snapshotRef}?force=true`);
    await provider.client.request("DELETE", `/volumes/${volume}?force=true`);
  });

  beforeAll(async () => {
    await requireEgressImage(provider, EGRESS_IMAGE);
    const local = await provider.client.request("GET", `/images/${IMAGE}/json`);
    if (local.status === 200) return;
    const res = await provider.client.request("POST", "/images/create?fromImage=alpine&tag=3.20");
    expect(res.status).toBe(200);
  }, 120_000);

  beforeAll(async () => {
    const started = Date.now();
    handle = await provider.create({
      workspaceId,
      image: IMAGE,
      env: { DESKMATES_TEST: "yes", DESKMATES_VNC_PASSWORD: "deadbeef" },
      volumes: { "/work": volume },
      ports: [NOVNC_CONTAINER_PORT],
      egressAllowlist: [],
    });
    // alpine declares no HEALTHCHECK, so the readiness wait must return after a single inspect
    // rather than polling to its 90 s timeout.
    expect(
      Date.now() - started,
      "create must not wait on an image with no health check",
    ).toBeLessThan(30_000);
    expect(handle.workspaceId).toBe(workspaceId);
    expect(handle.providerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.sidecarAddress).toBe(`docker-exec://${handle.providerRef}`);
    expect(handle.novncAddress).toMatch(/^127\.0\.0\.1:\d+$/);

    const { json } = await provider.client.expect<{
      Name: string;
      State: { Running: boolean; Health?: { Status: string } };
      Config: { Labels: Record<string, string>; Env: string[] };
      HostConfig: {
        Binds: string[];
        Tmpfs: Record<string, string>;
        ShmSize: number;
        CapDrop: string[] | null;
        SecurityOpt: string[] | null;
        PidsLimit: number | null;
      };
    }>("GET", `/containers/${handle.providerRef}/json`);
    expect(json.State.Running).toBe(true);
    expect(json.State.Health).toBeUndefined();
    expect(json.Name).toBe(`/${containerName(workspaceId)}`);
    expect(json.Config.Labels[WORKSPACE_LABEL]).toBe(workspaceId);
    expect(json.Config.Labels[MANAGED_LABEL]).toBe("true");
    expect(json.Config.Env).toContain("DESKMATES_TEST=yes");
    expect(json.HostConfig.Binds).toEqual([`${volume}:/work`]);
    expect(Object.keys(json.HostConfig.Tmpfs)).toEqual(["/run/deskmates"]);
    expect(json.HostConfig.ShmSize).toBe(1024 * 1024 * 1024);
    // Hardening: nothing in a workspace needs a capability or a setuid escalation.
    expect(json.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(json.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(json.HostConfig.PidsLimit).toBe(4096);
  }, 60_000);

  it("relays noVNC through proxy loopback while the workspace has no published ports", async () => {
    const { json: workspace } = await provider.client.expect<{
      HostConfig: { PortBindings: Record<string, unknown> | null };
      NetworkSettings: { Ports: Record<string, unknown> };
    }>("GET", `/containers/${handle.providerRef}/json`);
    expect(Object.keys(workspace.HostConfig.PortBindings ?? {})).toHaveLength(0);
    expect(
      Object.values(workspace.NetworkSettings.Ports ?? {}).every((value) => value === null),
    ).toBe(true);
    const { json: proxy } = await provider.client.expect<{
      NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
    }>("GET", `/containers/${proxyName(workspaceId)}/json`);
    const binding = proxy.NetworkSettings.Ports[`${NOVNC_CONTAINER_PORT}/tcp`]?.[0];
    expect(binding?.HostIp).toBe("127.0.0.1");
    expect(handle.novncAddress).toBe(`127.0.0.1:${binding?.HostPort}`);
    expect(proxy.NetworkSettings.Ports["3128/tcp"]).toBeNull();

    // alpine is not the workspace image, so a busybox `nc` loop stands in for noVNC and answers
    // one request at a time. What is under test is the publish path from the container port to
    // this host, not the server: the real noVNC is exercised in workspace-image.container.test.
    const reply =
      'printf "HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\nConnection: close\\r\\n\\r\\nnoVNC\\n"';
    const loop = `while true; do ${reply} | nc -l -p ${NOVNC_CONTAINER_PORT} >/dev/null 2>&1; done`;
    const serve = await provider.exec(handle, {
      // Detached with every descriptor redirected, so the exec stream closes and this returns.
      cmd: ["sh", "-c", `(${loop}) >/dev/null 2>&1 </dev/null & sleep 1; echo started`],
      timeoutMs: 15_000,
    });
    expect(serve.stdout.trim()).toBe("started");

    let res: Response | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      res = await fetch(`http://${handle.novncAddress}/vnc.html`).catch(() => undefined);
      if (res?.status === 200) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain("noVNC");
  }, 30_000);

  it("exec: pipes stdin, demuxes stdout/stderr, reports the exit code, honours cwd and env", async () => {
    const r = await provider.exec(handle, {
      cmd: ["sh", "-c", "cat; echo to-stderr >&2; echo cwd=$PWD; echo x=$X; exit 3"],
      stdin: "piped-in\n",
      cwd: "/work",
      env: { X: "1" },
      timeoutMs: 10_000,
    });
    expect(r).toEqual({
      stdout: "piped-in\ncwd=/work\nx=1\n",
      stderr: "to-stderr\n",
      exitCode: 3,
      timedOut: false,
    });
  });

  it("exec: works without stdin and preserves the container env", async () => {
    const r = await provider.exec(handle, { cmd: ["sh", "-c", "echo $DESKMATES_TEST"] });
    expect(r).toEqual({ stdout: "yes\n", stderr: "", exitCode: 0, timedOut: false });
  });

  it("exec: stdin larger than one socket write arrives intact", async () => {
    const big = "x".repeat(300_000);
    const r = await provider.exec(handle, { cmd: ["wc", "-c"], stdin: big, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(String(big.length));
  });

  it("exec: timeoutMs cuts the call short and the process tree is killed", async () => {
    const started = Date.now();
    const r = await provider.exec(handle, {
      cmd: ["sh", "-c", "echo before; sleep 30; echo after"],
      timeoutMs: 700,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stdout).toBe("before\n");
    const ps = await provider.exec(handle, { cmd: ["ps", "-o", "pid,args"] });
    expect(ps.stdout).not.toMatch(/sleep 30/);
  }, 30_000);

  it("injectEnv: writes a 0600 file on tmpfs that docker inspect never sees", async () => {
    const env = { ANTHROPIC_AUTH_TOKEN: `secret-${suffix}`, ANTHROPIC_BASE_URL: "http://gw:8080" };
    await provider.injectEnv(handle, env);
    const cat = await provider.exec(handle, { cmd: ["cat", ENV_FILE_PATH] });
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout).toBe(renderEnvFile(env));
    const stat = await provider.exec(handle, { cmd: ["stat", "-c", "%a", ENV_FILE_PATH] });
    expect(stat.stdout.trim()).toBe("600");
    const mount = await provider.exec(handle, {
      cmd: ["sh", "-c", "grep ' /run/deskmates ' /proc/mounts"],
    });
    expect(mount.stdout).toMatch(/tmpfs/);
    // The secret must not be visible from the host side through the Engine API.
    const inspect = await provider.client.request("GET", `/containers/${handle.providerRef}/json`);
    expect(inspect.body).not.toContain(`secret-${suffix}`);
    // Re-injecting replaces the whole file (a new run gets a new token).
    await provider.injectEnv(handle, { ANTHROPIC_AUTH_TOKEN: "rotated" });
    const again = await provider.exec(handle, { cmd: ["cat", ENV_FILE_PATH] });
    expect(again.stdout).toBe("ANTHROPIC_AUTH_TOKEN=rotated\n");
  });

  it("attach: finds the container by label, from a fresh provider instance", async () => {
    const fresh = new DockerProvider({ containerCommand: ALPINE_COMMAND });
    const found = await fresh.attach(workspaceId);
    expect(found?.providerRef).toBe(handle.providerRef);
    expect(found?.novncAddress).toBe(handle.novncAddress);
    expect(await fresh.attach("no-such-workspace" as WorkspaceId)).toBeUndefined();
  });

  it("attach: restarts a stopped container", async () => {
    await provider.client.request("POST", `/containers/${handle.providerRef}/stop?t=1`);
    const found = await provider.attach(workspaceId);
    expect(found?.providerRef).toBe(handle.providerRef);
    const r = await provider.exec(handle, { cmd: ["echo", "alive"] });
    expect(r.stdout).toBe("alive\n");
  }, 30_000);

  it("verifyTopology and attach both refuse a network added by hand (ADR-0027 amendment 2)", async () => {
    await expect(provider.verifyTopology(handle)).resolves.toBeUndefined();
    const own = (await provider.networkSubnets()).filter(
      (s) => s.name === networkName(workspaceId),
    );
    expect(own).toHaveLength(1);
    // An explicit private /24 so the check never draws from the daemon's address pools.
    const extra = `t2-extra-${suffix}`;
    const subnet = `10.231.${Math.floor(Math.random() * 250)}.0/24`;
    const made = await provider.client.request("POST", "/networks/create", {
      Name: extra,
      Internal: true,
      IPAM: { Config: [{ Subnet: subnet }] },
    });
    expect(made.status, made.body).toBe(201);
    try {
      const joined = await provider.client.request("POST", `/networks/${extra}/connect`, {
        Container: handle.providerRef,
      });
      expect(joined.status, joined.body).toBe(200);
      expect(await provider.networkSubnets()).toContainEqual({ name: extra, cidr: subnet });
      await expect(provider.verifyTopology(handle)).rejects.toThrow("mismatched network");
      const fresh = new DockerProvider({ containerCommand: ALPINE_COMMAND });
      await expect(fresh.attach(workspaceId)).rejects.toThrow("mismatched network");
    } finally {
      await provider.client.request("POST", `/networks/${extra}/disconnect`, {
        Container: handle.providerRef,
        Force: true,
      });
      await provider.client.request("DELETE", `/networks/${extra}`);
    }
    await expect(provider.verifyTopology(handle)).resolves.toBeUndefined();
  }, 30_000);

  it("create: refuses a second container for the same workspace", async () => {
    let err: unknown;
    try {
      await provider.create({
        workspaceId,
        image: IMAGE,
        env: {},
        volumes: {},
        ports: [],
        egressAllowlist: [],
      });
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code === "sandbox_unavailable").toBe(true);
    expect(isDeskmatesError(err) && err.details.reason).toBe("already_exists");
  });

  it("snapshot: commits the container to an image", async () => {
    await provider.exec(handle, { cmd: ["sh", "-c", "echo marker > /marker.txt"] });
    const snap = await provider.snapshot(handle);
    snapshotRef = snap.ref;
    expect(snap.ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Date.parse(snap.takenAt)).not.toBeNaN();
    const { json } = await provider.client.expect<{ RepoTags: string[] }>(
      "GET",
      `/images/${snap.ref}/json`,
    );
    expect(json.RepoTags[0]).toMatch(/^deskmates\/snapshot:t2-ws-/);
  }, 60_000);

  it("destroy: removes the container, keeps the named volume", async () => {
    await provider.destroy(handle);
    const gone = await provider.client.request("GET", `/containers/${handle.providerRef}/json`);
    expect(gone.status).toBe(404);
    expect(await provider.attach(workspaceId)).toBeUndefined();
    const vol = await provider.client.request("GET", `/volumes/${volume}`);
    expect(vol.status).toBe(200);
    handle = undefined as unknown as SandboxHandle;
  }, 30_000);

  it("create: a missing image is a typed error, not a raw exception", async () => {
    let err: unknown;
    try {
      await provider.create({
        workspaceId: `t2-missing-${suffix}` as WorkspaceId,
        image: "deskmates/does-not-exist:never",
        env: {},
        volumes: {},
        ports: [],
        egressAllowlist: [],
      });
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code === "sandbox_unavailable").toBe(true);
    expect(isDeskmatesError(err) && err.details.reason).toBe("image_missing");
    // Even this rejection provisions and rolls back a real proxy and workspace network.
  }, 30_000);
});

describe.skipIf(!available)("DockerProvider.removeStaleSandbox (T2, two local tags)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-up-${suffix}` as WorkspaceId;
  const volume = `deskmates-t2-up-work-${suffix}`;
  const repo = "deskmates-t2-upgrade";
  const tagA = `${repo}:a-${suffix}`;
  const tagB = `${repo}:b-${suffix}`;
  const proxyB = `${repo}:proxy-b-${suffix}`;
  const ids: Record<string, string> = {};
  let current: DockerProvider = provider;
  let handle: SandboxHandle | undefined;

  const imageId = async (ref: string): Promise<string> =>
    (await provider.client.expect<{ Id: string }>("GET", `/images/${encodeURIComponent(ref)}/json`))
      .json.Id;

  /** A distinct image made locally from `from`: a created (never started) container, committed. */
  async function derive(from: string, ref: string): Promise<void> {
    const { json } = await provider.client.expect<{ Id: string }>("POST", "/containers/create", {
      Image: from,
      Cmd: ["true"],
    });
    const [name, tag] = ref.split(":") as [string, string];
    const changes = encodeURIComponent(`LABEL deskmates.t2.variant=${tag}`);
    await provider.client.expect(
      "POST",
      `/commit?container=${json.Id}&repo=${name}&tag=${tag}&changes=${changes}`,
      {},
    );
    await provider.client.request("DELETE", `/containers/${json.Id}?force=true`);
  }

  const spec = (image: string) => ({
    workspaceId,
    image,
    env: { DESKMATES_VNC_PASSWORD: "deadbeef" },
    volumes: { "/work": volume },
    ports: [NOVNC_CONTAINER_PORT],
    egressAllowlist: [],
  });

  const runningImage = async (id: string): Promise<string> =>
    (await provider.client.expect<{ Image: string }>("GET", `/containers/${id}/json`)).json.Image;

  beforeAll(async () => {
    await requireEgressImage(provider, EGRESS_IMAGE);
    if ((await provider.client.request("GET", `/images/${IMAGE}/json`)).status !== 200) {
      const res = await provider.client.request("POST", "/images/create?fromImage=alpine&tag=3.20");
      expect(res.status).toBe(200);
    }
    const [name, tag] = tagA.split(":") as [string, string];
    const tagged = await provider.client.request(
      "POST",
      `/images/${IMAGE}/tag?repo=${name}&tag=${tag}`,
    );
    expect(tagged.status).toBe(201);
    await derive(IMAGE, tagB);
    await derive(EGRESS_IMAGE, proxyB);
    for (const ref of [tagA, tagB, proxyB, EGRESS_IMAGE]) ids[ref] = await imageId(ref);
    expect(new Set([ids[tagA], ids[tagB], ids[proxyB], ids[EGRESS_IMAGE]]).size).toBe(4);
  }, 120_000);

  afterAll(async () => {
    if (handle) await current.destroy(handle).catch(() => undefined);
    await provider.client.request("DELETE", `/volumes/${volume}?force=true`);
    for (const ref of [tagA, tagB, proxyB]) {
      await provider.client.request("DELETE", `/images/${encodeURIComponent(ref)}`);
    }
  }, 60_000);

  it("keeps a current sandbox, then recreates it on a new workspace tag with its volume", async () => {
    handle = await provider.create(spec(tagA));
    const marker = await provider.exec(handle, { cmd: ["sh", "-c", "echo kept > /work/marker"] });
    expect(marker.exitCode).toBe(0);
    expect(await provider.removeStaleSandbox(workspaceId, tagA)).toEqual([]);
    expect((await provider.attach(workspaceId))?.providerRef).toBe(handle.providerRef);

    const drift = await provider.removeStaleSandbox(workspaceId, tagB);
    expect(drift).toEqual([
      { component: "workspace", runningImageId: ids[tagA], configuredImageId: ids[tagB] },
    ]);
    const gone = await provider.client.request("GET", `/containers/${handle.providerRef}/json`);
    expect(gone.status).toBe(404);
    expect(await provider.attach(workspaceId)).toBeUndefined();
    expect((await provider.client.request("GET", `/volumes/${volume}`)).status).toBe(200);

    handle = await provider.create(spec(tagB));
    expect(await runningImage(handle.providerRef)).toBe(ids[tagB]);
    const read = await provider.exec(handle, { cmd: ["cat", "/work/marker"] });
    expect(read.stdout).toBe("kept\n");
  }, 90_000);

  it("fails closed on a missing configured image and leaves the sandbox running", async () => {
    let err: unknown;
    try {
      await provider.removeStaleSandbox(workspaceId, `${repo}:missing-${suffix}`);
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.details.reason).toBe("image_missing");
    expect((await provider.attach(workspaceId))?.providerRef).toBe(handle?.providerRef);
  }, 30_000);

  it("recreates the pair when only the egress proxy image changed", async () => {
    current = new DockerProvider({
      containerCommand: ALPINE_COMMAND,
      egressProxyImage: proxyB,
    });
    const drift = await current.removeStaleSandbox(workspaceId, tagB);
    expect(drift).toEqual([
      {
        component: "egress-proxy",
        runningImageId: ids[EGRESS_IMAGE],
        configuredImageId: ids[proxyB],
      },
    ]);
    expect(await current.attach(workspaceId)).toBeUndefined();
    handle = await current.create(spec(tagB));
    expect(await runningImage(proxyName(workspaceId))).toBe(ids[proxyB]);
    expect(await current.removeStaleSandbox(workspaceId, tagB)).toEqual([]);
    const attached = await current.attach(workspaceId);
    expect(attached?.providerRef).toBe(handle.providerRef);
    expect(attached?.novncAddress).toMatch(/^127\.0\.0\.1:\d+$/);
  }, 90_000);
});

describe.skipIf(!available)("DockerProvider.permanentlyDelete (T2, exact workspace)", () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantId = `t2-tenant-${suffix}`;
  const first = `t2-del-${suffix}` as WorkspaceId;
  const peer = `t2-del-${suffix}-peer` as WorkspaceId;
  const p = new DockerProvider({
    containerCommand: ALPINE_COMMAND,
    egressProxyImage: EGRESS_IMAGE,
  });

  const volumes = (workspaceId: WorkspaceId) => ({
    "/profile": `deskmates-${workspaceId}-profile`,
    "/work": `deskmates-${workspaceId}-work`,
    "/home/agent": `deskmates-${workspaceId}-home`,
  });
  const create = (workspaceId: WorkspaceId) =>
    p.create({
      workspaceId,
      tenantId,
      image: IMAGE,
      env: { DESKMATES_VNC_PASSWORD: "deadbeef" },
      volumes: volumes(workspaceId),
      ports: [NOVNC_CONTAINER_PORT],
      egressAllowlist: [],
    });

  beforeAll(async () => {
    await requireEgressImage(p, EGRESS_IMAGE);
    if ((await p.client.request("GET", `/images/${IMAGE}/json`)).status !== 200) {
      const pulled = await p.client.request("POST", "/images/create?fromImage=alpine&tag=3.20");
      expect(pulled.status).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await p.permanentlyDelete(first, tenantId).catch(() => undefined);
    await p.permanentlyDelete(peer, tenantId).catch(() => undefined);
  }, 60_000);

  it("removes one exact labelled resource set and leaves its prefix-similar peer intact", async () => {
    const firstHandle = await create(first);
    const peerHandle = await create(peer);
    await p.exec(peerHandle, { cmd: ["sh", "-c", "echo peer-safe > /work/marker"] });

    await p.permanentlyDelete(first, tenantId);

    expect(await p.attach(first, tenantId)).toBeUndefined();
    expect(
      (await p.client.request("GET", `/containers/${firstHandle.providerRef}/json`)).status,
    ).toBe(404);
    expect((await p.client.request("GET", `/containers/${proxyName(first)}/json`)).status).toBe(
      404,
    );
    expect((await p.client.request("GET", `/networks/deskmates-${first}`)).status).toBe(404);
    for (const name of Object.values(volumes(first))) {
      expect((await p.client.request("GET", `/volumes/${name}`)).status).toBe(404);
    }

    expect((await p.attach(peer, tenantId))?.providerRef).toBe(peerHandle.providerRef);
    for (const name of Object.values(volumes(peer))) {
      expect((await p.client.request("GET", `/volumes/${name}`)).status).toBe(200);
    }
    expect((await p.exec(peerHandle, { cmd: ["cat", "/work/marker"] })).stdout).toBe("peer-safe\n");
  }, 90_000);
});

describe("DockerProvider with an unreachable daemon", () => {
  it("returns a typed sandbox_unavailable error", async () => {
    const p = new DockerProvider({
      endpoint: { kind: "unix", socketPath: "/nonexistent/docker.sock" },
    });
    let err: unknown;
    try {
      await p.attach("x" as WorkspaceId);
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code === "sandbox_unavailable").toBe(true);
  });
});
