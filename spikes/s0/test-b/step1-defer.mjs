// Test B step 1: run agent, defer the L2 tool call, let process exit.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";

const MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5-20251001";
const WORK = process.env.SPIKE_WORK;
const marker = `${WORK}/L2-DONE.txt`;
if (fs.existsSync(marker)) fs.unlinkSync(marker);

let sessionId, deferred = [], resultSubtype, events = [];
const t0 = Date.now();
try {
  for await (const msg of query({
    prompt: `Do exactly this, in order:
1. Run the shell command: echo step1 > ${WORK}/L0-DONE.txt
2. Run the shell command: echo sent > ${marker}   (this simulates an external side effect)
3. Reply with the single word DONE.`,
    options: {
      model: MODEL,
      cwd: WORK,
      settingSources: [],
      maxTurns: 8,
      allowedTools: [],
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [async (input) => {
            const cmd = input.tool_input?.command || "";
            events.push({ t: Date.now() - t0, hook: "PreToolUse", cmd });
            if (cmd.includes("L2-DONE")) {
              deferred.push(cmd);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "defer",
                  permissionDecisionReason: "L2 action: waiting for human approval",
                },
              };
            }
            return {
              hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
            };
          }],
        }],
      },
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "result") { resultSubtype = msg.subtype; sessionId = msg.session_id; events.push({ t: Date.now() - t0, result: msg.subtype, cost: msg.total_cost_usd, turns: msg.num_turns }); }
    else events.push({ t: Date.now() - t0, type: msg.type, subtype: msg.subtype });
  }
} catch (e) {
  events.push({ error: String(e).slice(0, 300) });
}
const out = {
  sessionId, resultSubtype, deferred,
  l0_exists: fs.existsSync(`${WORK}/L0-DONE.txt`),
  l2_exists: fs.existsSync(marker),
  events,
};
fs.writeFileSync(`${WORK}/step1.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
