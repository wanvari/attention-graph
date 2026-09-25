import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),makeRecord=require('../fixtures/largeGraph');
const root=path.resolve(import.meta.dirname,'../..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ct-constellation-scale-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,viewport:{width:1536,height:1100},reducedMotion:'reduce',args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/ui/map.html`);await page.locator('.studio-shell').waitFor();
  await page.evaluate(async snapshot=>{const store=CTStore.createStore({});await store.open();for(const [name,rows] of Object.entries(snapshot))if(rows.length)await store.bulkPut(name,rows);store.close();},makeRecord(Date.now()));
  await page.reload();await page.locator('.topic-node').first().waitFor();
  assert.equal(await page.locator('.topic-node').count(),117);
  assert.equal(await page.locator('.page-node').count(),1025);
  assert.equal(await page.locator('.topic-node:visible').count(),117,'the overview draws every trail');
  // Visible labels never collide and never leave the canvas, at any width.
  const checkLayout=async()=>{
    const geometry=await page.evaluate(()=>{
      const canvas=document.getElementById('graph-container').getBoundingClientRect();
      const labels=[...document.querySelectorAll('.topic-label,.group-label,.page-label')].filter(n=>getComputedStyle(n).display!=='none').map(n=>n.getBoundingClientRect());
      const overlaps=labels.flatMap((a,i)=>labels.slice(i+1).filter(c=>a.left<c.right-.5&&a.right>c.left+.5&&a.top<c.bottom-.5&&a.bottom>c.top+.5)).length;
      const outside=labels.filter(b=>b.left<canvas.left-1||b.right>canvas.right+1||b.top<canvas.top-1||b.bottom>canvas.bottom+1).length;
      return {overflow:document.documentElement.scrollWidth>innerWidth+1,overlaps,outside,labels:labels.length};
    });
    assert.equal(geometry.overflow,false,'no horizontal page overflow');
    assert.equal(geometry.overlaps,0,'labels never collide');
    assert.equal(geometry.outside,0,'labels stay inside the canvas');
    return geometry;
  };
  const circleOverlaps=await page.evaluate(()=>{const c=[...document.querySelectorAll('.topic-node')].map(n=>n.__data__);let overlaps=0;for(let i=0;i<c.length;i++)for(let j=i+1;j<c.length;j++)if(Math.hypot(c[i].x-c[j].x,c[i].y-c[j].y)<c[i].radius+c[j].radius-.5)overlaps++;return overlaps;});
  assert.equal(circleOverlaps,0,'the layout separates every trail circle');
  assert.ok((await checkLayout()).labels>=12,'the busiest trails are named in the overview');
  assert.ok(await page.locator('.graph-region').count()>0,'related titles share halos');
  await page.screenshot({path:path.join(os.tmpdir(),'ct-constellation-large-dark.png')});
  await page.getByRole('button',{name:'Light theme',exact:true}).click();await checkLayout();
  await page.screenshot({path:path.join(os.tmpdir(),'ct-constellation-large-light.png')});
  await page.getByRole('button',{name:'Dark theme',exact:true}).click();
  // The same record always draws the same map.
  const positions=()=>page.locator('.topic-node').evaluateAll(nodes=>nodes.map(n=>[n.__data__.id,Math.round(n.__data__.x),Math.round(n.__data__.y)]));
  const before=await positions();await page.reload();await page.locator('.topic-node').first().waitFor();
  assert.deepEqual(await positions(),before,'seeded layout is deterministic');
  // Every trail and the ungrouped collection remain reachable as a list.
  assert.equal(await page.locator('#evidence-panel .graph-result').count(),30);
  while(await page.locator('#evidence-panel .evidence-section > .graph-more:visible').count())await page.locator('#evidence-panel .evidence-section > .graph-more').first().click();
  assert.equal(await page.locator('#evidence-panel .graph-result').count(),118,'every trail remains reachable');
  await page.locator('.graph-result').filter({hasText:'767 pages without a trail'}).click();
  assert.equal(await page.locator('#evidence-panel .graph-result').count(),30);
  await page.getByRole('button',{name:'Show more (737 remaining)',exact:true}).click();assert.equal(await page.locator('#evidence-panel .graph-result').count(),60);
  await page.getByRole('searchbox').fill('Source 1019:');await page.locator('.graph-result').filter({hasText:'Source 1019:'}).click();
  await page.getByRole('heading',{name:/Source 1019:/}).waitFor();assert.equal(await page.locator('.page-node:visible').count(),1);
  await page.getByRole('button',{name:'← All trails',exact:true}).click();
  for(const width of [1536,1280,1024,768,390,320]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(150);await checkLayout();}
  // A single very large trail shows all of its pages around it, with a full list.
  await page.setViewportSize({width:1536,height:1100});
  await page.evaluate(async()=>{const s=CTStore.createStore({});await s.open();for(let i=258;i<418;i++)await s.put('memberships',{normalizedUrl:`https://source-${i%37}.example.test/article-${i}`,topicId:'large-0'});s.close();});
  await page.reload();await page.locator('.topic-node').first().waitFor();
  await page.getByRole('searchbox').fill('Rust async');await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:/Rust async programming/}).waitFor();await page.waitForTimeout(150);
  const satellites=await page.locator('.page-node:visible').evaluateAll(nodes=>nodes.map(n=>n.__data__.parentTopicId));
  assert.ok(satellites.length>=160&&satellites.every(id=>id==='large-0'),'the selected trail shows its own pages only');
  assert.ok((await checkLayout()).labels>=6,'focused detail makes room for useful labels');
  await page.screenshot({path:path.join(os.tmpdir(),'ct-constellation-large-detail.png')});
  assert.equal(await page.locator('#graph-topic-pages .graph-result').count(),30);
  await page.locator('#graph-topic-pages .graph-more').click();assert.equal(await page.locator('#graph-topic-pages .graph-result').count(),60);
  for(const width of [768,390,320]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(150);await checkLayout();}
  assert.deepEqual(errors,[]);console.log('Constellation scale passed: 117 trails and 1,025 pages drawn, separated circles, collision-free labels inside the canvas, deterministic layout, full lists, ungrouped search, large-trail satellites and phone widths.');
}finally{await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
