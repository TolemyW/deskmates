/** No credentials, QR payload or account data is interpolated into this document. */
export function connectionPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Deskmates · WhatsApp</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#f5f5f2;color:#18251f;font:16px system-ui,sans-serif}
main{max-width:620px;margin:56px auto;padding:32px;background:white;border:1px solid #dce3dc;border-radius:20px}
h1{font-size:28px;margin:12px 0}p{line-height:1.6}.muted{color:#526359}label{display:block;margin:20px 0 8px}
input{width:100%;padding:12px;border:1px solid #a9b6ae;border-radius:8px;font:inherit}
button{font:inherit;padding:10px 18px;border:1px solid #146747;border-radius:8px;background:#146747;color:white;cursor:pointer;margin:12px 8px 0 0}
button.secondary{background:white;color:#146747}button:disabled{opacity:.5;cursor:default}img{width:280px;max-width:100%;display:block;margin:20px auto}
.badge{display:inline-block;background:#edf4ee;border-radius:20px;padding:6px 12px}.error{color:#9b2323}[hidden]{display:none!important}
@media(max-width:660px){main{margin:16px;padding:24px}}
</style></head><body><main><span class="muted">Deskmates channels</span><h1>Connect WhatsApp</h1>
<p>Link your existing account using your phone. No Meta developer account is required.</p>
<form id="auth"><label for="token">Deskmates operator token</label><input id="token" type="password" autocomplete="off" required>
<button>Open connection settings</button></form>
<section id="panel" hidden><p><span id="status" class="badge" role="status">Checking connection…</span></p>
<p id="account"></p><p id="help" class="muted"></p><img id="qr" alt="WhatsApp linked-device QR code" hidden>
<button id="connect">Connect WhatsApp</button><button id="logout" class="secondary">Log out</button>
<button id="lock" class="secondary">Lock page</button><p class="muted">Only configured sender numbers can reach your bots. Text messages and approval replies are supported.</p>
</section><p id="error" class="error" role="alert"></p></main>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);let token='',timer,busy=false,revision=0,operationError='';
const labels={idle:'Not connected',connecting:'Connecting…',qr:'Ready to scan',connected:'Connected',reconnecting:'Reconnecting…',logged_out:'Not linked',error:'Connection needs attention'};
function lock(){revision++;token='';clearTimeout(timer);el('qr').removeAttribute('src');el('qr').hidden=true;el('panel').hidden=true;el('auth').hidden=false;el('token').value=''}
async function api(path,method='GET'){const r=await fetch('/api/'+path,{method,headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(method==='GET'?10000:45000)});
if(r.status===401){lock();throw Error('Operator token was rejected.')}if(!r.ok)throw Error('Request failed ('+r.status+').');return r.json()}
function render(s){el('status').textContent=labels[s.phase]||'Unknown';el('account').textContent=s.account?'Linked number: +'+s.account:'';
el('help').textContent=s.phase==='qr'?'On your phone, open WhatsApp → Linked devices → Link a device, then scan this QR.':s.phase==='connected'?'Send a text message from an allowed number to this account. You can also use self-chat when your own number is allowed.':'Click Connect WhatsApp to link or restore the account.';
const show=s.qr&&s.qrExpiresAt&&Date.parse(s.qrExpiresAt)>Date.now();el('qr').hidden=!show;if(show)el('qr').src=s.qr;else el('qr').removeAttribute('src');
el('connect').disabled=busy||['connecting','qr','connected','reconnecting'].includes(s.phase);el('logout').disabled=busy;
el('error').textContent=s.error||operationError||(s.inboundFailures?'Some incoming messages could not reach Deskmates. Check server connectivity before retrying the message.':'')}
async function poll(){clearTimeout(timer);const seq=revision;try{const s=await api('status');if(seq!==revision)return;render(s)}catch(e){if(seq===revision){el('error').textContent=e.message;el('qr').hidden=true;el('qr').removeAttribute('src');el('status').textContent='Connection unavailable';el('help').textContent='Waiting for the connection service. The old QR has been hidden.'}}
if(token)timer=setTimeout(poll,2000)}
el('auth').onsubmit=async e=>{e.preventDefault();token=el('token').value;el('token').value='';el('error').textContent='';const seq=++revision;
try{const s=await api('status');if(seq!==revision)return;el('auth').hidden=true;el('panel').hidden=false;render(s);timer=setTimeout(poll,2000)}catch(e){el('error').textContent=e.message}};
async function action(path){if(busy)return;busy=true;operationError='';revision++;clearTimeout(timer);el('connect').disabled=true;el('logout').disabled=true;
try{await api(path,'POST')}catch(e){operationError=e.message;el('error').textContent=e.message}finally{busy=false;if(token)await poll()}}
el('connect').onclick=()=>action('connect');el('logout').onclick=()=>{if(confirm('Log out and clear this server’s linked session?'))action('logout')};el('lock').onclick=lock;
</script></body></html>`;
}
