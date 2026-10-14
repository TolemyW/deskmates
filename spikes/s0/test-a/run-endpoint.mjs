// Test A (real gateway): SDK -> ANTHROPIC_BASE_URL gateway; two tool calls + usage/cache report.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
const MODEL = process.env.SPIKE_MODEL;
const WORK = process.env.SPIKE_WORK;
const marker = `${WORK}/GATEWAY-${MODEL.replace(/[^a-z0-9]/gi, "_")}.txt`;
if (fs.existsSync(marker)) fs.unlinkSync(marker);
let out = { model: MODEL, base: process.env.ANTHROPIC_BASE_URL, events: [], hookCmds: [] };
const t0 = Date.now();
try {
  for await (const msg of query({
    prompt: `Run the shell command: echo gateway-ok > ${marker} ; then run the shell command: cat ${marker} ; then reply with the single word DONE.`,
    options: {
      model: MODEL, cwd: WORK, settingSources: [], maxTurns: 6, allowedTools: [],
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [async (i) => { out.hookCmds.push(i.tool_input?.command); return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }; }] }] },
    },
  })) {
    if (msg.type === "result") out.result = { subtype: msg.subtype, text: msg.result, turns: msg.num_turns, cost: msg.total_cost_usd, usage: msg.usage, modelUsage: msg.modelUsage, wall_ms: Date.now() - t0 };
    else if (msg.type === "assistant") out.events.push({ type: "assistant", blocks: msg.message?.content?.map(b => b.type) });
    else out.events.push({ type: msg.type, subtype: msg.subtype });
  }
} catch (e) { out.error = String(e).slice(0, 600); }
out.marker_written = fs.existsSync(marker);
console.log(JSON.stringify(out, null, 2));
