// ADR-0027 amendment 1: the real egress proxy admits a granted LAN HTTP origin on a custom port,
// by IP literal, with the URL unchanged; revocation closes an open request; another workspace's
// proxy and its open request are untouched; `*` and the proxy's own network stay denied.
//
// The "LAN" service is a host-network fixture bound to one RFC1918 address of the Docker host
// that is not on any Docker bridge, which is what a LAN peer looks like from the proxy: reached
// through the bridge gateway, outside the proxy's own subnets. Owns every object by a random
// exact name; never joins or changes another network or container.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { egressProxyImage } from "./support/docker.js";

const image = egressProxyImage();
const nonce = randomUUID().slice(0, 8);
const nets = [`lan-egress-a-${nonce}`, `lan-egress-b-${nonce}`] as const;
const proxies = [`lan-proxy-a-${nonce}`, `lan-proxy-b-${nonce}`] as const;
const fixture = `lan-fixture-${nonce}`;
const port = 40000 + Math.floor(Math.random() * 9000);
const temp = mkdtempSync(join(tmpdir(), "lan-egress-"));
const available = spawnSync("docker", ["info"], { timeout: 3000, stdio: "ignore" }).status === 0;
if (!available) console.warn("[lan-egress] skipped: Docker unavailable");

function docker(args: string[], input?: string): string {
  const r = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`${args[0]}: ${r.stderr} ${r.stdout}`);
  return r.stdout.trim();
}

/** An RFC1918 IPv4 address of the Docker host that is not a Docker bridge or loopback. */
function hostLanAddress(): string | undefined {
  const out = docker([
    "run",
    "--rm",
    "--network",
    "host",
    "--entrypoint",
    "node",
    image,
    "-e",
    "const o=require('os').networkInterfaces();for(const[n,l]of Object.entries(o))for(const e of l)if(e.family==='IPv4'&&!e.internal&&!/^(docker|br-|veth|cni|flannel)/.test(n))console.log(e.address)",
  ]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a));
}

// GET through the proxy in absolute form, as Chromium and curl send plain HTTP to a proxy.
const getScript = `
const http=require('http');const [proxy,url,mode]=process.argv.slice(1);
const u=new URL(url);
const req=http.request({host:proxy,port:3128,method:'GET',path:url,headers:{host:u.host}},res=>{
 let body='';res.on('data',d=>{body+=d;if(mode==='hold'&&body.includes('first'))console.log('OPEN');});
 res.on('end',()=>console.log('STATUS:'+res.statusCode+' '+body.trim()));
 res.on('error',()=>console.log('CUT'));res.on('aborted',()=>console.log('CUT'));
});req.on('error',e=>console.log('CUT:'+e.message));req.setTimeout(9000,()=>req.destroy());req.end();
`;
const connectScript = `
const http=require('http');const [proxy,target]=process.argv.slice(1);
const req=http.request({host:proxy,port:3128,method:'CONNECT',path:target});
req.on('connect',(res,s)=>{console.log('CONNECT:'+res.statusCode);s.destroy();});
req.on('error',e=>console.log('ERR:'+e.message));req.end();
`;

function nodeIn(network: string, script: string, args: string[]) {
  return [
    "run",
    "--rm",
    "--network",
    network,
    "--entrypoint",
    "node",
    image,
    "-e",
    script,
    ...args,
  ];
}

function get(which: 0 | 1, url: string): string {
  return docker(nodeIn(nets[which], getScript, [proxies[which], url]));
}

