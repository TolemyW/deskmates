import { page } from "./html.js";

/** The chart value and its Refresh control are painted pixels, never DOM text or controls. */
export function canvasPage(user: string): string {
  return page({
    title: "Chart",
    user,
    body: `<h2>Operations chart</h2>
<p>Use the Refresh control on the chart to update its value.</p>
<canvas id="operations-chart" width="600" height="300" style="display:block;width:600px;height:300px;max-width:100%;border:1px solid #aab4c2;border-radius:10px;background:#fff"></canvas>
<script>
(() => {
  const canvas = document.getElementById('operations-chart');
  const ctx = canvas.getContext('2d');
  let number;
  let busy = false;
  function draw() {
    ctx.clearRect(0, 0, 600, 300);
    ctx.fillStyle = '#eff5fc'; ctx.fillRect(0, 0, 600, 300);
    ctx.fillStyle = '#243a56'; ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('Current activity', 34, 52);
    ctx.font = 'bold 96px system-ui, sans-serif';
    ctx.fillText(String(number), 38, 178);
    ctx.fillStyle = '#1270bb'; ctx.fillRect(370, 108, 186, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillText('Refresh', 407, 149);
    ctx.strokeStyle = '#84a8d2'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(36, 238); ctx.lineTo(160, 220); ctx.lineTo(290, 246); ctx.lineTo(420, 205); ctx.lineTo(554, 225); ctx.stroke();
  }
  async function update(method) {
    const response = await fetch('/canvas/value', {method, headers:{accept:'application/json'}});
    if (!response.ok) throw new Error('Chart unavailable');
    number = (await response.json()).number;
    draw();
  }
  canvas.addEventListener('click', async (event) => {
    if (busy) return;
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * canvas.width / bounds.width;
    const y = (event.clientY - bounds.top) * canvas.height / bounds.height;
    if (x < 370 || x > 556 || y < 108 || y > 172) return;
    busy = true;
    try { await update('POST'); } finally { busy = false; }
  });
  update('GET');
})();
</script>`,
  });
}
