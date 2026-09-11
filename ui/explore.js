(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports
    ? factory(require('../lib/text.js'), require('../lib/trails.js'), require('../lib/dashboard.js'), require('./studio.js'))
    : factory(root.CTText, root.CTTrails, root.CTDashboard, root.CTStudio);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTExplore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Text, Trails, Dashboard, Studio) {
  'use strict';
  const UNGROUPED = '__ungrouped__', OTHER = '__other__';
  const minutes = ms => Math.round(ms / 60000);
  const formatTime = ms => { const m = minutes(ms); return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; };
  function dayBounds(day) { const [y,m,d]=day.split('-').map(Number);return {from:new Date(y,m-1,d).getTime(),to:new Date(y,m-1,d+1).getTime()}; }
  function buildSeries(record, options={}) {
    const count=options.days||7, endDay=options.endDay||Text.dayKeyFromMs(record.now), days=[];
    for(let offset=count-1;offset>=0;offset--) {
      const day=Text.addDays(endDay,-offset), bounds=dayBounds(day);bounds.to=Math.min(bounds.to,record.now);
      const measured=Dashboard.measure(record,bounds), visits=record.events.filter(e=>e.time>=bounds.from&&e.time<bounds.to);
      const values=new Map();
      for(const [id,ms] of measured.byTopic)values.set(id,{ms,visits:0});
      if(measured.ungroupedMs)values.set(UNGROUPED,{ms:measured.ungroupedMs,visits:0});
      for(const event of visits){const id=event.topicIds[0]||UNGROUPED,row=values.get(id)||{ms:0,visits:0};row.visits++;values.set(id,row);}
      days.push({day,bounds,values,ms:measured.totalMs,visits:visits.length,events:measured.events,slices:measured.slices});
    }
    const totals=new Map();
    for(const day of days)for(const [id,row] of day.values){const total=totals.get(id)||{ms:0,visits:0};total.ms+=row.ms;total.visits+=row.visits;totals.set(id,total);}
    const topics=[...totals.keys()].filter(id=>id!==UNGROUPED).sort((a,b)=>totals.get(b).ms-totals.get(a).ms||totals.get(b).visits-totals.get(a).visits||a.localeCompare(b));
    const categories=topics.slice(0,4);
    if(topics.length>4)categories.push(OTHER);
    if(totals.has(UNGROUPED))categories.push(UNGROUPED);
    const label=id=>id===UNGROUPED?'Ungrouped pages':id===OTHER?'Other trails':record.trails.find(t=>t.id===id)?.label||'Recorded trail';
    const color=id=>id===UNGROUPED?'var(--text-dim)':id===OTHER?'var(--trail-7)':Studio.topicColor(id);
    const bucket=(day,id,metric)=>id===OTHER?topics.slice(4).reduce((sum,t)=>sum+(day.values.get(t)?.[metric]||0),0):day.values.get(id)?.[metric]||0;
    return {days,totals,categories,label,color,bucket,ms:days.reduce((n,d)=>n+d.ms,0),visits:days.reduce((n,d)=>n+d.visits,0)};
  }
  function mount(container, record, options={}) {
    const doc=container.ownerDocument, el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
    let days=7, endDay=Text.dayKeyFromMs(record.now), selected=endDay, metric='ms';
    const demo=!!options.demo;
    const button=(label,fn,cls='explore-button')=>{const b=el('button',cls,label);b.type='button';b.addEventListener('click',fn);return b;};
    function draw() {
      const active = container.contains(doc.activeElement) ? { label: doc.activeElement.getAttribute('aria-label'), text: doc.activeElement.textContent, tag: doc.activeElement.tagName } : null;
      const series=buildSeries(record,{days,endDay}); container.textContent='';
      const intro=el('div','explore-heading');intro.append(el('p','studio-kicker',demo?'A recorded sample':'Explore your record'),el('h1',null,'A little perspective.'),el('p','explore-sub','See when you browsed, which trails you visited, and the pages behind each day.'));
      container.append(intro);
      const card=el('section','explore-card'),head=el('div','explore-card-head'),title=el('div');title.append(el('p','studio-kicker','Recorded activity'),el('h2',null,`${shortDate(series.days[0].day)} – ${shortDate(endDay)}`));
      const tools=el('div','explore-controls');
      for(const [key,label] of [['ms','Estimated time'],['visits','Visits']]){const b=button(label,()=>{metric=key;draw();});b.setAttribute('aria-pressed',String(metric===key));tools.append(b);}
      const range=el('select');range.setAttribute('aria-label','Chart date range');for(const value of [7,14]){const o=el('option',null,`${value} days`);o.value=value;range.append(o);}range.value=days;range.addEventListener('change',()=>{days=Number(range.value);draw();});tools.append(range);head.append(title,tools);card.append(head);
      const total=el('div','explore-total');total.append(el('strong',null,metric==='ms'?formatTime(series.ms):series.visits.toLocaleString()),el('span',null,metric==='ms'?'estimated browsing time in this period':'recorded visit starts in this period'));card.append(total);
      const chart=el('div','explore-chart'),max=Math.max(1,...series.days.map(d=>d[metric]));chart.setAttribute('role','group');chart.setAttribute('aria-label',`Daily ${metric==='ms'?'estimated time':'visit starts'}. Select a day to inspect its pages.`);
      for(const day of series.days) {
        const column=button('',()=>{selected=day.day;draw();},'explore-column');column.setAttribute('aria-pressed',String(selected===day.day));column.setAttribute('aria-label',`${shortDate(day.day)}, ${metric==='ms'?formatTime(day.ms)+' estimated':day.visits+' visits'}, inspect day`);
        column.append(el('span','explore-bar-value',metric==='ms'?formatTime(day.ms):String(day.visits)));
        const track=el('span','explore-bar-track');const stack=el('span','explore-bar-stack');stack.style.height=`${day[metric]/max*100}%`;
        for(const id of series.categories){const value=series.bucket(day,id,metric);if(!value)continue;const segment=el('span','explore-segment');segment.style.height=`${value/day[metric]*100}%`;segment.style.background=series.color(id);segment.title=`${series.label(id)} · ${metric==='ms'?formatTime(value)+' estimated':value+' visits'}`;stack.append(segment);}track.append(stack);column.append(track,el('span','explore-day',new Date(day.bounds.from).toLocaleDateString(undefined,{weekday:'short'})),el('span','explore-date',new Date(day.bounds.from).getDate()));chart.append(column);
      }
      card.append(chart);
      const legend=el('div','explore-legend');for(const id of series.categories){const item=el('span',null,series.label(id)),dot=el('i','studio-dot');dot.style.background=series.color(id);item.prepend(dot);legend.append(item);}card.append(legend);
      if(!series.ms&&!series.visits)card.append(el('p','explore-sub','No recorded activity in this period. Browse normally or open an earlier period.'));
      const foot=el('div','explore-card-foot');foot.append(button('← Earlier',()=>{endDay=Text.addDays(endDay,-days);selected=endDay;draw();}));const newer=button('Later →',()=>{endDay=Text.addDays(endDay,days);const today=Text.dayKeyFromMs(record.now);if(endDay>today)endDay=today;selected=endDay;draw();});newer.disabled=endDay>=Text.dayKeyFromMs(record.now);foot.append(el('span','explore-sub','Select a bar to see the day.'),newer);card.append(foot);container.append(card);
      const day=series.days.find(d=>d.day===selected)||series.days.at(-1),detail=el('section','explore-detail');detail.setAttribute('aria-label','Selected day');
      const summary=el('div','explore-card');summary.append(el('p','studio-kicker','Selected day'),el('h2',null,longDate(day.day)),el('p','explore-selected-total',`${formatTime(day.ms)} estimated · ${day.visits} visit starts`));
      const ranked=[...day.values].sort((a,b)=>b[1][metric]-a[1][metric]);
      for(const [id,value] of ranked){const row=el('div','explore-breakdown'),a=el(id===UNGROUPED?'span':'a',null,series.label(id));if(id!==UNGROUPED)a.href=`${demo?'demo.html':'newtab.html'}?trail=${encodeURIComponent(id)}`;const dot=el('i','studio-dot');dot.style.background=series.color(id);a.prepend(dot);row.append(a,el('strong',null,metric==='ms'?formatTime(value.ms):String(value.visits)));summary.append(row);}
      if(!ranked.length)summary.append(el('p','explore-sub','No pages recorded on this day.'));
      const graphLink=el('a','explore-graph-link','See connections in Graph ↗');graphLink.href=demo?'map.html?demo=1':'map.html';summary.append(graphLink);
      const sources=el('div','explore-card');sources.append(el('p','studio-kicker','Underlying record'),el('h2',null,'Pages from this day'));
      const attributed = new Map(); for (const slice of day.slices) attributed.set(slice.event.id, (attributed.get(slice.event.id) || 0) + slice.end - slice.start);
      const list=el('ol','explore-pages');for(const event of day.events){const li=el('li'),a=el('a',null,event.title);a.href=event.url;a.target='_blank';a.rel='noopener noreferrer';const ms=attributed.get(event.id)||0;const when=event.time<day.bounds.from?'Started earlier':new Date(event.time).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});li.append(a,el('span',null,`${when} · ${event.domain} · ${event.timingMethod.endsWith('unknown')?'duration unknown':formatTime(ms)+' estimated'}`));list.append(li);}sources.append(list);if(!day.events.length)sources.append(el('p','explore-sub','Your recorded pages will appear here.'));detail.append(summary,sources);container.append(detail);
      const method=el('details','explore-method');method.append(el('summary',null,'How this chart is calculated'),el('p',null,'Time uses the same recorded activity and estimates as Home. Overlapping tabs count once. Days follow your local time zone; today ends at the latest read. Visits count starts within each day. A page started earlier can contribute time without adding a new visit. Ungrouped pages and other trails remain in the totals. Minute labels are rounded; the bars use the underlying durations.'));container.append(method);
      if (active) { const control = [...container.querySelectorAll('button,select')].find(n => n.tagName === active.tag && (active.label ? n.getAttribute('aria-label') === active.label : n.textContent === active.text)); control?.focus({ preventScroll: true }); }
    }
    function shortDate(day){return new Date(dayBounds(day).from).toLocaleDateString(undefined,{month:'short',day:'numeric'});}
    function longDate(day){return new Date(dayBounds(day).from).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});}
    draw();return {update(next){record=next;draw();}};
  }
  return {buildSeries,dayBounds,mount,UNGROUPED,OTHER};
});
if(typeof document!=='undefined'&&typeof module==='undefined')document.addEventListener('DOMContentLoaded',async()=>{
  const host=document.getElementById('explore-app');if(!host)return;
  try {
    const demo=new URLSearchParams(location.search).get('demo')==='1';let snapshot,now=Date.now();
    if(demo){const response=await fetch('../fixtures/current/snapshot.json');if(!response.ok)throw new Error('Sample unavailable');snapshot=await response.json();const last=(snapshot.daily_metrics||[]).map(d=>d.day).sort().pop();now=CTText.dayKeyToNoonMs(last)+9*3600000;}
    else snapshot=await CTTrails.loadData(CTStore.createStore({}));
    CTExplore.mount(host,CTTrails.buildRecord(snapshot,{now}),{demo});
  }catch{host.textContent='The record could not be loaded. Reload this page to try again.';}
});
