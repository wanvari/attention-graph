'use strict';
const assert=require('node:assert/strict'), Home=require('../../ui/newtab');
const bucket=2*3600000,t=Math.floor(new Date(2026,8,12,12).getTime()/bucket)*bucket;
const record={trails:[{id:'finny',label:'FINNY'}],events:[{time:t-1000,topicIds:['finny']}]};
assert.deepEqual(Home.homeMessage(record,t),Home.homeMessage(record,t+bucket-1));
assert.notEqual(Home.homeMessage(record,t).title,Home.homeMessage(record,t+bucket).title);
const messages=Array.from({length:6},(_,i)=>Home.homeMessage(record,t+i*bucket).title);
assert.equal(new Set(messages).size,6);assert.ok(messages.some(s=>s.includes('FINNY')));
assert.deepEqual(Home.homeMessage({...record,events:record.events.concat({time:t+1000,topicIds:[]})},t+2000),Home.homeMessage(record,t),'current bucket browsing cannot change the headline');
assert.ok(Home.homeMessage({trails:[],events:[]},t).title);
console.log('Two-hour homepage message stability, personalization and empty record passed');

// Existing tabs rotate on the normal refresh, and owned store connections close.
const {JSDOM}=require('jsdom');
(async()=>{
  const dom=new JSDOM('<main id="app"></main>',{url:'https://localhost/ui/newtab.html',pretendToBeVisual:true});
  const actualNow=Date.now,oldStore=global.CTStore;let clock=t,closed=0;
  try{
    Date.now=()=>clock;
    global.CTStore={createStore:()=>({open:async()=>{},readSnapshot:async()=>({}),close:()=>closed++})};
    const view=await Home.main({container:dom.window.document.getElementById('app')});
    const headline=dom.window.document.querySelector('.nt-hero h1'),first=headline.textContent;
    clock=t+bucket-1;view.update({});assert.equal(headline.textContent,first);
    clock=t+bucket;view.update({});assert.notEqual(headline.textContent,first);
    view.dispose();assert.equal(closed,1);
  }finally{Date.now=actualNow;global.CTStore=oldStore;dom.window.close();}
})().catch(e=>{console.error(e);process.exit(1);});
