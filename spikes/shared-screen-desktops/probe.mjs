import { chromium } from 'playwright';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
const server = http.createServer((req,res) => {
 res.setHeader('content-type','text/html');
 res.end(`<html><body style="background:${req.url.includes('a')?'#bce6d7':'#c4d1ff'};font:40px sans-serif;padding:40px"><h1>${req.url.includes('a')?'BOT A':'BOT B'}</h1><button style="padding:30px;font-size:40px" onclick="this.textContent=String(++window.count)">0</button><script>window.count=0</script></body></html>`);
});
await new Promise(r=>server.listen(8877,'127.0.0.1',r));
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const context=browser.contexts()[0];
const cdp=await browser.newBrowserCDPSession();
const pages=[];const windows=[];const sessions=[];
for(let i=0;i<2;i++) {
 const {targetId}=await cdp.send('Target.createTarget',{url:`http://127.0.0.1:8877/${i===0?'a':'b'}`,newWindow:true,width:1280,height:800,left:i*1280,top:0});
 let page;
 for(let attempts=0;attempts<40&&!page;attempts++){
  for(const p of context.pages()) {const s=await context.newCDPSession(p);const t=await s.send('Target.getTargetInfo');await s.detach();if(t.targetInfo.targetId===targetId)page=p;}
  if(!page)await new Promise(r=>setTimeout(r,50));
 }
 if(!page)throw Error('target not found');
 await page.waitForSelector('button');
 const win=await cdp.send('Browser.getWindowForTarget',{targetId});
 await cdp.send('Browser.setWindowBounds',{windowId:win.windowId,bounds:{left:i*1280,top:0,width:1280,height:800,windowState:'normal'}});
 const session=await context.newCDPSession(page);await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});sessions.push(session);pages.push(page);windows.push(win.windowId);
}
await pages[0].evaluate(()=>{document.cookie='shared_login=verified; path=/'});
for(let i=0;i<12;i++) await Promise.all(pages.map(p=>p.getByRole('button').click()));
const counts=await Promise.all(pages.map(p=>p.evaluate(()=>window.count)));
const cookie=await pages[1].evaluate(()=>document.cookie);
const bounds=await Promise.all(windows.map(windowId=>cdp.send('Browser.getWindowBounds',{windowId})));
const report={counts,sharedCookie:cookie.includes('shared_login=verified'),distinctWindows:windows[0]!==windows[1],bounds};
if(counts.some(n=>n!==12)||!report.sharedCookie||!report.distinctWindows)throw Error(JSON.stringify(report));
await writeFile('/evidence/result.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
// Keep the windows alive for the X11/VNC probe and screenshots; no model is involved.
await new Promise(r=>setTimeout(r,180000));
await browser.close();server.close();
