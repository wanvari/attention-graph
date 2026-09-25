import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'../..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ct-navigation-'));
let context;
try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/ui/newtab.html`);await page.locator('.nt-ring-title').first().waitFor();
  // Every route is reached through the dock; pages may link to the same places in their text.
  const dock=page.locator('.studio-sidebar');
  await page.evaluate(()=>{window.navigationSentinel={};window.originalDock=document.querySelector('.studio-sidebar');});
  await page.getByRole('searchbox').fill('Unsubmitted draft');
  await page.getByRole('button',{name:'Focus search',exact:true}).click();
  assert.equal(await page.getByRole('searchbox').inputValue(),'Unsubmitted draft');
  assert.equal(await page.getByRole('searchbox').evaluate(n=>document.activeElement===n),true);
  for(const label of ['Your trails','Graph','Explore','Settings','Record & privacy','Home','Graph','Home']){
    const href=await dock.getByRole('link',{name:label,exact:true}).getAttribute('href');
    await dock.getByRole('link',{name:label,exact:true}).click();await page.waitForURL(new URL(href,`${origin}/ui/`).href);
    await page.evaluate(()=>window.ctLastNavigationTransition?.finished);
    assert.equal(await page.evaluate(()=>!!window.navigationSentinel&&window.originalDock===document.querySelector('.studio-sidebar')),true,`${label}: dock and document persist`);
    assert.equal(await dock.getByRole('link',{name:label,exact:true}).getAttribute('aria-current'),'page');
  }
  await page.goBack();await page.waitForURL(`${origin}/ui/map.html`);await page.getByRole('heading',{name:'Your trail map',exact:true}).waitFor();
  await page.goForward();await page.waitForURL(`${origin}/ui/newtab.html`);await page.locator('.nt-ring-title').first().waitFor();
  await page.getByRole('button',{name:'Light theme',exact:true}).click();
  await dock.getByRole('link',{name:'Settings',exact:true}).click();await page.waitForURL(`${origin}/ui/options.html`);await page.evaluate(()=>window.ctLastNavigationTransition?.finished);
  assert.equal(await page.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(247, 248, 251)');
  await page.reload();await page.locator('.studio-sidebar').waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  const nav=dock.getByRole('link',{name:'Graph',exact:true});await nav.hover();await page.waitForTimeout(300);
  assert.equal(await page.locator('.studio-hover-pill').evaluate(n=>getComputedStyle(n).opacity),'1');
  const start=await page.locator('.studio-hover-pill').evaluate(n=>getComputedStyle(n).transform);
  await dock.getByRole('link',{name:'Your trails',exact:true}).hover();await page.waitForTimeout(60);
  const midway=await page.locator('.studio-hover-pill').evaluate(n=>getComputedStyle(n).transform);
  await page.waitForTimeout(300);const end=await page.locator('.studio-hover-pill').evaluate(n=>getComputedStyle(n).transform);
  assert.notEqual(midway,start);assert.notEqual(midway,end,'dock highlight moves continuously between items');
  assert.deepEqual(errors,[]);console.log('Persistent document and dock across eight routes; animated content, back/forward, search action, fluid hover, light persistence passed.');
}finally{await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
