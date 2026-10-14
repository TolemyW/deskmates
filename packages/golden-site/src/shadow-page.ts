import { page } from "./html.js";

/** The actionable control lives exclusively in a closed shadow root. */
export function shadowPage(user: string, approved: boolean): string {
  return page({
    title: "Ticket approval",
    user,
    body: `<h2>Ticket approval</h2>
<p>Review ticket 1042 and approve it using the control below.</p>
<div id="approval-card" style="width:480px;min-height:180px;margin-top:1.5rem"></div>
<script>
(() => {
  const root = document.getElementById('approval-card').attachShadow({mode:'closed'});
  const card = document.createElement('div');
  card.style.cssText = 'box-sizing:border-box;width:480px;padding:30px;border:1px solid #aab4c2;border-radius:10px;background:#f4f7fb;font:20px system-ui,sans-serif';
  const label = document.createElement('p');
  label.textContent = 'Ticket 1042 · Billing amount mismatch';
  card.append(label);
  const button = document.createElement('button');
  button.textContent = 'Approve';
  button.style.cssText = 'padding:14px 32px;border:0;border-radius:7px;background:#1264bc;color:white;font:700 20px system-ui,sans-serif;cursor:pointer';
  button.disabled = ${approved ? "true" : "false"};
  if (button.disabled) button.textContent = 'Approved';
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await fetch('/shadow/approve', {method:'POST', headers:{accept:'application/json'}});
      if (!response.ok) throw new Error('Approval failed');
      button.textContent = 'Approved';
    } catch {
      button.disabled = false;
      button.textContent = 'Approve';
    }
  });
  card.append(button);
  root.append(card);
})();
</script>`,
  });
}
