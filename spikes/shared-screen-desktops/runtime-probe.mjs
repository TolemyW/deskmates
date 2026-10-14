// Runs inside the candidate workspace. Uses the pinned MCP and real BrowserCoordinator; no model.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { BrowserCoordinator } from '/opt/deskmates/sidecar/dist/mcp-proxy/browser-coordinator.js';
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<html><body style="background:${req.url.includes('alpha')?'#bce6d7':'#c4d1ff'};font:32px sans-serif;padding:40px"><h1>${req.url.includes('alpha')?'ALPHA · RESEARCH':'BETA · REVIEW'}</h1><p>Shared workspace · Independent window</p><button style="padding:25px;font-size:32px" onclick="this.textContent=String(++window.count)">0</button><script>window.count=0</script></body></html>`)});
await new Promise(r=>server.listen(8877,'127.0.0.1',r));
async function session(slot){
 const child=spawn('node',['/usr/lib/node_modules/@playwright/mcp/cli.js','--cdp-endpoint','http://127.0.0.1:9222','--caps','vision'],{stdio:['pipe','pipe','inherit']});
 let id=0,buffer='';const waiting=new Map();
 child.stdout.on('data',d=>{buffer+=d;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;const msg=JSON.parse(line);waiting.get(msg.id)?.(msg);waiting.delete(msg.id);}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timeout=setTimeout(()=>reject(Error('MCP timeout '+method)),30000);waiting.set(key,msg=>{clearTimeout(timeout);if(msg.error)reject(Error(JSON.stringify(msg.error)));else resolve(msg.result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n')});
 await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'screen-probe',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const rpc=async c=>{const r=await call('tools/call',c);if(r.isError)throw Error(JSON.stringify(r));return r};
 const coord=new BrowserCoordinator({runId:`screen-probe-${slot}`,gatewayBaseUrl:'http://test',token:'fixture',statePath:'/unused',screenSlot:slot},{read:async()=>undefined,write:async()=>{},client:{browserLock:async()=>({granted:true,epoch:0})}});
 const execute=async c=>{const prepared=await coord.before(c,rpc);const result=await rpc(prepared);await coord.after(c,rpc,result);return result};
 return {rpc,coord,execute,child};
}
const sessions=await Promise.all([session(0),session(1)]);
const code=code=>({name:'browser_run_code_unsafe',arguments:{code}});
await Promise.all(sessions.map((s,i)=>s.execute({name:'browser_navigate',arguments:{url:`http://localhost:8877/${i===0?'alpha':'beta'}`}})));
await sessions[0].execute(code(`async page => { await page.evaluate(()=>{document.cookie='shared_login=verified; path=/'}); return true; }`));
for(let i=0;i<12;i++)await Promise.all(sessions.map(s=>s.execute(code(`async page => { await page.getByRole('button').click(); return page.evaluate(()=>window.count); }`))));
function result(r){const text=r.content.map(c=>c.text??'').join('\n');const m=/^### Result\n([^\n]+)/m.exec(text);if(!m)throw Error(text);return JSON.parse(m[1]);}
const observations=await Promise.all(sessions.map(s=>s.execute(code(`async page => {const cdp=await page.context().newCDPSession(page);try {const {targetInfo}=await cdp.send('Target.getTargetInfo');const win=await cdp.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId});return {count:await page.evaluate(()=>window.count),cookie:await page.evaluate(()=>document.cookie),window:win};}finally{await cdp.detach();}}`)).then(result)));
function onScreen(bounds,slot){return bounds.left===(slot%3)*1280&&bounds.top===Math.floor(slot/3)*720&&bounds.width===1280&&bounds.height===720&&bounds.windowState==='normal';}
if(observations.some((v,i)=>v.count!==12||!v.cookie.includes('shared_login=verified')||!onScreen(v.window.bounds,i)))throw Error(JSON.stringify(observations));
await sessions[1].execute({name:'browser_tabs',arguments:{action:'new'}});
const newWindow=result(await sessions[1].execute(code(`async page => {const cdp=await page.context().newCDPSession(page);try{return await cdp.send('Browser.getWindowForTarget');}finally{await cdp.detach();}}`)));
if(!onScreen(newWindow.bounds,1))throw Error('new tab left its assigned screen: '+JSON.stringify(newWindow.bounds));
await sessions[1].execute({name:'browser_navigate',arguments:{url:'http://localhost:8877/beta'}});
await writeFile('/tmp/screen-probe-result.json',JSON.stringify({observations,newWindow,pinnedMcp:true,modelUsed:false},null,2));
console.log('SCREEN_PROBE_PASSED');

if (process.env.SCREEN_PROBE_ONESHOT === "1") { for (const session of sessions) session.child.kill(); server.close(); }
