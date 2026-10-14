// Test B step 2: new process, resume session, approve deferred call.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";

const MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5-20251001";
const WORK = process.env.SPIKE_WORK;
const step1 = JSON.parse(fs.readFileSync(`${WORK}/step1.json`, "utf8"));
const marker = `${WORK}/L2-DONE.txt`;

let resultSubtype, events = [], resultText;
const t0 = Date.now();
try {
  for await (const msg of query({
    prompt: "Approval granted by human. Continue.",
    options: {
      model: MODEL,
      cwd: WORK,
      settingSources: [],
      resume: step1.sessionId,
      maxTurns: 8,
      allowedTools: [],
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [async (input) => {
            events.push({ t: Date.now() - t0, hook: "PreToolUse", cmd: input.tool_input?.command });
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
          }],
        }],
      },
    },
  })) {
    if (msg.type === "result") { resultSubtype = msg.subtype; resultText = msg.result; events.push({ t: Date.now() - t0, result: msg.subtype, cost: msg.total_cost_usd, turns: msg.num_turns }); }
    else events.push({ t: Date.now() - t0, type: msg.type, subtype: msg.subtype });
  }
} catch (e) {
  events.push({ error: String(e).slice(0, 300) });
}
const out = { resumedSession: step1.sessionId, resultSubtype, resultText, l2_exists_after_resume: fs.existsSync(marker), events };
fs.writeFileSync(`${WORK}/step2.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
