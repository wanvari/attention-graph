// Synthetic reproduction: related FINNY titles, only single cross-trail
// sequences, and a much denser company-profile trail. Never reads user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ct-connections-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,viewport:{width:1536,height:1100},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/ui/map.html`);await page.locator('.studio-shell').waitFor();
  await page.evaluate(async()=>{
    const store=CTStore.createStore({});await store.open();const start=Date.now()-4*3600000;
    const names=['FINNY AI Company Profile','FINNY job listings','Finny welcome page','Finny AI company products','Acme Company Profile'];
    let cursor=0;
    for(let i=0;i<names.length;i++){
      const topicId=`finny-test-${i}`,url=`https://example-${i}.test/article`,title=names[i];
      await store.put('topics',{topicId,label:title,state:'active'});
      await store.put('pages',{normalizedUrl:url,url,title});
      await store.put('memberships',{topicId,normalizedUrl:url});
      for(let j=0;j<(i===0?40:1);j++){
        await store.put('visits',{visitId:`f-${i}-${j}`,normalizedUrl:url,url,title,visitTime:start+cursor*180000,dwellMs:120000});cursor++;
      }
    }
    // An ungrouped page between repeat visits provides auditable exclusions.
    for(let i=0;i<4;i++){
      const url=i%2?'https://example-4.test/article':'https://unclassified.test/source';
      await store.put('visits',{visitId:`u-${i}`,normalizedUrl:url,url,title:i%2?'Acme Company Profile':'Unclassified source',visitTime:Date.now()-900000+i*120000,dwellMs:60000});
    }
    store.close();
  });
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.topic-node').length===5);
  assert.equal(await page.locator('.graph-region').count(),1,'FINNY titles share one halo; other trails stand alone');
  assert.equal(await page.locator('.group-label').first().textContent(),'FINNY');
  assert.equal(await page.locator('.flow-link').count(),0,'single cross-trail visits cannot become repeated routes');
  // Circles sit inside the halo, so the keyboard is the reliable way to select it.
  await page.getByRole('button',{name:'Related titles: FINNY, 4 trails',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'FINNY',exact:true}).waitFor();
  assert.equal(await page.locator('.graph-result').count(),4);
  assert.equal(await page.locator('.graph-site-row').first().locator('small').textContent(),'40 visits · 1 page');
  await page.getByText('Browsing order · 43 visits',{exact:true}).click();
  assert.equal(await page.locator('.graph-timeline li').count(),30);
  await page.getByRole('button',{name:'Show more (13 remaining)'}).click();
  assert.equal(await page.locator('.graph-timeline li').count(),43);
  await page.locator('.graph-result').filter({hasText:'FINNY job listings'}).click();
  await page.getByRole('heading',{name:'FINNY job listings',exact:true}).waitFor();
  assert.ok((await page.locator('#evidence-panel').textContent()).includes('Related titles · FINNY'));
  assert.equal(await page.locator('.graph-result').filter({hasText:'FINNY AI Company Profile'}).count(),1);
  await page.waitForTimeout(300);
  await page.screenshot({path:path.join(os.tmpdir(),'ct-finny-related-detail.png')});
  await page.getByRole('button',{name:'← All trails',exact:true}).click();
  await page.getByText('How connections are counted',{exact:true}).click();
  const audit=await page.locator('.graph-connection-audit').textContent();
  assert.ok(audit.includes('3 with an ungrouped page.'));assert.ok(audit.includes('2 distinct directed page pairs'));
  await page.getByText('Inspect ungrouped steps (3)',{exact:true}).click();
  assert.equal(await page.locator('.graph-connection-audit .evidence-list li').count(),3);
  assert.equal(await page.locator('.graph-connection-audit .evidence-list a').count(),6);
  assert.equal(await page.locator('.graph-connection-audit .evidence-list small').count(),3,'every step includes its timestamp');
  assert.deepEqual(errors,[]);
  console.log('FINNY related titles without fabricated routes; density, group websites, full chronological drill-down and auditable distinct pairs passed');
} finally {await context?.close();fs.rmSync(profile,{recursive:true,force:true});}
