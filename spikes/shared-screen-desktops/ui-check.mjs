// Local UI QA against live-preview.ts. Host Playwright installation is configurable.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import { readFile, writeFile } from 'node:fs/promises';
const evidence=new URL('./work-runtime/',import.meta.url);
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://localhost:15373');
 await page.getByLabel('Operator credential').fill('operator-test-token-at-least-32-bytes-long');
 await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('link',{name:'Desktops',exact:true}).click();
 await page.getByText('LIVE · VIEW ONLY',{exact:true}).first().waitFor({timeout:30000});
 await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].length===2 && [...document.querySelectorAll('canvas')].every(c=>{if(c.width!==1280||c.height!==800)return false;const pixel=c.getContext('2d').getImageData(100,200,1,1).data;return pixel[3]===255;}));
 await page.screenshot({path:new URL('desktops.png',evidence).pathname,fullPage:true});
 const previews=await page.getByText('LIVE · VIEW ONLY',{exact:true}).count();
 await page.getByRole('button',{name:'Open desktop'}).first().click();
 const dialog=page.getByRole('dialog');
 await dialog.getByText('LIVE · VIEW ONLY',{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'Take control',exact:true}).click();
 await dialog.getByText('YOU HAVE CONTROL',{exact:true}).waitFor();
 await page.screenshot({path:new URL('takeover.png',evidence).pathname,fullPage:true});
 await dialog.getByRole('button',{name:'Return control'}).click();
 await dialog.getByText('LIVE · VIEW ONLY',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Close desktop'}).click();
 const state=JSON.parse(await readFile(new URL('state.json',evidence),'utf8'));
 await page.evaluate(id=>{location.hash=`#/threads/${id}`},state.threadId);
 await page.getByLabel('Message').waitFor();
 await page.getByText('LIVE · VIEW ONLY',{exact:true}).nth(1).waitFor();
 await page.getByRole('button',{name:'Create thread',exact:true}).evaluate(el=>{const css=getComputedStyle(el);if(css.color===css.backgroundColor)throw Error('Invisible button label')});
 await page.screenshot({path:new URL('conversation.png',evidence).pathname,fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:new URL('mobile.png',evidence).pathname,fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 await writeFile(new URL('ui-result.json',evidence),JSON.stringify({previews,controlAndHandback:true,mobileOverflow:overflow,errors},null,2));
 if(errors.length||previews!==2||overflow)throw Error(JSON.stringify({previews,overflow,errors}));
 console.log('UI_CHECK_PASSED');
} catch(e){await page.screenshot({path:new URL('ui-failure.png',evidence).pathname,fullPage:true});console.error(await page.locator('body').innerText());throw e;}finally{await browser.close();}
