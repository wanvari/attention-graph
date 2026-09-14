'use strict';
const assert = require('node:assert/strict');
const D = require('../../lib/dashboard'), T = require('../../lib/trails'), MapData = require('../../ui/mapData');
const t = new Date(2026,8,12,12).getTime(), minute = 60000;
const a='https://alpha.example/a', b='https://beta.example/b', c='https://beta.example/c';
const event=(id,url,n,topicIds=[],extra={})=>({id,url,normalizedUrl:url,domain:new URL(url).hostname,time:t+n*minute,day:'2026-09-12',topicIds,...extra});
const rows=[event('a1',a,0,['a']),event('b1',b,1),event('a2',a,2,['a']),event('b2',b,3),event('c1',c,4),event('b3',b,5),event('a3',a,6,['a']),event('a4',a,7,['a']),event('b4',b,8,[],{transition:'reload'})];
const flow=D.transitions(rows,{from:t,to:t+20*minute});
assert.equal(flow.uncovered,6,'repeat chronological steps count separately');
assert.equal(flow.uniqueUngroupedPagePairs,4,'A→B, B→A, B→C, C→B');
assert.equal(flow.uniqueUngroupedWebsitePairs,3,'A→B, B→A, B→B; pages on one website remain a hostname pair');
assert.equal(flow.excluded.samePage,1);assert.equal(flow.excluded.reload,1);
assert.equal(flow.candidateCount,flow.pairs.length+flow.uncovered+Object.values(flow.excluded).reduce((a,b)=>a+b,0));
const tie=D.transitions([event('a',a,0,['a']),event('b',b,1,['b']),event('c',c,1,['a']),event('d',a,2,['a'])],{from:t,to:t+20*minute});
assert.equal(tie.eligible,0);assert.equal(tie.excluded.simultaneous,3);
const pause=D.transitions(rows.slice(0,4),{from:t,to:t+20*minute},[{start:t+minute,end:t+2*minute}]);
assert.equal(pause.excluded.paused,2);assert.equal(pause.uncovered,1);
const topic=(id,label)=>({id,label,visitCount:4,pageCount:2});
const topics=[topic('profile','FINNY AI Company Profile'),topic('jobs','FINNY job listings'),topic('welcome','Finny welcome page'),topic('other','Acme AI Company Profile'),topic('otherjobs','Example job listings')];
const groups=MapData.buildTopicGroups(topics), finny=groups.find(g=>g.cue==='finny');
assert.deepEqual(finny.topicIds,['jobs','profile','welcome']);
assert.equal(finny.pageCount,6);assert.equal(finny.visitCount,12);
assert.ok(groups.find(g=>g.id==='subject:other').topicIds.includes('other'),'generic company/profile/jobs wording cannot connect unrelated companies');
assert.deepEqual(MapData.buildTopicGroups([...topics].reverse()),groups,'grouping is independent of input order');
const chain=MapData.buildTopicGroups([topic('a','Quartz'),topic('b','Quartz Nebula'),topic('c','Nebula')]);
assert.ok(chain.filter(g=>g.related).every(g=>g.topicIds.length===2),'shared-title groups cannot chain unrelated endpoints');
assert.deepEqual(MapData.buildTopicGroups([]),[]);
// Audit has a complete partition for random duplicates, ties, gaps and pauses.
let seed=7;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
for(let run=0;run<100;run++){
  let n=0;const events=Array.from({length:80},(_,i)=>{n+=Math.floor(rand()*40);return event(String(i),[a,b,c][Math.floor(rand()*3)],n,rand()>.4?['a']:[],{transition:rand()>.9?'reload':'link'});});
  const x=D.transitions(events,{from:t,to:t+5000*minute},[{start:t+100*minute,end:t+130*minute}]);
  assert.equal(x.candidateCount,x.pairs.length+x.uncovered+Object.values(x.excluded).reduce((sum,n)=>sum+n,0));
  assert.equal(x.uncovered,x.ungroupedPairs.length);
  assert.equal(x.uniqueUngroupedPagePairs,new Set(x.ungroupedPairs.map(p=>JSON.stringify([p.from.normalizedUrl,p.to.normalizedUrl]))).size);
}
(async()=>{
  const snapshot={topics:topics.map(x=>({topicId:x.id,label:x.label})),visits:[],memberships:[]};
  for(const [i,url] of [a,b,c].entries()) {snapshot.memberships.push({normalizedUrl:url,topicId:topics[i].id});for(let j=0;j<3;j++)snapshot.visits.push({visitId:`${i}-${j}`,url,normalizedUrl:url,title:topics[i].label,visitTime:t+(i+j*3)*minute,dwellMs:minute});}
  const store={getAll:async name=>snapshot[name]||[]};
  const before=JSON.stringify(snapshot),result=await MapData.build(store,{now:t+20*minute});
  assert.equal(JSON.stringify(snapshot),before,'visual grouping never writes or merges memberships');
  assert.equal(result.groups.find(g=>g.cue==='finny').topicIds.length,3);
  const record=T.buildRecord(snapshot,{now:t+20*minute});
  assert.equal(result.sequenceAudit.uncovered,D.measure(record,{from:result.coverage.startTime,to:t+20*minute}).flow.uncovered);
  assert.equal(result.categorizedCoverage.pagesAvailable,3,'page denominator uses the selected period');
  console.log('Connection count reconciliation, repeats, corrections, title groups and 100 randomized partitions passed');
})().catch(e=>{console.error(e);process.exit(1);});
