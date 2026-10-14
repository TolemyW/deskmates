// Test A: run an SDK query with a tool call, routed through the local proxy.
import { query } from "@anthropic-ai/claude-agent-sdk";
const MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5-20251001";
const WORK = process.env.SPIKE_WORK;
let out = { events: [] };
try {
  for await (const msg of query({
    prompt: `Run the shell command: echo proxy-ok > ${WORK}/PROXY.txt ; then reply with the single word DONE.`,
    options: {
      model: MODEL, cwd: WORK, settingSources: [], maxTurns: 6,
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${process.env.PROXY_PORT || 8787}` },
      allowedTools: ["Bash"],
    },
  })) {
    if (msg.type === "result") out.result = { subtype: msg.subtype, cost: msg.total_cost_usd, usage: msg.usage, turns: msg.num_turns, text: msg.result };
    else out.events.push({ type: msg.type, subtype: msg.subtype });
  }
} catch (e) { out.error = String(e).slice(0, 500); }
console.log(JSON.stringify(out, null, 2));
