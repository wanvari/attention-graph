'use strict';
const assert=require('node:assert/strict');
const {makeEnv}=require('../helpers/pipelineHarness');
(async()=>{
  const env=await makeEnv();
  // Spring-forward midnight must not be derived by subtracting 12h from noon.
  await env.store.setSetting('pauseIntervals',[{start:new Date(2026,2,7,23,30).getTime(),end:new Date(2026,2,8,0,30).getTime()}]);
  const result=await env.runThroughDay(8);
  assert.equal(result.ok,true,result.error);
  const pause=result.brief.items.find(item=>item.evidence?.pausedMs);
  assert.equal(pause.evidence.day,'2026-03-08');
  assert.equal(pause.evidence.pausedMs,30*60000,'only the half hour after midnight belongs to the DST day');
  console.log('Full pipeline pause brief uses actual local midnight on the DST day');
})().catch(e=>{console.error(e);process.exit(1);});
