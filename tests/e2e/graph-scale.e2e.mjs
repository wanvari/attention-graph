import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),makeRecord=require('../fixtures/largeGraph');
const root=path.resolve(import.meta.dirname,'../..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ct-atlas-scale-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,viewport:{width:1536,height:1100},reducedMotion:'reduce',args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/ui/map.html`);await page.locator('.studio-shell').waitFor();
  await page.evaluate(async snapshot=>{const store=CTStore.createStore({});await store.open();for(const [name,rows] of Object.entries(snapshot))if(rows.length)await store.bulkPut(name,rows);store.close();},makeRecord(Date.now()));
  await page.reload();await page.locator('.atlas-group').first().waitFor();
  assert.equal(await page.locator('.topic-node').count(),117);
  assert.equal(await page.locator('.page-node').count(),1025);
  assert.equal(await page.locator('.topic-node:visible').count(),0,'the overview does not compress 117 dots into the viewport');
  const checkLayout=async()=>{
    const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,clipped:[...document.querySelectorAll('.atlas-card-heading strong,.atlas-preview span')].filter(n=>n.getBoundingClientRect().width&&n.scrollWidth>n.clientWidth+1).map(n=>n.textContent)}));
    assert.equal(geometry.overflow,false);assert.deepEqual(geometry.clipped,[],'group names and preview titles wrap within their cards');
  };
  await checkLayout();await page.screenshot({path:path.join(os.tmpdir(),'ct-atlas-large-dark.png'),fullPage:true});
  await page.getByRole('button',{name:'Light theme',exact:true}).click();await checkLayout();
  await page.screenshot({path:path.join(os.tmpdir(),'ct-atlas-large-light.png'),fullPage:true});
  await page.getByRole('button',{name:'Dark theme',exact:true}).click();
  await page.getByRole('button',{name:'Browse all trails ↗',exact:true}).click();
  assert.equal(await page.locator('.graph-result').count(),30);
  while(await page.locator('#graph-atlas > .graph-more:visible').count())await page.locator('#graph-atlas > .graph-more').click();
  assert.equal(await page.locator('.graph-result').count(),117,'every trail remains reachable');
  await page.getByRole('button',{name:'← All trails',exact:true}).click();
  await page.locator('.atlas-ungrouped').click();
  assert.equal(await page.locator('.graph-result').count(),30);
  await page.getByRole('button',{name:'Show more (737 remaining)',exact:true}).click();assert.equal(await page.locator('.graph-result').count(),60);
  assert.equal(await page.locator('.page-node:visible').count(),0,'hundreds of ungrouped pages use a readable list');
  await page.getByRole('searchbox').fill('Source 1019:');await page.locator('.graph-result').filter({hasText:'Source 1019:'}).click();
  await page.getByRole('heading',{name:/Source 1019:/}).waitFor();assert.equal(await page.locator('.page-node:visible').count(),1);
  await page.getByRole('button',{name:'← All trails',exact:true}).click();
  for(const width of [1536,1280,1024,768,390,320]){await page.setViewportSize({width,height:1000});await checkLayout();}
  // A single very large trail still gets a bounded diagram and a full source list.
  await page.setViewportSize({width:1536,height:1100});
  await page.evaluate(async()=>{const s=CTStore.createStore({});await s.open();for(let i=258;i<418;i++)await s.put('memberships',{normalizedUrl:`https://source-${i%37}.example.test/article-${i}`,topicId:'large-0'});s.close();});
  await page.reload();await page.locator('.atlas-group').first().waitFor();
  await page.getByRole('searchbox').fill('Rust async');await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:/Rust async programming/}).waitFor();
  assert.equal(await page.locator('.page-node:visible').count(),8);
  assert.equal(await page.locator('#graph-topic-pages .graph-result').count(),30);
  assert.ok(await page.locator('.page-label:visible').count()>=6,'bounded detail makes room for useful labels');
  const overlaps=await page.locator('.page-label:visible,.topic-label:visible').evaluateAll(nodes=>{const b=nodes.map(n=>n.getBoundingClientRect());return b.flatMap((a,i)=>b.slice(i+1).filter(c=>a.left<c.right&&a.right>c.left&&a.top<c.bottom&&a.bottom>c.top));});
  assert.equal(overlaps.length,0,'focused labels never collide');
  await page.screenshot({path:path.join(os.tmpdir(),'ct-atlas-large-detail.png')});
  await page.locator('#graph-topic-pages .graph-more').click();assert.equal(await page.locator('#graph-topic-pages .graph-result').count(),60);
  for(const width of [768,390,320]){await page.setViewportSize({width,height:1000});await checkLayout();}
  assert.deepEqual(errors,[]);console.log('Atlas scale passed: 117 trails, 1,025 pages; full lists, title wrapping, ungrouped search, eight-page focus, collision-free labels and phone widths.');
}finally{await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
