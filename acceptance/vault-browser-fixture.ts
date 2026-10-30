// Test-only TLS/bootstrap for the Vault T2 suite. The synthetic hostname resolves only inside
// its exact owned container. Install a generated CA in that container's NSS database and bypass
// its egress proxy only for this loopback fixture; never disable TLS certificate verification.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "./support/start-stack.js";

export const VAULT_FIXTURE_HOST = "vault.example.test";

export async function containerNode(
  stack: Stack,
  script: string,
  input: unknown = {},
): Promise<string> {
  const out = await stack.provider.exec(stack.handle, {
    cmd: ["node", "--input-type=module", "-e", script],
    stdin: JSON.stringify(input),
    timeoutMs: 30_000,
  });
  if (out.exitCode !== 0) throw new Error(`Vault fixture failed: ${out.stderr.slice(-2000)}`);
  return out.stdout.trim();
}

const BOOTSTRAP = String.raw`
import fs from 'node:fs';
let text='';for await(const part of process.stdin)text+=part;
const files=JSON.parse(text);
fs.mkdirSync('/root/.pki/nssdb',{recursive:true});
fs.mkdirSync('/run/vault-fixture',{recursive:true});
for(const [path,bytes]of Object.entries(files))fs.writeFileSync(path,Buffer.from(bytes,'base64'),{mode:0o600});
const path='/usr/local/bin/deskmates-entry';
let entry=fs.readFileSync(path,'utf8');
const before='--proxy-bypass-list="localhost;127.0.0.1;[::1]"';
if(!entry.includes(before))throw Error('unexpected fixture entrypoint');
entry=entry.replace(before,'--proxy-bypass-list="localhost;127.0.0.1;[::1];vault.example.test"');
const resolver='RESOLVER_RULES="MAP * ~NOTFOUND';
if(!entry.includes(resolver))throw Error('unexpected fixture resolver setup');
entry=entry.replace(resolver,'RESOLVER_RULES="MAP vault.example.test 127.0.0.1, MAP * ~NOTFOUND');
fs.writeFileSync(path,entry);
fs.appendFileSync('/etc/hosts','\n127.0.0.1 vault.example.test\n');
console.log('fixture CA and exact loopback hostname installed');
`;

const SERVER = String.raw`
import fs from 'node:fs';
import https from 'node:https';
const html='<!doctype html><title>Vault synthetic HTTPS fixture</title><form onsubmit="event.preventDefault()"><label>Email<input id="u" type="email" autocomplete="off"></label><label>Password<input id="p" type="password" autocomplete="off"></label><button>Sign in</button></form>';
const server=https.createServer({key:fs.readFileSync('/run/vault-fixture/key.pem'),cert:fs.readFileSync('/run/vault-fixture/cert.pem')},(q,r)=>{
 r.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});r.end(html);
});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync('/run/vault-fixture/ready.json',JSON.stringify({port:server.address().port})));
`;

export async function installVaultHttpsFixture(stack: Stack): Promise<string> {
  const dir = join(stack.tmpDir, "vault-tls");
  const nss = join(dir, "nssdb");
  mkdirSync(nss, { recursive: true });
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const command = (program: string, args: string[]) => {
    const out = spawnSync(program, args, { encoding: "utf8", timeout: 30_000 });
    if (out.status !== 0)
      throw new Error(`Vault TLS fixture needs ${program}: ${out.error?.message ?? out.stderr}`);
  };
  command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    `/CN=${VAULT_FIXTURE_HOST}`,
    "-addext",
    `subjectAltName=DNS:${VAULT_FIXTURE_HOST}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  command("certutil", ["-N", "--empty-password", "-d", `sql:${nss}`]);
  command("certutil", ["-A", "-d", `sql:${nss}`, "-n", "vault-fixture", "-t", "C,,", "-i", cert]);
  const files: Record<string, string> = {
    "/run/vault-fixture/cert.pem": readFileSync(cert).toString("base64"),
    "/run/vault-fixture/key.pem": readFileSync(key).toString("base64"),
    "/run/vault-fixture/server.mjs": Buffer.from(SERVER).toString("base64"),
  };
  for (const name of ["cert9.db", "key4.db", "pkcs11.txt"])
    files[`/root/.pki/nssdb/${name}`] = readFileSync(join(nss, name)).toString("base64");
  await containerNode(stack, BOOTSTRAP, files);
  // This is the suite's freshly provisioned random container, before any test run starts.
  const restart = await stack.docker.client.request(
    "POST",
    `/containers/${stack.handle.providerRef}/restart?t=5`,
  );
  if (restart.status !== 204) throw new Error(`fixture restart: HTTP ${restart.status}`);
  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline) {
    const out = await stack.provider.exec(stack.handle, {
      cmd: ["deskmates-healthz"],
      timeoutMs: 5000,
    });
    if (out.exitCode === 0) {
      healthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error("fixture workspace did not restart");
  await containerNode(
    stack,
    String.raw`
import {spawn}from'node:child_process';
const child=spawn(process.execPath,['/run/vault-fixture/server.mjs'],{detached:true,stdio:'ignore'});child.unref();
`,
  );
  const ready = await containerNode(
    stack,
    String.raw`
import fs from'node:fs/promises';
const deadline=Date.now()+10000;
while(Date.now()<deadline){try{console.log(await fs.readFile('/run/vault-fixture/ready.json','utf8'));process.exit(0);}catch{await new Promise(ok=>setTimeout(ok,100));}}
throw Error('TLS fixture did not listen');
`,
  );
  const port = (JSON.parse(ready) as { port: number }).port;
  const changed = await stack.api("PATCH", `/api/workspaces/${stack.workspace.id}`, {
    egressAllowlist: [new URL(stack.siteOriginForBot).hostname, VAULT_FIXTURE_HOST],
  });
  if (changed.status !== 200) throw new Error(`fixture allowlist: HTTP ${changed.status}`);
  const origin = `https://${VAULT_FIXTURE_HOST}:${port}`;
  await containerNode(
    stack,
    String.raw`
import{createRequire}from'node:module';
const{chromium}=createRequire('/opt/deskmates/package.json')('playwright');
let text='';for await(const part of process.stdin)text+=part;
const{origin}=JSON.parse(text);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=await browser.contexts()[0].newPage();
await page.goto(origin+'/login');
if(!await page.evaluate(()=>window.isSecureContext&&document.querySelector('#p')?.type==='password'))throw Error('HTTPS fixture preflight failed');
await page.close();await browser.close();
`,
    { origin },
  );
  return origin;
}

