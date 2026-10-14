// Isolated T2 driver: real proxy + pinned MCP + Chromium + Gateway, no model.
// Configuration (only short-lived run tokens) arrives on stdin and is never printed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const config=JSON.parse(Buffer.concat(chunks).toString());
const children=[];
async function client(c) {
 const child=spawn('deskmates-sidecar',['mcp-proxy','--','playwright-mcp','--cdp-endpoint','http://127.0.0.1:9222','--caps','vision'],{
   stdio:['pipe','pipe','inherit'],env:{...process.env,DESKMATES_BROWSER_COORDINATION:JSON.stringify(c),DESKMATES_SCREENSHOT_DIR:`/tmp/shots-${c.runId}`}});
 children.push(child); let n=0;const pending=new Map();
 createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'m2-runtime-check',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tool=(name,args={})=>call('tools/call',{name,arguments:args});
 return {tool,child,state:async()=>JSON.parse(await readFile(c.statePath,'utf8'))};
}
const ok=(r)=>{assert(!r.isError,JSON.stringify(r));return r;};
const text=(r)=>r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
const buttonRef=(r,label)=>{const match=new RegExp(`button "Increment ${label}" \\[ref=([^\\]]+)\\]`).exec(text(ok(r)));assert(match,`missing ${label} button ref: ${text(r)}`);return match[1];};
const counter=(r,label)=>{const match=new RegExp(`${label} count: (\\d+)`).exec(text(ok(r)));assert(match,`missing ${label} counter: ${text(r)}`);return Number(match[1]);};
const fixture=(label)=>`async(page)=>{await page.setContent(${JSON.stringify('<!doctype html><title>Click stability</title><h1>RUN_LABEL_ONLY</h1><button id="increment">Increment LABEL</button><output id="count">LABEL count: 0</output><script>let count=0;document.querySelector("#increment").addEventListener("click",()=>{count+=1;document.querySelector("#count").textContent="LABEL count: "+count;});</script>'.replaceAll('LABEL',label))});return 'ready';}`;
async function awaitHostDecision(phase) {
 const ready=`${config.controlPath}-${phase}-ready`;
 const done=`${config.controlPath}-${phase}-done`;
 await writeFile(ready,'');
 const deadline=Date.now()+30_000;
 for (;;) {
  try {await readFile(done);return;} catch (error) {if(error.code!=='ENOENT')throw error;}
  if(Date.now()>deadline)throw new Error(`host did not complete ${phase}`);
  await new Promise(resolve=>setTimeout(resolve,100));
 }
}
try {
 const [a,b]=await Promise.all(config.runs.map(client));
 ok(await a.tool('browser_navigate',{url:config.site+'/login?bot=a'}));
 ok(await b.tool('browser_navigate',{url:config.site+'/login?bot=b'}));
 const sa=await a.state(),sb=await b.state();assert.notEqual(sa.tabId,sb.tabId);
 const nav=await Promise.all([a.tool('browser_snapshot'),b.tool('browser_snapshot')]);nav.forEach(ok);
 assert(text(nav[0]).includes('bot=a'));assert(text(nav[1]).includes('bot=b'));
 ok(await a.tool('browser_run_code_unsafe',{code:`async(page)=>{await page.context().addCookies([{name:'m2shared',value:'yes',url:${JSON.stringify(config.site)}}]);return 'set';}`}));
 assert(text(ok(await b.tool('browser_run_code_unsafe',{code:`async(page)=>(await page.context().cookies(${JSON.stringify(config.site)})).filter(c=>c.name==='m2shared').map(c=>c.value)`}))).includes('yes'));
 // Listing establishes this connection's view; numeric indices are never shared across clients.
 ok(await b.tool('browser_tabs',{action:'list'}));
 const view=await b.state();const aIndex=view.tabs.findIndex(t=>t.id===sa.tabId);assert(aIndex>=0);
 const conflict=await b.tool('browser_tabs',{action:'select',index:aIndex});assert(conflict.isError);assert(text(conflict).includes('Another run'));
 // Restart the proxy (as an approval resume does) while retaining its run metadata.
 a.child.kill('SIGTERM');await new Promise(r=>a.child.once('exit',r));
 const resumed=await client(config.runs[0]);ok(await resumed.tool('browser_snapshot'));
 assert.equal((await resumed.state()).tabId,sa.tabId);
 await awaitHostDecision('takeover');
 const blocked=await Promise.all([resumed.tool('browser_navigate',{url:config.site+'/login?blocked=a'}),b.tool('browser_snapshot')]);
 assert(blocked.every(r=>r.isError));
 assert((await readFile(`/tmp/shots-${config.runs[0].runId}/1.json`,'utf8')).includes('skipped'));
 await awaitHostDecision('handback');
 const returned=await Promise.all([resumed.tool('browser_snapshot'),b.tool('browser_snapshot')]);returned.forEach(ok);
 assert(text(returned[0]).includes('bot=a'));assert(text(returned[1]).includes('bot=b'));
 // Ordinary browser_click is the action under test: fixture JS only creates each run's button and
 // counter. Eight paired calls are dispatched concurrently, with no force or evaluate-click path.
 (await Promise.all([
  resumed.tool('browser_run_code_unsafe',{code:fixture('A')}),
  b.tool('browser_run_code_unsafe',{code:fixture('B')}),
 ])).forEach(ok);
 const prepared=await Promise.all([resumed.tool('browser_snapshot'),b.tool('browser_snapshot')]);
 const refs=[buttonRef(prepared[0],'A'),buttonRef(prepared[1],'B')];
 let ordinaryClickCalls=0;
 for(let round=0;round<8;round+=1){
  const clicks=await Promise.all([
   resumed.tool('browser_click',{target:refs[0]}),
   b.tool('browser_click',{target:refs[1]}),
  ]);clicks.forEach(ok);ordinaryClickCalls+=clicks.length;
 }
 const counted=await Promise.all([resumed.tool('browser_snapshot'),b.tool('browser_snapshot')]);counted.forEach(ok);
 const counters=[counter(counted[0],'A'),counter(counted[1],'B')];assert.deepEqual(counters,[8,8]);
 assert(text(counted[0]).includes('RUN_A_ONLY'));assert(!text(counted[0]).includes('RUN_B_ONLY'));
 assert(text(counted[1]).includes('RUN_B_ONLY'));assert(!text(counted[1]).includes('RUN_A_ONLY'));
 // Every completed click must retain an image of its own stable target. Previously this
 // test only checked counters and let background screenshot timeouts go unnoticed.
 const clickCaptures=[];
 for(const [index,target] of [sa.tabId,sb.tabId].entries()){
  const dir=`/tmp/shots-${config.runs[index].runId}`;
  const files=await readdir(dir);
  const shots=await Promise.all(files.filter(name=>name.endsWith('.json')).map(async name=>JSON.parse(await readFile(`${dir}/${name}`,'utf8'))));
  const clicks=shots.filter(shot=>shot.toolName==='browser_click');
  assert.equal(clicks.length,8,`run ${index}: expected one capture per click`);
  for(const shot of clicks){
   assert.equal(shot.skipped,undefined,`run ${index}: ${shot.skipped}`);
   assert.equal(shot.tabId,target,'capture attributed to a different target');
   assert.equal(shot.mimeType,'image/jpeg');
   assert(shot.bytes>0&&shot.bytes<=300000,'capture byte cap');
   assert.equal(Buffer.from(shot.base64,'base64').length,shot.bytes);
  }
  clickCaptures.push(clicks.length);
 }
 const closed=ok(await resumed.tool('browser_close'));assert(!text(closed).includes('bot=b'));ok(await b.tool('browser_snapshot'));
 assert.equal((await b.state()).tabId,sb.tabId);
 console.log(JSON.stringify({passed:true,checks:['distinct stable targets','concurrent own-page snapshots','shared cookies','same-tab contention','proxy restart restores target','human takeover blocks both','capture skipped while held','handback restores both','resumed target ordinary click','eight concurrent click rounds','exact counters with no cross-write','close leaves peer usable'],clickRounds:8,ordinaryClickCalls,counters,clickCaptures,tabIds:[sa.tabId,sb.tabId]}));
} finally {for(const child of children)child.kill('SIGTERM');}
