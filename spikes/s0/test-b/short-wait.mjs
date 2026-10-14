// Test B2: "short wait" mode - canUseTool blocks in-process for N seconds, then allows.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
const MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5-20251001";
const WORK = process.env.SPIKE_WORK;
const WAIT_MS = Number(process.env.WAIT_MS || 20000);
const marker = `${WORK}/SHORTWAIT.txt`;
if (fs.existsSync(marker)) fs.unlinkSync(marker);
let waited = null, out = {};
const t0 = Date.now();
try {
  for await (const msg of query({
    prompt: `Run the shell command: echo ok > ${marker} ; then reply with the single word DONE.`,
    options: {
      model: MODEL, cwd: WORK, settingSources: [], maxTurns: 6, allowedTools: [],
      canUseTool: async (toolName, input, { signal }) => {
        const s = Date.now();
        await new Promise(r => setTimeout(r, WAIT_MS));
        waited = { toolName, aborted: signal?.aborted ?? null, waitedMs: Date.now() - s };
        return { behavior: "allow", updatedInput: input };
      },
    },
  })) {
    if (msg.type === "result") out.result = { subtype: msg.subtype, text: msg.result, cost: msg.total_cost_usd, wall_ms: Date.now() - t0 };
  }
} catch (e) { out.error = String(e).slice(0, 300); }
out.waited = waited; out.marker_written = fs.existsSync(marker);
console.log(JSON.stringify(out, null, 2));
