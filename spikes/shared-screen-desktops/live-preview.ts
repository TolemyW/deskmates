// Disposable local validation server: real Docker screens, in-memory operator data, no model.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DockerProvider } from '../../packages/sandbox-docker/src/docker-provider.js';
import { buildGateway } from '../../packages/gateway/src/index.js';
import { testConfig, TEST_OPERATOR_TOKEN } from '../../packages/gateway/src/test-support/harness.js';
const evidence = new URL('./work-runtime/', import.meta.url); await mkdir(evidence,{recursive:true});
const provider=new DockerProvider({egressProxyImage:'deskmates/egress-proxy:desktops-ui-20260924'});
const app=buildGateway(testConfig({workspaceImage:process.env.SCREEN_TEST_IMAGE??'deskmates/workspace:desktops-ui-probe'}),provider,{surface:'combined-test',startCron:false});
await app.listen({port:18093,host:'127.0.0.1'});
const api=async(method:string,path:string,body?:unknown)=>{const r=await fetch(`http://127.0.0.1:18093${path}`,{method,headers:{authorization:`Bearer ${TEST_OPERATOR_TOKEN}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;};
const {workspace}=await api('POST','/api/workspaces',{name:'Product team · shared workspace',egressAllowlist:[]});
let handle:Awaited<ReturnType<typeof provider.create>>|undefined;
let closing=false;
const close=async()=>{if(closing)return;closing=true;await app.close();if(handle)await provider.destroy(handle);for(const suffix of ['profile','work','home'])await provider.client.request('DELETE',`/volumes/deskmates-${workspace.id}-${suffix}?force=true`);process.exit(0)};
process.on('SIGTERM',close);process.on('SIGINT',close);
const bots=[];
for(const [name,role] of [['Alpha','Research and product planning'],['Beta','Review and engineering']]){const {bot}=await api('POST','/api/bots',{workspaceId:workspace.id,name,role});bots.push(bot);}
const {thread}=await api('POST','/api/threads',{workspaceId:workspace.id,botIds:bots.map(b=>b.id),title:'Product team'});
for(const bot of bots)await api('POST',`/api/bots/${bot.id}/screen/start`,{});
handle=await app.deskmates.ctx.sandboxes.peek(workspace.id);if(!handle)throw Error('missing handle');
const script=await readFile(new URL('./runtime-probe.mjs',import.meta.url),'utf8');
await provider.exec(handle,{cmd:['sh','-c','cat > /opt/deskmates/screen-probe.mjs'],stdin:script});
await provider.exec(handle,{cmd:['sh','-c','nohup node /opt/deskmates/screen-probe.mjs >/tmp/screen-probe.log 2>&1 </dev/null &']});
await writeFile(new URL('state.json',evidence),JSON.stringify({workspaceId:workspace.id,botIds:bots.map(b=>b.id),threadId:thread.id,container:handle.providerRef},null,2));
console.log('PREVIEW_READY http://127.0.0.1:15373');
for(let i=0;i<120;i++){const check=await provider.exec(handle,{cmd:['sh','-c','test -f /tmp/screen-probe-result.json && cat /tmp/screen-probe-result.json'],timeoutMs:3000});if(check.exitCode===0){await writeFile(new URL('result.json',evidence),check.stdout);console.log('MCP_SCREEN_PROBE_PASSED');break;}if(i===119){const logs=await provider.exec(handle,{cmd:['cat','/tmp/screen-probe.log']});console.error(logs.stdout,logs.stderr);}await new Promise(r=>setTimeout(r,500));}
