// ADR-0027: real proxy, isolated RFC1918 fixture, trusted TLS and live tunnel revocation.
// Owns every object by a random exact name; never joins/changes stable workspace networks.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { egressProxyImage } from "./support/docker.js";
const image = egressProxyImage();
const nonce = randomUUID().slice(0, 8);
const network = `private-egress-test-${nonce}`;
const proxy = `private-proxy-${nonce}`;
const fixture = `private-fixture-${nonce}`;
const temp = mkdtempSync(join(tmpdir(), "private-egress-"));
const available = spawnSync("docker", ["info"], { timeout: 3000, stdio: "ignore" }).status === 0;
if (!available) console.warn("[private-egress] skipped: Docker unavailable");
function docker(args: string[], input?: string): string {
  const r = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`${args[0]}: ${r.stderr} ${r.stdout}`);
  return r.stdout.trim();
}
const probeScript = `
const http=require('http'), tls=require('tls'), fs=require('fs');
const [proxy,host,port,mode]=process.argv.slice(1);
const request=http.request({host:proxy,port:3128,method:'CONNECT',path:host+':'+port});
request.on('connect',(res,socket)=>{
 if(res.statusCode!==200){console.log('DENIED:'+res.statusCode);socket.destroy();return;}
 if(mode==='hold'){
   console.log('OPEN');setTimeout(()=>console.log('CLOSED:'+socket.destroyed),3500);
   socket.on('error',()=>{});return;
 }
 const secure=tls.connect({socket,servername:host,ca:fs.readFileSync('/fixture/cert.pem')},()=>{
   secure.write('GET / HTTP/1.1\\r\\nHost: '+host+'\\r\\nConnection: close\\r\\n\\r\\n');
 });
 let data='';secure.on('data',d=>data+=d);secure.on('end',()=>console.log(data.includes('private-fixture-ok')?'VERIFIED':'BAD'));
 secure.on('error',e=>{console.error(e.message);process.exitCode=1;});
});request.on('error',e=>{console.error(e.message);process.exitCode=1;});
request.setTimeout(6000,()=>{request.destroy();process.exitCode=1;});request.end();
`;
// Bind only the public certificate: mkdtemp is 0700 and the host UID need not match Node's UID.
function probe(host = "private.test", port = "443", mode = "fetch"): string {
  return docker([
    "run",
    "--rm",
    "--network",
    network,
    "--mount",
    `type=bind,src=${join(temp, "cert.pem")},dst=/fixture/cert.pem,readonly`,
    "--entrypoint",
    "node",
    image,
    "-e",
    probeScript,
    proxy,
    host,
    port,
    mode,
  ]);
}
async function revokeOpenTunnel(address: string, future: string): Promise<string> {
  const child = spawn("docker", [
    "run",
    "--rm",
    "--network",
    network,
    "--mount",
    `type=bind,src=${join(temp, "cert.pem")},dst=/fixture/cert.pem,readonly`,
    "--entrypoint",
    "node",
    image,
    "-e",
    probeScript,
    proxy,
    "private.test",
    "443",
    "hold",
  ]);
  let output = "";
  const completed = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("tunnel did not open"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("OPEN")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  publish([], address, future);
  return completed;
}
function publish(allowlist: string[], address: string, expiresAt: string): void {
  const text = JSON.stringify({
    version: 1,
    allowlist,
    privateTargets: [
      { workspaceId: "fixture_ws", hostname: "private.test", address, port: 443, expiresAt },
    ],
  });
  const hash = createHash("sha256").update(text).digest("hex");
  docker(
    [
      "exec",
      "-i",
      proxy,
      "sh",
      "-c",
      'cat > /run/deskmates-egress/allowlist.tmp && mv /run/deskmates-egress/allowlist.tmp /run/deskmates-egress/allowlist && kill -HUP 1; i=0; while [ "$i" -lt 100 ]; do [ "$(cat /run/deskmates-egress/allowlist.sha256)" = "$0" ] && exit 0; i=$((i+1)); sleep 0.05; done; exit 1',
      hash,
    ],
    text,
  );
}
// Only delete exact resources that this test created, even after a partial setup failure.
const created = new Set<string>();
afterAll(() => {
  for (const name of [proxy, fixture])
    if (created.has(name)) spawnSync("docker", ["rm", "-f", name], { timeout: 15000 });
  if (created.has(network)) spawnSync("docker", ["network", "rm", network], { timeout: 15000 });
  rmSync(temp, { recursive: true, force: true });
}, 60_000);
describe.skipIf(!available)("private HTTPS proxy in Docker", () => {
  it("enforces exact grants, verified TLS, expiry, revoke, and restart deny-all", async () => {
    const cert = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(temp, "key.pem"),
        "-out",
        join(temp, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=private.test",
        "-addext",
        "subjectAltName=DNS:private.test",
      ],
      { encoding: "utf8" },
    );
    expect(cert.status, cert.stderr).toBe(0);
    writeFileSync(
      join(temp, "server.cjs"),
      `require('https').createServer({key:require('fs').readFileSync('/fixture/key.pem'),cert:require('fs').readFileSync('/fixture/cert.pem')},(_,r)=>r.end('private-fixture-ok')).listen(443,'0.0.0.0');`,
    );
    docker(["network", "create", network]);
    created.add(network);
    docker([
      "run",
      "-d",
      "--name",
      fixture,
      "--network",
      network,
      "--user",
      "0",
      "--mount",
      `type=bind,src=${temp},dst=/fixture,readonly`,
      "--entrypoint",
      "node",
      image,
      "/fixture/server.cjs",
    ]);
    created.add(fixture);
    const address = docker([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      fixture,
    ]);
    docker([
      "run",
      "-d",
      "--name",
      proxy,
      "--network",
      network,
      "--read-only",
      "--tmpfs",
      "/run/deskmates-egress:uid=1000,gid=1000,mode=0700",
      "-e",
      "DESKMATES_HOST_TARGET=172.17.0.1",
      "-e",
      "DESKMATES_HOST_FALLBACK_IP=172.17.0.1",
      image,
    ]);
    created.add(proxy);
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (docker(["logs", proxy]).includes("egress proxy ready")) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready, docker(["logs", proxy])).toBe(true);
    const future = new Date(Date.now() + 60_000).toISOString();
    publish(["private.test"], address, future);
    expect(probe()).toBe("VERIFIED");
    expect(probe("private.test", "444")).toContain("DENIED:403");
    expect(probe(address)).toContain("DENIED:403");
    expect(probe("other.test")).toContain("DENIED:403");
    publish(["*"], address, future);
    expect(probe()).toContain("DENIED:403");
    publish(["private.test"], address, new Date(Date.now() + 2500).toISOString());
    expect(probe("private.test", "443", "hold")).toContain("CLOSED:true");
    expect(probe()).toContain("DENIED:403");
    publish(["private.test"], address, future);
    expect(probe()).toBe("VERIFIED");
    expect(await revokeOpenTunnel(address, future)).toContain("CLOSED:true");
    expect(probe()).toContain("DENIED:403");
    publish(["private.test"], address, future);
    docker(["restart", proxy]);
    expect(probe()).toContain("DENIED:403");
  }, 120_000);
});
