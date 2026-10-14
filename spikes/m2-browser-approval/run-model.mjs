// Focused real-model regression of the existing login + parked-approval scenario.
// Credentials are loaded into the child environment only; evidence contains no key material.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { selectSnapshotMode } from './run-config.mjs';
import { requireImageId } from '../../acceptance/support/image-id.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {values}=parseArgs({options:{env:{type:'string'},image:{type:'string'},output:{type:'string'},'snapshot-mode':{type:'string',default:'explicit-v1'}}});
requireImageId(values.image,'--image');
const snapshotMode=selectSnapshotMode(values['snapshot-mode']);
const config=values.env?parseEnv(readFileSync(resolve(values.env),'utf8')):{};
const env={...process.env};
for(const key of ['MODEL_BASE_URL','MODEL_AUTH_TOKEN','DEFAULT_MODEL','CHEAP_MODEL']){env[key] ||= config[key];if(!env[key])throw new Error(`Missing ${key}`);}
const output=resolve(values.output??join(root,'spikes/m2-browser-approval',`work-${Date.now()}`));mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
const file='acceptance/m1-approvals.acceptance.test.ts';
writeFileSync(join(output,'manifest.json'),JSON.stringify({revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),image:values.image,imageId:execFileSync('docker',['image','inspect',values.image,'--format','{{.Id}}'],{encoding:'utf8'}).trim(),model:env.DEFAULT_MODEL,endpointOrigin:new URL(env.MODEL_BASE_URL).origin,test:file,testSha256:createHash('sha256').update(readFileSync(join(root,file))).digest('hex'),filter:'S01:|S11 parked:',browserSnapshotMode:snapshotMode,startedAt:new Date().toISOString()},null,2));
const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--testNamePattern','S01:|S11 parked:'],{cwd:root,stdio:'inherit',env:{...env,WORKSPACE_IMAGE:values.image,M2_BROWSER_SNAPSHOT_MODE:snapshotMode}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{writeFileSync(join(output,'result.json'),JSON.stringify({exitCode:code,finishedAt:new Date().toISOString()},null,2));process.exitCode=code??1;console.log(`Evidence: ${output}`);});
