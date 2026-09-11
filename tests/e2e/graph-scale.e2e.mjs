import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url), makeRecord=require('../fixtures/largeGraph');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ct-graph-scale-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,viewport:{width:1536,height:1100},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'), origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/ui/map.html`);await page.locator('.studio-shell').waitFor();
  await page.evaluate(async snapshot=>{const store=CTStore.createStore({});await store.open();for(const [name,rows]of Object.entries(snapshot))if(rows.length)await store.bulkPut(name,rows);},makeRecord(Date.now()));
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.topic-node').length===117);
  await page.waitForTimeout(300);
  const assertLegible=async(label,minimum=1)=>{
    const geometry=await page.evaluate(()=>{
      const canvas=document.getElementById('graph-container').getBoundingClientRect();
      const labels=[...document.querySelectorAll('.topic-label,.page-label')].filter(n=>getComputedStyle(n).display!=='none').map(n=>{const r=n.getBoundingClientRect();return {text:n.textContent,x:r.x,y:r.y,w:r.width,h:r.height};});
      const overlaps=[];
      for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j];if(a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y)overlaps.push([a.text,b.text]);}
      return {count:labels.length,overlaps,outside:labels.filter(r=>r.x<canvas.x||r.y<canvas.y||r.x+r.w>canvas.right||r.y+r.h>canvas.bottom),sizes:[...document.querySelectorAll('.topic-node')].map(n=>n.getBoundingClientRect().width)};
    });
    if (geometry.count < minimum || geometry.overlaps.length || geometry.outside.length) { await page.screenshot({path:path.join(os.tmpdir(),'ct-graph-narrow-failure.png'),fullPage:true}); console.log(await page.evaluate(()=>({canvas:document.getElementById('graph-container').getBoundingClientRect().toJSON(),zoom:document.getElementById('graph').__zoom,roots:[...document.querySelectorAll('.topic-node')].slice(0,3).map(n=>({x:n.__data__.x,y:n.__data__.y,r:n.__data__.renderRadius,box:n.getBoundingClientRect().toJSON()}))}))); }
    assert.ok(geometry.count>=minimum,`${label}: expected readable labels, got ${geometry.count}`);
    assert.deepEqual(geometry.overlaps,[],`${label}: labels overlap`);assert.deepEqual(geometry.outside,[],`${label}: labels clipped`);
    assert.ok(Math.min(...geometry.sizes)>=21.9,`${label}: trail targets are too small`);
    console.log(label,geometry.count,'readable labels; no collisions');
  };
  assert.equal(await page.locator('.page-node').count(),1025);
  assert.equal(await page.locator('.page-node:visible').count(),0,'overview uses trail roots, retaining page records for detail');
  assert.equal(await page.locator('.collection-node').count(),1,'767 ungrouped pages have a bounded entry point');
  await assertLegible('117-trail overview',15);
  const extent=await page.evaluate(()=>{const canvas=document.getElementById('graph-container').getBoundingClientRect(), nodes=[...document.querySelectorAll('.topic-node,.collection-node')].map(n=>n.getBoundingClientRect());return {x:(Math.max(...nodes.map(r=>r.right))-Math.min(...nodes.map(r=>r.left)))/canvas.width,y:(Math.max(...nodes.map(r=>r.bottom))-Math.min(...nodes.map(r=>r.top)))/canvas.height};});
  assert.ok(extent.x>.55&&extent.y>.55,'overview occupies the canvas instead of fitting an off-screen column');
  await page.screenshot({path:path.join(os.tmpdir(),'ct-large-graph-dark.png')});
  await page.getByRole('button',{name:'Light theme',exact:true}).click();await page.waitForTimeout(220);await assertLegible('Light overview',15);
  await page.screenshot({path:path.join(os.tmpdir(),'ct-large-graph-light.png')});
  await page.getByRole('button',{name:'Dark theme',exact:true}).click();
  await page.getByRole('searchbox').fill('Source 1019:');
  await page.locator('.graph-result').filter({hasText:'Source 1019:'}).click();await page.waitForTimeout(300);
  await page.getByRole('heading',{name:/Source 1019:/}).waitFor();
  assert.ok(await page.locator('.page-node:visible').count()>0);await assertLegible('Search into ungrouped page');
  await page.getByRole('button',{name:'← All trails',exact:true}).click();await page.waitForTimeout(300);
  await page.locator('.collection-node').click();await page.waitForTimeout(300);
  await page.getByRole('heading',{name:'Ungrouped pages',exact:true}).waitFor();
  assert.equal(await page.locator('.page-node:visible').count(),767);assert.equal(await page.locator('.graph-result').count(),30);
  await page.getByRole('button',{name:'Show more (737 remaining)'}).click();assert.equal(await page.locator('.graph-result').count(),60);
  await assertLegible('767-page collection');
  await page.getByRole('button',{name:'← All trails',exact:true}).click();await page.waitForTimeout(300);
  await page.getByRole('searchbox').fill('Rust async');await page.keyboard.press('Enter');await page.waitForTimeout(300);
  await page.getByRole('heading',{name:/Rust async programming/}).waitFor();
  assert.ok(await page.locator('.page-node:visible').count()>=2);await assertLegible('Selected trail');
  await page.screenshot({path:path.join(os.tmpdir(),'ct-large-graph-detail.png')});
  await page.locator('#graph-labels').selectOption('all');await assertLegible('More labels still avoid collisions');
  await page.getByRole('button',{name:'Fit graph to view'}).click();await page.waitForTimeout(300);
  for(const width of [1280,1024,768,390,320]){
    await page.setViewportSize({width,height:1000});await page.waitForTimeout(350);
    await assertLegible(`Overview at ${width}`,width<500?1:5);
    const overflow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,elements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,class:e.getAttribute('class')})).slice(0,10)}));
    assert.ok(overflow.width<=width+1,`${width}: horizontal overflow ${JSON.stringify(overflow)}`);
  }
  assert.deepEqual(errors,[]);console.log('Large graph navigation and geometry passed: 117 trails, 1,025 pages, 1,962 visits.');
} finally {await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
