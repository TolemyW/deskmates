// Run inside a dedicated workspace container; no model or external site.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const children = [];
async function client() {
 const child = spawn('playwright-mcp', ['--cdp-endpoint','http://127.0.0.1:9222','--caps','vision'], {stdio:['pipe','pipe','inherit']}); children.push(child);
 let n=0; const pending=new Map();
 createInterface({input:child.stdout}).on('line', line => { const m=JSON.parse(line); const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} });
 const call=(method,params={}) => new Promise((resolve,reject)=>{const id=++n;const timer=setTimeout(()=>reject(new Error('RPC timeout '+method)),15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'m2-browser-probe',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 return async(name,args={})=>{const result=await call('tools/call',{name,arguments:args});if(result.isError) throw new Error(JSON.stringify(result));return result;};
}
const code=`async (page) => { const context = page.context(); const pages = context.pages(); const tabs = []; for (const p of pages) { const session = await context.newCDPSession(p); try { const {targetInfo} = await session.send('Target.getTargetInfo'); tabs.push({id:targetInfo.targetId,url:p.url(),current:p===page}); } finally { await session.detach(); } } return {tabs}; }`;
try {
 for(let n=0;n<60;n++){try{if((await fetch('http://127.0.0.1:9222/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
 const [a,b]=await Promise.all([client(),client()]);
 await a('browser_tabs',{action:'new'}); await b('browser_tabs',{action:'new'});
 console.log('A',JSON.stringify(await a('browser_run_code_unsafe',{code})));
 console.log('B',JSON.stringify(await b('browser_run_code_unsafe',{code})));
 console.log('tabs A',JSON.stringify(await a('browser_tabs',{action:'list'})));
 await a('browser_run_code_unsafe',{code:`async(page)=>{await page.context().addCookies([{name:'m2probe',value:'shared',url:'http://127.0.0.1:8199'}]); return 'set';}`});
 console.log('cookie B',JSON.stringify(await b('browser_run_code_unsafe',{code:`async(page)=> (await page.context().cookies('http://127.0.0.1:8199')).map(c=>({name:c.name,value:c.value}))`})));
} finally {for(const child of children)child.kill('SIGTERM');}
