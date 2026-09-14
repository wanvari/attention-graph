// Home stays quiet while search and evidence remain fully usable.
'use strict';
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const Home = require('../../ui/newtab');
(async () => {
  const dom = new JSDOM('<main id="app"></main>', {url:'https://localhost/ui/newtab.html', pretendToBeVisual:true});
  const doc = dom.window.document, now = new Date(2026, 8, 14, 15).getTime();
  const oldStore = global.CTStore; let closed = 0;
  try {
    global.CTStore = {createStore:()=>({open:async()=>{}, readSnapshot:async()=>({}), close:()=>closed++})};
    const view = await Home.main({container:doc.getElementById('app'), now});
    const input = doc.querySelector('.nt-search-input');
    assert.equal(doc.activeElement, input, 'a new tab is immediately ready to type');
    assert.equal(doc.querySelector('.nt-layout').hidden, true);
    assert.deepEqual([...doc.querySelectorAll('.nt-ring-title')].map(n=>n.textContent), ['Continuity','Top trail','Return share']);
    assert.deepEqual([...doc.querySelectorAll('.nt-ring-dial strong')].map(n=>n.textContent), ['—','—','—'], 'missing evidence is not a zero score');
    assert.equal(doc.querySelector('.nt-continuation'), null);
    const snapshot = {visits:[{visitId:'page', url:'https://example.test/rust', title:'Rust guide', visitTime:now-60000, dwellMs:30000}]};
    view.update(snapshot);
    input.value = 'Rust'; input.dispatchEvent(new dom.window.Event('input'));
    doc.querySelector('.nt-search').dispatchEvent(new dom.window.Event('submit', {cancelable:true}));
    assert.equal(doc.querySelector('.nt-layout').hidden, false);
    assert.equal(doc.querySelector('.nt-content .nt-page-link').textContent, 'Rust guide');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    assert.equal(doc.querySelector('.nt-layout').hidden, true);
    assert.equal(input.value, '');
    const ring = doc.querySelector('.nt-ring-card'); ring.focus(); ring.click();
    assert.ok(doc.querySelector('dialog').textContent.includes('Same-trail transitions ÷'));
    doc.querySelector('dialog button').click();
    assert.equal(doc.activeElement, ring, 'closing evidence returns focus to its ring');
    view.update(snapshot);
    assert.notEqual(doc.activeElement, input, 'background refresh does not steal focus');
    view.dispose(); assert.equal(closed, 1);
  } finally {global.CTStore=oldStore; dom.window.close();}
  console.log('Minimal home, initial focus, empty evidence, search, Escape, drawers and owned-store cleanup passed');
})().catch(e=>{console.error(e);process.exit(1);});