/** Starts a slow request and resolves with its final output once it has started streaming. */
async function hold(which: 0 | 1, url: string): Promise<Promise<string>> {
  const child = spawn("docker", nodeIn(nets[which], getScript, [proxies[which], url, "hold"]));
  let output = "";
  const done = new Promise<string>((resolve) => child.on("exit", () => resolve(output)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request did not open: ${output}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("OPEN")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return done;
}

function publish(which: 0 | 1, allowlist: string[], grants: unknown[]): void {
  const text =
    grants.length === 0
      ? allowlist.length === 0
        ? ""
        : `${[...allowlist].sort().join("\n")}\n`
      : JSON.stringify({ version: 2, allowlist, privateTargets: [], grants });
  const hash = createHash("sha256").update(text).digest("hex");
  docker(
    [
      "exec",
      "-i",
      proxies[which],
      "sh",
      "-c",
      'cat > /run/deskmates-egress/allowlist.tmp && mv /run/deskmates-egress/allowlist.tmp /run/deskmates-egress/allowlist && kill -HUP 1; i=0; while [ "$i" -lt 100 ]; do [ "$(cat /run/deskmates-egress/allowlist.sha256)" = "$0" ] && exit 0; i=$((i+1)); sleep 0.05; done; exit 1',
      hash,
    ],
    text,
  );
}

const created = new Set<string>();
afterAll(() => {
  for (const name of [...proxies, fixture])
    if (created.has(name)) spawnSync("docker", ["rm", "-f", name], { timeout: 15000 });
  for (const name of nets)
    if (created.has(name)) spawnSync("docker", ["network", "rm", name], { timeout: 15000 });
  rmSync(temp, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!available)("LAN network-profile grants in the real proxy", () => {
  it("admits a granted LAN HTTP origin on a custom port, revokes it, and leaves others alone", async () => {
    const lanIp = hostLanAddress();
    if (lanIp === undefined) {
      console.warn("[lan-egress] skipped: the Docker host has no non-bridge RFC1918 address");
      return;
    }
    writeFileSync(
      join(temp, "server.cjs"),
      `require('http').createServer((q,r)=>{if(q.url==='/slow'){r.write('first\\n');setTimeout(()=>r.end('last'),4000);return;}r.end('lan-fixture-ok '+q.url);}).listen(${port},'${lanIp}');`,
    );
    docker([
      "run",
      "-d",
      "--name",
      fixture,
      "--network",
      "host",
      "--mount",
      `type=bind,src=${temp},dst=/fixture,readonly`,
      "--entrypoint",
      "node",
      image,
      "/fixture/server.cjs",
    ]);
    created.add(fixture);
    for (const [i, net] of nets.entries()) {
      docker(["network", "create", net]);
      created.add(net);
      docker([
        "run",
        "-d",
        "--name",
        proxies[i] as string,
        "--network",
        net,
        "--read-only",
        "--tmpfs",
        "/run/deskmates-egress:uid=1000,gid=1000,mode=0700",
        "-e",
        "DESKMATES_HOST_TARGET=172.17.0.1",
        "-e",
        "DESKMATES_HOST_FALLBACK_IP=172.17.0.1",
        image,
      ]);
      created.add(proxies[i] as string);
    }
    for (const name of proxies) {
      let ready = false;
      for (let i = 0; i < 50 && !ready; i++) {
        ready = docker(["logs", name]).includes("egress proxy ready");
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      expect(ready, docker(["logs", name])).toBe(true);
    }
    const grant = { kind: "subnet", cidr: `${lanIp}/32`, schemes: ["http"], ports: [port] };
    const url = `http://${lanIp}:${port}/health?x=1`;

    // Deny-all start, and `*` never implies LAN access.
    expect(get(0, url)).toContain("STATUS:403");
    publish(0, ["*"], []);
    expect(get(0, url)).toContain("STATUS:403");

    // The granted origin, original URL, custom port, plain HTTP.
    publish(0, [], [grant]);
    expect(get(0, url)).toBe("STATUS:200 lan-fixture-ok /health?x=1");
    expect(get(0, `http://${lanIp}:${port + 1}/`)).toContain("STATUS:403");
    expect(docker(nodeIn(nets[0], connectScript, [proxies[0], `${lanIp}:${port}`]))).toContain(
      "CONNECT:403",
    );

    // A grant aimed at the proxy's own network is refused (decision 11).
    const ownSubnet = docker([
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Subnet}}",
      nets[0],
    ]);
    const ownGateway = docker([
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      nets[0],
    ]);
    publish(0, [], [{ kind: "subnet", cidr: ownSubnet, schemes: ["http"], ports: [3128] }]);
    expect(get(0, `http://${ownGateway}:3128/`)).toContain("STATUS:403");

    // Two workspaces with the grant; revoking A cuts A's open request and only A's.
    publish(0, [], [grant]);
    publish(1, [], [grant]);
    const inA = await hold(0, `http://${lanIp}:${port}/slow`);
    const inB = await hold(1, `http://${lanIp}:${port}/slow`);
    publish(0, [], []);
    expect(await inA).toMatch(/CUT/);
    expect(await inB).toContain("STATUS:200");
    expect(get(0, url)).toContain("STATUS:403");
    expect(get(1, url)).toContain("STATUS:200");

    // Expiry denies new requests without a republish.
    publish(1, [], [{ ...grant, expiresAt: new Date(Date.now() + 1500).toISOString() }]);
    expect(get(1, url)).toContain("STATUS:200");
    await new Promise((r) => setTimeout(r, 2000));
    expect(get(1, url)).toContain("STATUS:403");
  }, 180_000);
});
