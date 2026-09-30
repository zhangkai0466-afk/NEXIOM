import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const output = await build({entryPoints:['apps/desktop/renderer/project-status.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {projectStageStates} = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const thread = (id,projectId,stageId) => ({id,projectId,stageId});
const run = (id,threadId,projectId,status,createdAt) => ({id,threadId,projectId,status,createdAt});
test('overview isolates projects and stages, prioritizes live runs, and preserves terminal outcomes', () => {
  const snapshot = {threads:[thread('r','p','reading'),thread('m','p','model'),thread('v','p','validation'),thread('foreign','other','reading')],runs:[
    run('active','r','p','running','2026-09-30T01:00:00Z'),run('newer','r','p','succeeded','2026-09-30T02:00:00Z'),
    run('bad','m','p','failed','2026-09-30T03:00:00Z'),run('stopped','v','p','cancelled','2026-09-30T04:00:00Z'),
    run('outside','foreign','other','running','2026-09-30T05:00:00Z'),run('orphan','missing','p','running','2026-09-30T06:00:00Z')]};
  let states=projectStageStates(snapshot,'p');
  assert.equal(states.find(s=>s.id==='reading').run.id,'active');
  assert.equal(states.find(s=>s.id==='reading').activeCount,1);
  assert.equal(states.find(s=>s.id==='model').status,'failed');
  assert.equal(states.find(s=>s.id==='validation').status,'cancelled');
  assert.equal(states.find(s=>s.id==='paper').status,'idle');
  snapshot.runs[0].status='succeeded';
  states=projectStageStates(snapshot,'p');
  assert.equal(states.find(s=>s.id==='reading').status,'succeeded');
  assert.equal(states.find(s=>s.id==='reading').activeCount,0);
  assert.equal(states.find(s=>s.id==='reading').run.id,'newer');
});
