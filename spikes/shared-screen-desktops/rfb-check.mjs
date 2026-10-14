// Exercises the real server-side VNC view credential, including a client that sends input anyway.
import { createCipheriv } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const evidence=new URL('./work-runtime/',import.meta.url);
const state=JSON.parse(await readFile(new URL('state.json',evidence),'utf8'));
const origin='http://127.0.0.1:18093';
const api=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{authorization:'Bearer operator-test-token-at-least-32-bytes-long','content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json();};
const shell=(...args)=>execFileSync('docker',['exec',state.container,...args],{encoding:'utf8'});
const position=()=>shell('xdotool','getmouselocation','--shell').trim();
async function rfb(mode,botId){
 const access=await api(`/api/bots/${botId}/screen/access`,{mode});
 const socket=new WebSocket(origin.replace('http:','ws:')+access.path,[access.protocol],{origin});
 let buffer=Buffer.alloc(0),wake;socket.on('message',data=>{buffer=Buffer.concat([buffer,Buffer.from(data)]);wake?.();});
 const read=async n=>{const deadline=Date.now()+10000;while(buffer.length<n){if(Date.now()>deadline)throw Error('RFB read timeout '+n);await new Promise(r=>{const timer=setTimeout(r,50);wake=()=>{clearTimeout(timer);r()}});}const value=buffer.subarray(0,n);buffer=buffer.subarray(n);return value};
 const version=(await read(12)).toString();socket.send(Buffer.from('RFB 003.008\n'));
 const count=(await read(1))[0];const security=await read(count);if(!security.includes(2))throw Error('VNC authentication not offered');socket.send(Buffer.from([2]));
 const challenge=await read(16);const key=Buffer.alloc(8);for(let i=0;i<8;i++){let n=access.password.charCodeAt(i),v=0;for(let j=0;j<8;j++){v=(v<<1)|(n&1);n>>=1;}key[i]=v;}
 const cipher=createCipheriv('des-ede3',Buffer.concat([key,key,key]),null);cipher.setAutoPadding(false);socket.send(Buffer.concat([cipher.update(challenge),cipher.final()]));
 if((await read(4)).readUInt32BE()!==0)throw Error('VNC authentication failed');socket.send(Buffer.from([1]));
 const init=await read(24);await read(init.readUInt32BE(20));
 return {socket,size:[init.readUInt16BE(0),init.readUInt16BE(2)],version,pointer(x,y){const data=Buffer.alloc(6);data[0]=5;data.writeUInt16BE(x,2);data.writeUInt16BE(y,4);socket.send(data);},close:()=>api(`/api/screen-access/${access.accessId}/close`,{})};
}
const report={};
shell('xdotool','mousemove','40','40');const before=position();
const view=await rfb('view',state.botIds[0]);view.pointer(500,400);await new Promise(r=>setTimeout(r,300));report.viewInputBlocked=position()===before;report.viewSize=view.size;await view.close();
await api(`/api/workspaces/${state.workspaceId}/takeover`,{});
const control=await rfb('control',state.botIds[1]);control.pointer(500,400);await new Promise(r=>setTimeout(r,300));const after=position();report.controlInputMapped=after.includes('X=1780\nY=400');report.controlSize=control.size;
const closed=once(control.socket,'close');await api(`/api/workspaces/${state.workspaceId}/handback`,{});await closed;report.handbackClosesControl=true;
await writeFile(new URL('rfb-result.json',evidence),JSON.stringify(report,null,2));if(!report.viewInputBlocked||!report.controlInputMapped)throw Error(JSON.stringify({report,before,after}));console.log('RFB_CHECK_PASSED',JSON.stringify(report));