/** Uses the shared browser for fixture assertions; values are reduced to booleans in-container. */
export const INSPECT_FIXTURE = String.raw`
import{createRequire}from'node:module';
const require=createRequire('/opt/deskmates/package.json');
const{chromium}=require('playwright');
let text='';for await(const part of process.stdin)text+=part;
const{origin,username,password}=JSON.parse(text);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith(origin));
if(!page)throw Error('fixture page missing');
const answer=await page.evaluate(({username,password})=>({secure:window.isSecureContext,usernameMatches:document.querySelector('#u')?.value===username,passwordMatches:document.querySelector('#p')?.value===password,usernameEmpty:document.querySelector('#u')?.value==='',passwordEmpty:document.querySelector('#p')?.value==='',path:location.pathname}),{username,password});
console.log(JSON.stringify(answer));await browser.close();
`;

/** Scan only normal SDK transcripts and learned-memory outputs, returning counts, never text. */
export const AUDIT_VAULT_OUTPUTS = String.raw`
import fs from'node:fs/promises';
import path from'node:path';
let text='';for await(const part of process.stdin)text+=part;
const{home,canaries}=JSON.parse(text);
const files=async(dir)=>{let list;try{list=await fs.readdir(dir,{withFileTypes:true});}catch{return[];}
 const nested=await Promise.all(list.map(e=>e.isDirectory()?files(path.join(dir,e.name)):e.isFile()?[path.join(dir,e.name)]:[]));return nested.flat();};
const sdk=await files(path.join(home,'.claude'));
const memory=[path.join(home,'MEMORY.md'),...await files(path.join(home,'memory'))];
let canaryFiles=0;
for(const file of [...sdk,...memory]){try{const bytes=await fs.readFile(file,'utf8');if(canaries.some(c=>bytes.includes(c)))canaryFiles++;}catch{}}
console.log(JSON.stringify({sdkFiles:sdk.length,memoryFiles:memory.length,canaryFiles}));
`;

/** Force a real same-document navigation between the actual helper's frame lookup and fill. */
export const NAVIGATE_DURING_FILL = String.raw`
import{vaultFill,cdpFillDeps}from'/opt/deskmates/sidecar/dist/vault-fill.js';
let text='';for await(const part of process.stdin)text+=part;
const input=JSON.parse(text);
const real=cdpFillDeps('http://127.0.0.1:9222');
const target=await(await fetch('http://127.0.0.1:9222/json/new?'+encodeURIComponent(input.origin+'/login'),{method:'PUT'})).json();
input.tabId=target.id;
const probe=await real.connect(target.webSocketDebuggerUrl);
let ready=false;
for(let i=0;i<100;i++){
 const answer=await probe.send('Runtime.evaluate',{expression:"location.pathname==='/login'&&document.readyState==='complete'",returnByValue:true});
 if(answer.result?.value===true){ready=true;break;}await new Promise(ok=>setTimeout(ok,50));
}
if(!ready)throw Error('navigation fixture did not become ready');
probe.close();
let changed=false;
const output=await vaultFill(input,{...real,connect:async(url)=>{
 const session=await real.connect(url);
 return{close:()=>session.close(),send:async(method,params)=>{
  if(method==='Runtime.callFunctionOn'&&!changed){changed=true;await session.send('Page.navigate',{url:input.origin+'/login#changed'});}
  return session.send(method,params);
 }};
}});
const inspect=await real.connect(target.webSocketDebuggerUrl);
const final=await inspect.send('Runtime.evaluate',{expression:"document.querySelector('#u').value===''&&document.querySelector('#p').value===''",returnByValue:true});
inspect.close();
console.log(JSON.stringify({output,changed,fieldsEmpty:final.result?.value===true}));
`;
