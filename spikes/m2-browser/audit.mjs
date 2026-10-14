// Audit recorded runtime evidence without changing the strict model-answer oracle.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const file=process.argv[2];if(!file)throw new Error('Usage: node audit.mjs <browser-results.json>');
const cases=JSON.parse(readFileSync(file,'utf8'));
const result=cases.map(row=>{
 const runs=row.runs.map(({run,events})=>{
  const targets=[...new Set(events.filter(e=>e.payload.source==='browser_lock').map(e=>e.payload.tabId))];
  const tools=events.filter(e=>e.kind==='tool_result');
  const screenshots=events.filter(e=>e.kind==='screenshot');
  const passed=run.status==='succeeded' && targets.length===1 && typeof targets[0]==='string' && tools.length>0 && tools.every(e=>e.payload.isError!==true) && screenshots.length>0 && screenshots.every(e=>e.payload.tabId===targets[0]);
  return {id:run.id,passed,target:targets[0],startedAt:run.startedAt,finishedAt:run.finishedAt,reply:run.summary?.reply,toolResults:tools.length,screenshots:screenshots.length};
 });
 const overlapMs=Math.min(...runs.map(r=>Date.parse(r.finishedAt)))-Math.max(...runs.map(r=>Date.parse(r.startedAt)));
 const runtimePassed=runs.every(r=>r.passed)&&new Set(runs.map(r=>r.target)).size===runs.length&&overlapMs>0;
 return {repetition:row.repetition,strictCasePassed:row.passed,runtimePassed,overlapMs,runs};
});
writeFileSync(join(dirname(file),'runtime-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
assert(result.every(r=>r.runtimePassed),'Recorded browser runtime evidence failed');
