import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ct-studio-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/ui/newtab.html`);await page.locator('.studio-shell').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.evaluate(async()=>{
    const store=CTStore.createStore({});await store.open();
    const now=Date.now(), midnight=new Date().setHours(0,0,0,0), start=midnight-8*3600000;
    for(const [topicId,label]of[['studio-a','Async Rust'],['studio-b','Sourdough']])await store.put('topics',{topicId,label,state:'active'});
    for(let n=0;n<15;n++){
      const url=`https://example.test/page-${n}`,topicId=n===14?null:n%2?'studio-b':'studio-a';
      await store.put('pages',{normalizedUrl:url,url,title:`Recorded page ${n}`});
      if(topicId)await store.put('memberships',{normalizedUrl:url,topicId});
      await store.put('visits',{visitId:`studio-${n}`,normalizedUrl:url,url,title:`Recorded page ${n}`,visitTime:start+n*5*60000,dwellMs:120000});
    }
    await store.put('visits',{visitId:'studio-today',url:'https://example.test/today',title:'Today page',visitTime:Math.max(midnight,now-60000),dwellMs:1000});
  });
  await page.reload();await page.getByRole('button',{name:'Async Rust',exact:true}).waitFor();
  const second=await context.newPage();second.on('pageerror',e=>errors.push(e.message));await second.goto(`${origin}/ui/map.html`);await second.locator('.topic-node').first().waitFor();
  await page.getByRole('button',{name:'Light theme',exact:true}).click();
  await second.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await page.reload();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  assert.equal(await second.locator('.page-node').count(),16,'full graph includes all pages and ungrouped records');
  assert.equal(await second.locator('.flow-link').count(),2,'repeated sequences in both directions remain clickable');
  await second.locator('.flow-link').first().focus();await second.keyboard.press('Enter');
  await second.getByRole('heading',{name:'Recorded page sequences'}).waitFor();
  await second.getByRole('searchbox',{name:'Find a trail or page'}).fill('Async Rust');await second.keyboard.press('Enter');
  await second.getByRole('heading',{name:'Async Rust',exact:true}).waitFor();await second.getByRole('button',{name:'Zoom to this trail'}).click();
  await second.waitForTimeout(400);
  const transform=await second.evaluate(()=>document.querySelector('#graph > g').getAttribute('transform'));
  const positions=await second.locator('.topic-node').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')]));
  await second.getByRole('button',{name:'Dark theme',exact:true}).click();
  assert.equal(await second.evaluate(()=>document.querySelector('#graph > g').getAttribute('transform')),transform);
  assert.deepEqual(await second.locator('.topic-node').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')])),positions);
  await second.locator('#show-pages').uncheck();assert.equal(await second.locator('.page-node:visible').count(),0);
  await second.locator('#show-pages').check();await second.locator('#graph-labels').selectOption('all');assert.ok(await second.locator('.page-label:visible').count()>0);
  await second.getByRole('searchbox').fill('no such recorded page');await second.getByText('0 matching trails and pages. Press Enter to inspect the first match.').waitFor();
  await second.getByRole('button',{name:'Clear selection',exact:true}).click();
  await second.getByRole('button',{name:'Fit graph to view'}).click();await second.waitForTimeout(400);
  const topic=second.locator('.topic-node').first(),box=await topic.boundingBox();
  const before=await topic.evaluate(n=>({x:n.__data__.x,y:n.__data__.y,id:n.__data__.id}));
  const childrenBefore=await second.locator('.page-node').evaluateAll((nodes,id)=>nodes.filter(n=>n.__data__.parentTopicId===id).map(n=>({x:n.__data__.x,y:n.__data__.y})),before.id);
  await second.mouse.move(box.x+box.width/2,box.y+box.height/2);await second.mouse.down();await second.mouse.move(box.x+box.width/2+45,box.y+box.height/2+20,{steps:8});await second.mouse.up();
  const after=await topic.evaluate(n=>({x:n.__data__.x,y:n.__data__.y}));assert.ok(Math.abs(after.x-before.x)>10);
  const childrenAfter=await second.locator('.page-node').evaluateAll((nodes,id)=>nodes.filter(n=>n.__data__.parentTopicId===id).map(n=>({x:n.__data__.x,y:n.__data__.y})),before.id);
  childrenAfter.forEach((p,i)=>assert.ok(Math.abs((p.x-childrenBefore[i].x)-(after.x-before.x))<.1,'trail drag carries its pages'));
  await page.goto(`${origin}/ui/explore.html`);await page.locator('.explore-column').first().waitFor();
  await page.getByRole('button',{name:'Visits',exact:true}).click();assert.equal(await page.locator('.explore-total strong').textContent(),'16');
  await page.locator('.explore-column').nth(5).click();assert.equal(await page.locator('.explore-pages li').count(),15);
  await page.getByLabel('Chart date range').selectOption('14');assert.equal(await page.locator('.explore-column').count(),14);assert.equal(await page.locator('.explore-total strong').textContent(),'16');
  for(const file of ['newtab.html','map.html','explore.html','options.html','audit.html','diagnostics.html']) {
    await page.goto(`${origin}/ui/${file}`);await page.locator('.studio-shell').waitFor();
    for(const theme of ['Light','Dark']){
      await page.getByRole('button',{name:`${theme} theme`,exact:true}).click();
      for(const width of [1536,1024,768,390,320]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${file} ${theme}: overflow at ${width}`);}
    }
  }
  assert.deepEqual(errors,[]);console.log('Studio theme sync and persistence; full graph, edges, search, keyboard, drag, zoom and labels; real chart totals and drill-down; six screens in two themes at five widths passed');
} finally {await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
