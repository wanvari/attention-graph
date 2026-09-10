/* Presentation-only prototype. Only the theme preference is saved locally;
   sample records, notes, pins, and graph positions remain in memory. */
(() => {
  'use strict';
  const icons = {
    moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    graph: '<circle cx="7" cy="7" r="3"/><circle cx="18" cy="5" r="2"/><circle cx="17" cy="18" r="3"/><circle cx="4" cy="19" r="2"/><path d="m10 7 6-2M9 9l6 7M6 10 4 17m2 2 8-1"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    external: '<path d="M14 4h6v6m-1-5L9 15m1-10H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
    layers: '<path d="m3 7 9-4 9 4-9 4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
    timeline: '<path d="M4 5h16M4 12h16M4 19h16"/><rect x="7" y="3" width="5" height="4" rx="1" fill="currentColor"/><rect x="13" y="10" width="6" height="4" rx="1" fill="currentColor"/><rect x="5" y="17" width="5" height="4" rx="1" fill="currentColor"/>',
    chart: '<path d="M4 4v16h17M8 15v-4m5 4V7m5 8V3"/>',
    route: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 12h3a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3h1m-7 7a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3h1"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
    model: '<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M12 12 3 7m9 5v10M7 4.8l10 5.5v4"/>',
    bread: '<path d="M5 11C0 8 4 3 8 4c2-3 6-3 8 0 4-1 8 4 3 7v9H5Z"/><path d="M8 8v2m4-3v3m4-2v2"/>',
    running: '<path d="M14 4h.01M9 9l4-2 3 5h4M13 7l-2 7 4 3-1 4M11 14l-4 6H3"/><circle cx="14" cy="3" r="1"/>',
    other: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    pin: '<path d="m9 3 8 2-2 5 3 5-6-1-4 3-1-6 3-3Zm1 12-5 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    note: '<path d="M5 3h14v13l-5 5H5Zm9 18v-5h5M8 7h8M8 11h6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
    back: '<path d="M20 12H4m5-5-5 5 5 5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.layers}</svg>`;
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const brand = `<span class="brand-symbol" aria-hidden="true"><svg viewBox="0 0 30 34" fill="none"><path d="M7 27c0-11 16-10 16-20M7 18c0-6 9-7 9-12" stroke="currentColor" stroke-width="2.7" stroke-linecap="round"/><circle cx="7" cy="28" r="3" fill="currentColor"/><circle cx="23" cy="6" r="3" fill="currentColor"/></svg></span><span>Cognitive Trails</span>`;
  const topics = [
    {id:'rust',label:'Rust & async',short:'Rust & async',icon:'code',note:'Pick up at channels. Try a bounded queue in the little crawler.',pages:[['Channels & message passing','tokio.rs','https://tokio.rs/tokio/tutorial/channels'],['Shared state in async Rust','tokio.rs','https://tokio.rs/tokio/tutorial/shared-state'],['Async in depth','tokio.rs','https://tokio.rs/tokio/tutorial/async'],['Spawning tasks','tokio.rs','https://tokio.rs/tokio/tutorial/spawning'],['An async Rust overview','rust-lang.org','https://www.rust-lang.org/']]},
    {id:'models',label:'Local language models',short:'Local models',icon:'model',note:'Compare memory use with the smaller model.',pages:[['Model library','ollama.com','https://ollama.com/library'],['Running a model locally','docs.ollama.com','https://docs.ollama.com/'],['Quantization notes','github.com','https://github.com/ggml-org/llama.cpp'],['The model collection','huggingface.co','https://huggingface.co/models']]},
    {id:'bread',label:'The sourdough notebook',short:'Sourdough',icon:'bread',note:'Try the longer cold proof this weekend.',pages:[['A beginner’s sourdough guide','theperfectloaf.com','https://www.theperfectloaf.com/beginners-sourdough-bread/'],['Sourdough starter','kingarthurbaking.com','https://www.kingarthurbaking.com/recipes/sourdough-starter-recipe'],['Baking with sourdough','kingarthurbaking.com','https://www.kingarthurbaking.com/learn/guides/sourdough']]},
    {id:'running',label:'A little further, on foot',short:'Running',icon:'running',note:'Save the route idea for Sunday.',pages:[['Notes on running','runnersworld.com','https://www.runnersworld.com/'],['Route ideas','strava.com','https://www.strava.com/'],['Training conversations','letsrun.com','https://www.letsrun.com/']]},
    {id:'other',label:'Ungrouped pages',short:'Ungrouped',icon:'other',note:'',pages:[['The daily links','news.ycombinator.com','https://news.ycombinator.com/'],['A little of everything','reddit.com','https://www.reddit.com/']]}
  ];
  const topicById = Object.fromEntries(topics.map(t => [t.id,t]));
  const matrix = [[34,18,0,22,8],[0,0,44,27,5],[20,0,32,18,7],[62,28,0,12,10],[48,34,22,0,9],[72,21,0,24,8],[64,28,18,22,9]];
  const dayNames = ['Fri','Sat','Sun','Mon','Tue','Wed','Thu'];
  const days = matrix.map((values,i) => ({id:i,label:dayNames[i],date:`Sep ${i+4}`,values,blocks:[],visits:[]}));
  let eventId = 0;
  function addBlock(day,topicIndex,start,minutes) {
    const t=topics[topicIndex], count=Math.ceil(minutes/7), visits=[];
    let elapsed=0;
    for(let i=0;i<count;i++) {
      const length=Math.floor(minutes/count)+(i<minutes%count?1:0);
      const page=t.pages[(day.id+i)%t.pages.length];
      visits.push({id:++eventId,topic:t.id,day:day.id,start:start+elapsed,minutes:length,page});
      elapsed+=length;
    }
    const block={id:`d${day.id}-${day.blocks.length}`,day:day.id,topic:t.id,start,minutes,visits};
    day.blocks.push(block); day.visits.push(...visits);
  }
  days.forEach((day,index) => {
    if(index===6) {
      [[0,544,24],[1,612,28],[0,700,18],[2,770,18],[0,850,22],[3,930,22],[4,972,9]].forEach(x=>addBlock(day,...x));
    } else {
      let start=550;
      const order=index===4?[0,2,1,3,4]:[0,1,2,3,4];
      order.forEach(t=>{if(day.values[t]) { addBlock(day,t,start,day.values[t]); start+=day.values[t]+16; }});
    }
  });
  const visits = days.flatMap(d=>d.visits);
  const blocks = days.flatMap(d=>d.blocks);
  const sum = values => values.reduce((a,b)=>a+b,0);
  const mins = n => n>=60?`${Math.floor(n/60)}h${n%60?` ${n%60}m`:''}`:`${n}m`;
  const time = n => `${Math.floor(n/60)%12||12}:${String(n%60).padStart(2,'0')} ${n<720?'AM':'PM'}`;
  const topicMinutes = (id,day=null) => sum((day===null?visits:days[day].visits).filter(v=>v.topic===id).map(v=>v.minutes));
  const topicVisits = id => visits.filter(v=>v.topic===id);
  const distinct = list => new Set(list.map(v=>v.page[2])).size;
  const laterDays = id => new Set(topicVisits(id).map(v=>v.day)).size-1;
  const weekTotal = sum(matrix.flat());
  const today = days[6];
  const pairs=[];
  days.forEach(d=>d.blocks.forEach((b,i)=>{
    const next=d.blocks[i+1];
    if(!next||b.topic===next.topic||b.topic==='other'||next.topic==='other') return;
    const before=b.visits.at(-1), after=next.visits[0];
    if(after.start-before.start<=30) pairs.push({from:b.topic,to:next.topic,day:d.id,before,after});
  }));
  const directions = {
    still:{name:'Still',reference:'Apple',defaultChart:'timeline',note:'A quiet place to return. Spacious typography, one clear next step, and a chronological record.'},
    studio:{name:'Studio',reference:'Stripe',defaultChart:'week',note:'Dark by default. Distinct trail colors, a full interactive graph, and one consistent workspace.'},
    field:{name:'Fieldnotes',reference:'Duolingo',defaultChart:'routes',note:'Make returning feel inviting. Soft shapes, tactile controls, and a little personality.'}
  };
  const params=new URLSearchParams(location.search);
  let savedTheme='dark';
  try { savedTheme=localStorage.getItem('ct.design.studio.theme')||'dark'; } catch { /* File previews may disable storage. */ }
  const initialTheme=['light','dark'].includes(params.get('theme'))?params.get('theme'):savedTheme==='light'?'light':'dark';
  const state={concept:directions[params.get('concept')]?params.get('concept'):'studio',view:['home','explore','library','graph'].includes(params.get('view'))?params.get('view'):params.has('concept')?'home':'graph',theme:initialTheme,chart:['timeline','week','routes'].includes(params.get('chart'))?params.get('chart'):null,metric:'minutes',day:6,block:'d6-4',route:'rust',destination:'models',pinned:new Set(['rust','bread']),query:'',onlyPinned:false,notes:Object.fromEntries(topics.map(t=>[t.id,t.note]))};
  state.chart ||= directions[state.concept].defaultChart;
  const root=document.getElementById('prototype');
  const dialog=document.getElementById('detail-dialog');
  let graphController=null;
  const graphMemory={};
  const announce=message=>{document.getElementById('announcement').textContent=message;};
  const topicIcon = t => `<span class="topic-icon topic-${t.id}">${icon(t.icon)}</span>`;
  function sourceRow(v,showTime=false) {
    const page=v.page||v;
    return `<a class="page-source" href="${esc(page[2])}" target="_blank" rel="noopener noreferrer"><span class="source-letter">${esc(page[1].slice(0,1).toUpperCase())}</span><span class="source-text"><strong>${esc(page[0])}</strong><small>${esc(page[1])}${showTime?` · ${time(v.start)}`:''}</small></span>${icon('external')}</a>`;
  }
  function searchBox() { return `<label class="search-box">${icon('search')}<input type="search" aria-label="Search sample pages and trails" placeholder="Find a page or a trail…" value="${esc(state.query)}"><kbd aria-hidden="true">⌘ K</kbd></label>`; }
  function navigation(sidebar=false) {
    return `<nav class="${sidebar?'sidebar-nav':'main-nav'}" aria-label="Mockup navigation">${[['home','Home','home'],['graph','Graph','graph'],['explore','Explore','chart'],['library','Your trails','layers']].map(([view,label,i])=>`<button type="button" data-view="${view}" ${state.view===view?'aria-current="page"':''}>${sidebar?icon(i):''}${label}${sidebar&&view==='graph'?'<span class="nav-new">NEW</span>':''}</button>`).join('')}</nav>`;
  }
  function themeSwitch() {
    return `<div class="theme-switch" aria-label="Color theme"><button type="button" data-theme-choice="dark" aria-label="Dark theme" aria-pressed="${state.theme==='dark'}">${icon('moon')}<span>Dark</span></button><button type="button" data-theme-choice="light" aria-label="Light theme" aria-pressed="${state.theme==='light'}">${icon('sun')}<span>Light</span></button></div>`;
  }
  function applyTheme() {
    root.dataset.theme=state.theme;
    if(state.concept==='studio')document.body.dataset.studioTheme=state.theme;
    else delete document.body.dataset.studioTheme;
    document.querySelectorAll('[data-theme-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeChoice===state.theme)));
  }
  function header() {
    return `<header class="app-header"><a class="brand" href="?concept=${state.concept}" data-view="home">${brand}</a>${navigation()}<div class="header-right"><span class="private-label">${icon('lock')}Only on this device</span><button type="button" class="avatar" data-action="privacy" aria-label="About this local prototype">A</button></div></header>`;
  }
  function sidebar() {
    return `<aside class="sidebar"><a class="brand" href="?concept=studio" data-view="home">${brand}</a>${navigation(true)}<div class="eyebrow">Pinned trails</div>${topics.filter(t=>state.pinned.has(t.id)).map(t=>`<button type="button" class="pinned-nav topic-${t.id}" data-trail="${t.id}"><span class="topic-dot"></span>${t.short}</button>`).join('')}<div class="sidebar-bottom"><span class="private-label">${icon('lock')}Local by design</span><p>Your pages. Your device.</p><button type="button" class="text-btn" data-action="privacy">Record & privacy</button></div></aside>`;
  }
  function trailCard(t) {
    return `<article class="trail-card topic-${t.id}"><div class="trail-card-top">${topicIcon(t)}<button type="button" class="icon-btn" data-pin="${t.id}" aria-label="Pin ${t.label}" aria-pressed="${state.pinned.has(t.id)}">${icon('pin')}</button></div><button type="button" data-trail="${t.id}" style="padding:0;text-align:left;width:100%"><h3>${t.label}</h3><p>${distinct(topicVisits(t.id))} pages · returned on ${laterDays(t.id)} later days</p><span class="last-page"><span>${t.pages[0][0]}</span>${icon('arrow')}</span></button></article>`;
  }
  function recordStrip() {
    return `<div class="record-strip"><span><strong>${mins(sum(today.values))}</strong> estimated today</span><span><strong>${today.visits.length}</strong> recorded visits</span><span><strong>4</strong> trails visited</span><span class="spacer"></span><button type="button" class="text-btn" data-view="explore">See your day ${icon('arrow')}</button></div>`;
  }
  function trailArt() {
    return `<div class="trail-art" aria-hidden="true"><svg viewBox="0 0 410 220" fill="none"><ellipse cx="237" cy="112" rx="165" ry="94" fill="#e7e6f5"/><path d="M-10 172C70 169 52 73 128 86s76 117 158 76S343 37 419 43" stroke="#d6d3ee" stroke-width="32" stroke-linecap="round"/><path d="M-10 172C70 169 52 73 128 86s76 117 158 76S343 37 419 43" stroke="#f8f7fd" stroke-width="23" stroke-linecap="round"/><path d="M-10 172C70 169 52 73 128 86s76 117 158 76S343 37 419 43" stroke="#a9a0da" stroke-width="1.5" stroke-dasharray="4 7"/><circle cx="319" cy="116" r="12" fill="#7771c7" stroke="white" stroke-width="5"/></svg><div class="art-label">${icon('code')}async / await</div><div class="art-label second">${icon('bookmark')}A place to return to</div></div>`;
  }
  function stillHome() {
    return `<div class="hero-top"><div><p class="eyebrow">Thursday, September 10</p><h1>Pick up a good thread.</h1><p class="subhead">Your pages, connected. Your next step, a little closer.</p></div>${searchBox()}</div><div id="search-results" class="search-results" hidden></div><section class="resume-hero"><div class="resume-copy"><p class="eyebrow">Your saved place</p><h2>Back to Rust & async.</h2><p class="resume-note">${esc(state.notes.rust)}</p><div class="hero-actions"><button type="button" class="primary-btn" data-trail="rust">Continue this trail ${icon('arrow')}</button><span class="hero-meta">${icon('layers')}${distinct(topicVisits('rust'))} pages, together</span></div></div>${trailArt()}</section>${recordStrip()}<div class="section-head"><h2>A few familiar trails</h2><button type="button" class="text-btn" data-view="library">All trails ${icon('arrow')}</button></div><div class="trail-grid">${topics.slice(1,4).map(trailCard).join('')}</div><div class="recent-inline"><span class="eyebrow">Recently opened</span><span class="source-letter">H</span><span class="recent-title">The daily links</span><span class="meta">news.ycombinator.com · ${time(today.visits.at(-1).start)}</span><button type="button" class="text-btn" data-trail="other">View ungrouped pages ${icon('arrow')}</button></div>`;
  }
  function studioHome() {
    return `<div class="hero-top"><div><h1>Your browsing, in view.</h1><p class="subhead">A clear way back to what you were exploring.</p></div><span class="date-label">${icon('calendar')}Sep 4 – 10, 2026</span></div><div id="search-results" class="search-results" hidden></div><div class="record-strip"><div class="record-stat"><div class="stat-label">Estimated browsing time</div><div class="stat-value">${mins(weekTotal)}</div><div class="stat-note">Across the past 7 days</div></div><div class="record-stat"><div class="stat-label">Recorded visits</div><div class="stat-value">${visits.length}</div><div class="stat-note">${distinct(visits)} distinct pages</div></div><div class="record-stat"><div class="stat-label">Trails revisited</div><div class="stat-value">4</div><div class="stat-note">Visited on multiple days</div></div></div><div class="studio-layout"><div class="studio-main"><section class="studio-resume"><p class="eyebrow">Continue where you saved</p><div class="resume-heading">${topicIcon(topics[0])}<h2>Rust & async</h2></div><p class="resume-note">${esc(state.notes.rust)}</p><div class="hero-actions"><button type="button" class="primary-btn" data-trail="rust">Open trail ${icon('arrow')}</button><button type="button" class="text-btn" data-action="note" data-id="rust">Edit your note</button></div></section><div class="section-head"><h2>Your trails</h2><button type="button" class="text-btn" data-view="library">View all ${icon('arrow')}</button></div><div class="trail-table"><div class="trail-table-head"><span>Trail</span><span>Visits</span><span>Est. time</span></div>${topics.slice(0,4).map(t=>`<button type="button" class="trail-row topic-${t.id}" data-trail="${t.id}"><span class="trail-row-name"><span class="topic-dot"></span>${t.short}</span><span>${topicVisits(t.id).length}</span><span>${mins(topicMinutes(t.id))}</span></button>`).join('')}</div></div><div class="studio-side"><section class="paper mini-panel"><h2>The week at a glance</h2><div class="big-number">${mins(weekTotal)}<small>estimated</small></div><div class="mini-bars" role="img" aria-label="Estimated browsing minutes, Friday through Thursday: 82, 76, 77, 112, 113, 125, 141">${days.map(d=>`<button type="button" class="mini-bar-column" data-week-day="${d.id}" aria-label="Explore ${d.date}: ${sum(d.values)} estimated minutes"><span class="mini-bar" style="height:${sum(d.values)/160*100}%"></span></button>`).join('')}</div><div class="mini-days" aria-hidden="true">${days.map(d=>`<span>${d.label}</span>`).join('')}</div><button type="button" class="text-btn" data-chart="week" data-explore="true">Explore the breakdown ${icon('arrow')}</button></section><section class="paper mini-panel second-panel"><h2>A note for next time</h2><p class="note-preview">“${esc(state.notes.bread)}”</p><button type="button" class="text-btn" data-trail="bread">The sourdough notebook ${icon('arrow')}</button></section></div></div>`;
  }
  function fieldHome() {
    return `<div class="hero-top"><div><p class="eyebrow">A little curiosity goes a long way</p><h1>Where shall we<br>pick things up?</h1><p class="subhead">There’s a trail here with your name on it.</p></div>${searchBox()}</div><div id="search-results" class="search-results" hidden></div><div class="field-layout"><section class="field-hero"><div><p class="eyebrow">Your saved place</p><h2>A little more<br>Rust & async?</h2><p class="resume-note">Channels, shared state, and the note you left for yourself.</p><div class="hero-actions"><button type="button" class="primary-btn" data-trail="rust">Let’s pick it up ${icon('arrow')}</button></div></div><div class="waymarker" aria-hidden="true"><span class="way-shadow"></span><span class="way-stem"></span><span class="way-flag"></span><span class="way-stone"><span class="way-eye"></span><span class="way-eye second"></span><span class="way-smile"></span></span><span class="way-spark">✦</span><span class="way-spark second">✦</span></div></section><section class="field-note">${icon('note')}<h2>A note from you,<br>to future you.</h2><p>“${esc(state.notes.bread)}”</p><div class="note-topic topic-bread"><span class="topic-dot"></span>The sourdough notebook</div><button type="button" class="text-btn" data-trail="bread">Take me there ${icon('arrow')}</button></section></div><div class="section-head"><div><h2>There’s more to come back to.</h2><p>A few trails you’ve visited this week.</p></div><button type="button" class="text-btn" data-view="library">See all ${icon('arrow')}</button></div><div class="trail-grid">${topics.slice(1,4).map(trailCard).join('')}</div>${recordStrip()}`;
  }
  function library() {
    return `<div class="library-intro"><div><p class="eyebrow">Your own little library</p><h1 style="font-size:34px;letter-spacing:-1.2px;margin:8px 0">All your trails.</h1><p class="subhead">Find the page. Leave a note. Make it yours.</p></div>${searchBox()}</div><div id="search-results" class="search-results" hidden style="margin-top:20px"></div><div class="section-head"><h2>${state.onlyPinned?'Pinned trails':'This week’s trails'}</h2><button type="button" class="soft-btn" data-action="only-pinned" aria-pressed="${state.onlyPinned}">${icon('pin')}${state.onlyPinned?'Show all':'Pinned only'}</button></div><div class="trail-grid library-grid">${topics.filter(t=>(!state.onlyPinned||state.pinned.has(t.id))&&t.id!=='other').map(trailCard).join('')||'<div class="empty-state"><h2>No pinned trails yet</h2><p>Use the pin on a trail to keep it close.</p></div>'}</div><div class="section-head"><h2>Still part of your record</h2></div><button type="button" class="soft-btn" data-trail="other">${icon('layers')}${topicVisits('other').length} ungrouped visits · ${distinct(topicVisits('other'))} pages ${icon('arrow')}</button>`;
  }
  function chartHeader() {
    const titles={timeline:['Your day, unfolded.','See the pages you visited, in the order you visited them.'],week:['A week of following your curiosity.','See which trails you returned to, and open the pages behind the pattern.'],routes:['Follow a trail. See where it went.','One starting point. A few recorded connections. The pages that explain them.']};
    return `<div class="explorer-heading"><p class="eyebrow">Your trail explorer</p><h1>${titles[state.chart][0]}</h1><p class="subhead">${titles[state.chart][1]}</p></div><div id="search-results" class="search-results" hidden></div><div class="explorer-toolbar"><nav class="view-switch" aria-label="Chart alternative">${[['timeline','Your day','timeline'],['week','Your week','chart'],['routes','Connections','route']].map(([key,label,i])=>`<button type="button" data-chart="${key}" aria-pressed="${state.chart===key}">${icon(i)}${label}</button>`).join('')}</nav><span class="date-label">${icon('calendar')}${state.chart==='timeline'?'Thursday, Sep 10':'Sep 4 – 10, 2026'}</span></div>`;
  }
  function timeline() {
    const selected=blocks.find(b=>b.id===state.block)||today.blocks[4];
    const t=topicById[selected.topic];
    return `<div class="chart-layout"><section class="paper chart-paper"><div class="chart-title-row"><div><h2>The shape of your day</h2><p>Each block opens its recorded pages.</p></div><div class="chart-total"><strong>${mins(sum(today.values))}</strong><small>estimated browsing time</small></div></div><div class="insight-line">${icon('back')}Rust & async appeared in 3 separate stretches today.</div><div class="time-axis" aria-label="Time of day from 9 AM to 5 PM">${['9 AM','11 AM','1 PM','3 PM','5 PM'].map((x,i)=>`<span style="left:${i*25}%">${x}</span>`).join('')}</div><div class="timeline" aria-label="Recorded visits by trail and time">${topics.map(t=>`<div class="timeline-row topic-${t.id}"><div class="timeline-label"><span class="topic-dot"></span><span>${t.short}</span></div><div class="timeline-lane">${today.blocks.filter(b=>b.topic===t.id).map(b=>`<button type="button" class="timeline-block" data-block="${b.id}" aria-pressed="${b.id===state.block}" aria-label="${t.short}, ${time(b.start)}, ${b.minutes} estimated minutes, ${b.visits.length} visits. Open recorded pages." style="left:${(b.start-540)/480*100}%;width:${b.minutes/480*100}%">${b.minutes>=22?b.minutes:''}</button>`).join('')}</div></div>`).join('')}</div><div class="timeline-summary"><span>Time of day</span><span>Block width = estimated minutes</span></div><p class="chart-footnote">Gaps mean no recorded interval here. They don’t tell us what you were doing. Estimates describe this browsing record only.</p></section><aside class="selected-detail" aria-label="Selected timeline block">${topicIcon(t)}<h2>${t.label}</h2><p class="detail-sub">Thursday · ${time(selected.start)} – ${time(selected.start+selected.minutes)}</p><div class="detail-totals"><span><strong>${selected.minutes}m</strong><small>estimated time</small></span><span><strong>${selected.visits.length}</strong><small>recorded visits</small></span></div><p class="eyebrow">Pages in this stretch</p><div>${selected.visits.map(v=>sourceRow(v,true)).join('')}</div><button type="button" class="primary-btn" data-trail="${t.id}">Open ${t.id==='other'?'pages':'this trail'} ${icon('arrow')}</button><button type="button" class="text-btn" data-action="evidence">How time is estimated</button></aside></div>`;
  }
  function weekChart() {
    const selected=days[state.day], isMinutes=state.metric==='minutes';
    const values=days.map(d=>topics.map((t,i)=>isMinutes?d.values[i]:d.visits.filter(v=>v.topic===t.id).length));
    const step=isMinutes?40:10;
    const maximum=Math.ceil(Math.max(...values.map(sum))/step)*step;
    const selectedValues=values[state.day];
    const total=sum(selectedValues);
    const maxTopic=Math.max(...selectedValues);
    return `<div class="chart-layout"><section class="paper chart-paper"><div class="chart-title-row"><div><h2>What you returned to</h2><p>${isMinutes?'Estimated minutes':'Recorded visits'} by trail · select a day to inspect it</p></div><div class="chart-total"><strong>${isMinutes?mins(weekTotal):visits.length}</strong><small>${isMinutes?'estimated this week':'recorded visits this week'}</small></div></div><div class="metric-switch" aria-label="Chart measure"><button type="button" data-metric="minutes" aria-pressed="${isMinutes}">Estimated time</button><button type="button" data-metric="visits" aria-pressed="${!isMinutes}">Visits</button></div><div class="week-plot" role="group" aria-label="${isMinutes?'Estimated minutes':'Recorded visits'} by day, September 4 to 10"><div class="week-grid" aria-hidden="true">${Array.from({length:maximum/step+1},(_,i)=>`<div class="gridline" style="bottom:${i*step/maximum*100}%"><span>${i*step}</span></div>`).join('')}</div><div class="week-columns">${days.map((d,i)=>`<button type="button" class="week-column" data-day="${i}" aria-pressed="${state.day===i}" aria-label="${d.label}, ${d.date}: ${sum(values[i])} ${isMinutes?'estimated minutes':'recorded visits'}. ${values[i].map((v,j)=>`${topics[j].short} ${v}`).join(', ')}"><span class="bar-total" aria-hidden="true">${sum(values[i])}</span><span class="bar-stack" style="height:calc((100% - 31px) * ${sum(values[i])/maximum})">${topics.map((t,j)=>values[i][j]?`<span class="bar-segment topic-${t.id}" style="height:${values[i][j]/sum(values[i])*100}%"></span>`:'').join('')}</span><span class="bar-day">${d.label} ${i+4}</span></button>`).join('')}</div></div><div class="chart-legend">${topics.map(t=>`<span class="topic-${t.id}"><i class="topic-dot"></i>${t.short}</span>`).join('')}</div><div class="insight-line" style="margin-top:23px;margin-bottom:0">${icon('back')}You visited Rust & async on 6 of these 7 days.</div><p class="chart-footnote">${isMinutes?'Minutes are estimates, not a measure of attention.':'Each visit is a recorded page opening. Repeated visits are counted separately.'} Ungrouped pages stay visible in every total.</p></section><aside class="selected-detail week-detail" aria-label="Selected day breakdown"><p class="eyebrow">Selected day</p><h2>${selected.label === 'Thu'?'Thursday':selected.label === 'Wed'?'Wednesday':selected.label === 'Tue'?'Tuesday':selected.label === 'Mon'?'Monday':selected.label === 'Sun'?'Sunday':selected.label === 'Sat'?'Saturday':'Friday'}, ${selected.date}</h2><div class="detail-totals"><span><strong>${isMinutes?mins(total):total}</strong><small>${isMinutes?'estimated time':'recorded visits'}</small></span><span><strong>${distinct(selected.visits)}</strong><small>distinct pages</small></span></div><p class="eyebrow">${isMinutes?'Estimated time':'Visits'} by trail</p><div class="breakdown">${topics.map((t,i)=>`<div class="breakdown-line topic-${t.id}"><span>${t.short}</span><span class="breakdown-track"><span style="width:${selectedValues[i]/maxTopic*100}%"></span></span><strong>${selectedValues[i]}${isMinutes?'m':''}</strong></div>`).join('')}</div><p class="eyebrow" style="margin-top:23px">A page to return to</p><div>${sourceRow(selected.visits.find(v=>v.topic==='rust')||selected.visits[0])}</div><button type="button" class="primary-btn" data-action="day-pages">View ${selected.visits.length} visits ${icon('arrow')}</button><button type="button" class="text-btn" data-action="evidence">About this record</button></aside></div>`;
  }
  function destinations(origin) {
    return topics.map(t=>({topic:t,sequences:pairs.filter(p=>p.from===origin&&p.to===t.id)})).filter(r=>r.sequences.length>=2).sort((a,b)=>b.sequences.length-a.sequences.length);
  }
  function routesChart() {
    const origin=topicById[state.route], routes=destinations(state.route);
    if(!routes.some(r=>r.topic.id===state.destination)) state.destination=routes[0]?.topic.id||null;
    const selected=routes.find(r=>r.topic.id===state.destination);
    const lines=routes.length===1?[129]:routes.map((r,i)=>50+i*158/(routes.length-1));
    return `<div class="chart-layout"><section class="paper chart-paper"><div class="chart-title-row"><div><h2>Where did this trail lead?</h2><p>Recorded sequences, one trail at a time.</p></div><span class="pill">${routes.length} connection${routes.length===1?'':'s'}</span></div><label class="route-select">Start with<select aria-label="Starting trail" id="route-origin">${topics.filter(t=>t.id!=='other').map(t=>`<option value="${t.id}" ${state.route===t.id?'selected':''}>${t.label}</option>`).join('')}</select></label>${routes.length?`<div class="route-map"><div class="route-origin">${topicIcon(origin)}<h3>${origin.label}</h3><p>${topicVisits(origin.id).length} visits · ${mins(topicMinutes(origin.id))} est.</p><button type="button" class="text-btn" data-trail="${origin.id}" style="font-size:10px;margin-top:14px">Open trail ${icon('arrow')}</button></div><div class="route-connectors" aria-hidden="true"><svg viewBox="0 0 85 258" preserveAspectRatio="none">${lines.map((y,i)=>`<path d="M0 129H22C49 129 38 ${y} 66 ${y}H83" stroke="${routes[i].topic.id===state.destination?'#b4a9d6':'#dbe0e3'}" stroke-width="2" fill="none"/><path d="M78 ${y-4}l5 4-5 4" stroke="${routes[i].topic.id===state.destination?'#b4a9d6':'#dbe0e3'}" stroke-width="2" fill="none"/>`).join('')}</svg></div><div class="route-destinations">${routes.map(r=>`<button type="button" class="route-node" data-destination="${r.topic.id}" aria-pressed="${state.destination===r.topic.id}">${topicIcon(r.topic)}<span class="node-copy"><strong>${r.topic.short}</strong><small>${r.sequences.length} recorded sequences</small></span>${icon('arrow')}</button>`).join('')}</div></div><p class="route-map-note">Start with a trail. Choose a connection. See the visits.</p>`:'<div class="empty-state"><h2>No repeated connections here yet.</h2><p>This trail has no outgoing connection with two recorded sequences this week. Its pages are still available.</p><button type="button" class="text-btn" data-trail="'+origin.id+'">Open this trail '+icon('arrow')+'</button></div>'}<p class="chart-footnote">Lines mean consecutive recorded visits, not a relationship between ideas. Only connections with at least 2 sequences appear; individual visits remain in Your day and Your week.</p></section><aside class="selected-detail route-detail" aria-label="Connection evidence">${selected?`<p class="eyebrow">Behind this connection</p><h2>${origin.short}<br><span style="font-weight:400;color:var(--muted)">to</span> ${selected.topic.short}</h2><p class="detail-sub">${selected.sequences.length} recorded sequences · this week</p><div class="route-evidence">${selected.sequences.map(p=>`<div class="sequence-pair"><div class="sequence-time">${days[p.day].date} · ${time(p.before.start)} → ${time(p.after.start)}</div><p>${esc(p.before.page[0])}</p><p class="sequence-arrow">↓ followed by</p><p>${esc(p.after.page[0])}</p></div>`).join('')}</div><button type="button" class="primary-btn" data-action="connection-pages">Inspect these visits ${icon('arrow')}</button><button type="button" class="text-btn" data-trail="${selected.topic.id}">Open ${selected.topic.short} ${icon('arrow')}</button>`:'<p class="eyebrow">A trail of its own</p><h2>Every page still counts.</h2><p class="detail-sub">Choose another starting trail to explore a repeated sequence.</p>'}</aside></div>`;
  }
  function explorer() { return chartHeader()+(state.chart==='timeline'?timeline():state.chart==='week'?weekChart():routesChart()); }
  function updateUrl() {
    const query=new URLSearchParams({concept:state.concept,view:state.view});
    if(state.concept==='studio')query.set('theme',state.theme);
    if(state.view==='explore') query.set('chart',state.chart);
    history.replaceState(null,'',`${location.pathname}?${query}`);
  }
  function render() {
    const remembered=document.activeElement?.dataset;
    graphController?.destroy();graphController=null;
    root.className=`prototype ${state.concept}${state.view==='graph'?' graph-mode':''}`;
    applyTheme();
    const body=state.view==='home'?(state.concept==='studio'?studioHome():state.concept==='field'?fieldHome():stillHome()):state.view==='library'?library():state.view==='graph'?CTStudioGraph.screen({icon}):explorer();
    root.innerHTML=state.concept==='studio'?`${sidebar()}<div class="app-work"><header class="studio-topbar"><div class="breadcrumb">Workspace <span>/ &nbsp; ${state.view==='home'?'Overview':state.view==='library'?'Your trails':state.view==='graph'?'Graph':'Explore'}</span></div>${searchBox()}<div class="topbar-right">${themeSwitch()}<button type="button" class="avatar" data-action="privacy" aria-label="About this local prototype">A</button></div></header><main class="content" id="main">${body}</main></div>`:`${header()}<main class="content" id="main">${body}</main>`;
    document.querySelectorAll('[data-concept]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.concept===state.concept)));
    document.getElementById('direction-note').innerHTML=`<strong>${directions[state.concept].name} / ${directions[state.concept].reference}-inspired</strong>${directions[state.concept].note}`;
    updateUrl();
    alignConnections();
    if(state.view==='graph')graphController=CTStudioGraph.mount(root,{topics,visits,pairs,days,icon,esc,mins,time,notes:state.notes,announce,openDialog,sourceRow,memory:graphMemory});
    if(state.query) renderSearch();
    if(remembered) {
      for(const key of ['block','day','metric','destination','chart','view','pin']) {
        if(remembered[key]) { const el=[...root.querySelectorAll(`[data-${key}]`)].find(e=>e.dataset[key]===remembered[key]);el?.focus({preventScroll:true});break; }
      }
    }
  }
  function alignConnections() {
    const connector=root.querySelector('.route-connectors');
    if(!connector) return;
    const rect=connector.getBoundingClientRect();
    const origin=root.querySelector('.route-origin').getBoundingClientRect();
    const from=origin.top+origin.height/2-rect.top;
    const svg=connector.querySelector('svg');
    svg.setAttribute('viewBox',`0 0 85 ${rect.height}`);
    svg.innerHTML=[...root.querySelectorAll('.route-node')].map(node=>{
      const box=node.getBoundingClientRect();
      const y=box.top+box.height/2-rect.top;
      const color=node.getAttribute('aria-pressed')==='true'?'#b4a9d6':'#dbe0e3';
      return `<path d="M0 ${from}H22C49 ${from} 38 ${y} 66 ${y}H83" stroke="${color}" stroke-width="2" fill="none"/><path d="M78 ${y-4}l5 4-5 4" stroke="${color}" stroke-width="2" fill="none"/>`;
    }).join('');
  }
  function renderSearch() {
    if(state.view==='graph'){graphController?.search(state.query);return;}
    const result=document.getElementById('search-results');
    if(!result) return;
    const q=state.query.trim().toLowerCase();
    result.hidden=!q;
    if(!q) return;
    const matched=topics.filter(t=>[t.label,t.short,state.notes[t.id],...t.pages.flat()].join(' ').toLowerCase().includes(q));
    result.innerHTML=`<h2>${matched.length?`${matched.length} trail${matched.length===1?'':'s'} with a match`:'No matches in the sample record'}</h2>${matched.map(t=>`<button type="button" class="page-source" data-trail="${t.id}">${topicIcon(t)}<span class="source-text"><strong>${t.label}</strong><small>${t.pages.length} pages · ${esc(state.notes[t.id]||'No note yet')}</small></span>${icon('arrow')}</button>`).join('')||'<p class="meta">Try “Rust”, “bread”, “running”, or a website name.</p>'}`;
  }
  function openDialog(title,contents,eyebrow='Sample record') {
    document.getElementById('dialog-content').innerHTML=`<div class="dialog-top"><div><p class="eyebrow">${eyebrow}</p><h2 id="dialog-title">${title}</h2></div><button type="button" class="icon-btn" data-action="close" aria-label="Close dialog">${icon('close')}</button></div>${contents}`;
    if(!dialog.open) dialog.showModal();
  }
  function openTrail(id,focusNote=false) {
    const t=topicById[id],list=topicVisits(id);
    openDialog(t.label,`<p class="dialog-intro">Your recorded pages, together with your own next step.</p><div class="dialog-summary"><span>${list.length} visits</span><span>${distinct(list)} distinct pages</span><span>${mins(topicMinutes(id))} estimated</span></div>${t.pages.map(p=>sourceRow(p)).join('')}${id!=='other'?`<label class="note-field">Your note for next time<textarea id="trail-note" data-note-id="${id}" placeholder="Where would you like to pick this up?">${esc(state.notes[id])}</textarea></label><div class="dialog-actions"><button type="button" class="primary-btn" data-action="save-note" data-id="${id}">Save note ${icon('check')}</button><button type="button" class="soft-btn" data-dialog-pin="${id}" aria-pressed="${state.pinned.has(id)}">${icon('pin')}${state.pinned.has(id)?'Pinned':'Pin trail'}</button><span class="meta">Changes last until you reload this prototype.</span></div>`:'<p class="dialog-intro" style="margin-top:18px">These pages are still searchable and included in totals, even without a suggested topic.</p>'}`);
    if(focusNote) document.getElementById('trail-note').focus();
  }
  function rationale() {
    if(state.concept==='studio'){
      openDialog('Studio, after dark.',`<p class="dialog-intro">A darker, more deliberate Studio direction with the complete topic and page graph as a first-class view. The light theme uses the same layout and trail identities.</p><div class="rationale-row"><h3>High contrast, with restraint</h3><p>Near-black canvas, crisp light text, and clear surface boundaries. Violet, cyan, amber, and mint identify trails consistently across nodes, charts, and navigation.</p></div><div class="rationale-row"><h3>The full graph stays</h3><p>All 4 sample trails and 17 page nodes are present, including ungrouped pages. Membership lines stay separate from arrowed recorded sequences. Select a topic, page, or connection to inspect its evidence.</p></div><div class="rationale-row"><h3>Fluid, without constant motion</h3><p>Drag a topic with its pages, rearrange individual pages, pan, zoom, and fit the graph. Labels reveal more detail as you move closer. Focus emphasizes the selected neighborhood while retaining the wider graph.</p></div><div class="rationale-row"><h3>Your theme, throughout the workspace</h3><p>The toggle also updates Home, Explore, Your trails, and dialogs. The theme preference is remembered on this device. Sample notes, pins, and graph arrangements reset on reload.</p></div>`,'STUDIO / DESIGN REFINEMENT');return;
    }
    openDialog('Less decoding. More returning.',`<p class="dialog-intro">Three design directions, each with a home screen and three working explorer views. Everything here uses an illustrative sample record.</p><div class="rationale-row"><h3>01 / Still</h3><p>A recommendation for the core experience: one saved place, a short note, and a direct return to your pages. Inspired by <a href="https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/" target="_blank" rel="noopener noreferrer">Apple’s emphasis on content and a separate navigation layer</a>.</p></div><div class="rationale-row"><h3>02 / Studio</h3><p>A compact workspace for people who want more of their record on screen. The weekly chart opens its underlying visits, borrowing <a href="https://docs.stripe.com/payments/analytics" target="_blank" rel="noopener noreferrer">Stripe’s pattern of overview, filters, and specific reports</a>.</p></div><div class="rationale-row"><h3>03 / Fieldnotes</h3><p>Friendlier language, tactile buttons, and an original little waymarker. Inspired by <a href="https://blog.duolingo.com/core-tabs-redesign/" target="_blank" rel="noopener noreferrer">Duolingo’s work on consistent hierarchy, spacing, and purposeful personality</a>. No scores, streak pressure, or claims about learning.</p></div><div class="rationale-row"><h3>The chart rethink</h3><p><strong>Your day</strong> answers “what was I looking at?” <strong>Your week</strong> answers “what did I return to?” <strong>Connections</strong> answers “what pages explain this link?” Every view leads back to sources, with ungrouped visits retained.</p></div><p class="dialog-intro">Recommended combination: Still’s home, Studio’s weekly breakdown, and the chronological explorer as the default. Connections stays a secondary view.</p>`,'Design notes');
  }
  document.addEventListener('click',event=>{
    const b=event.target.closest('button,a[data-view]');
    if(!b) return;
    const d=b.dataset;
    if(d.themeChoice){state.theme=d.themeChoice;try{localStorage.setItem('ct.design.studio.theme',state.theme);}catch{}applyTheme();updateUrl();announce(`${state.theme==='dark'?'Dark':'Light'} theme selected.`);return;}
    if(d.concept) {
      state.concept=d.concept;state.chart=directions[state.concept].defaultChart;render();announce(`${directions[state.concept].name} design selected.`);return;
    }
    if(d.view) {event.preventDefault();state.view=d.view;state.query='';render();return;}
    if(d.chart) {state.chart=d.chart;if(d.explore) state.view='explore';render();announce(`${b.textContent.trim()} view selected.`);return;}
    if(d.trail) {openTrail(d.trail);return;}
    if(d.pin) {state.pinned.has(d.pin)?state.pinned.delete(d.pin):state.pinned.add(d.pin);render();announce(`${topicById[d.pin].label} ${state.pinned.has(d.pin)?'pinned':'unpinned'}.`);return;}
    if(d.dialogPin) {state.pinned.has(d.dialogPin)?state.pinned.delete(d.dialogPin):state.pinned.add(d.dialogPin);b.setAttribute('aria-pressed',String(state.pinned.has(d.dialogPin)));b.innerHTML=icon('pin')+(state.pinned.has(d.dialogPin)?'Pinned':'Pin trail');render();return;}
    if(d.block) {state.block=d.block;render();const s=blocks.find(x=>x.id===d.block);announce(`${topicById[s.topic].label}, ${time(s.start)}, ${s.minutes} estimated minutes. Pages are shown beside the timeline.`);return;}
    if(d.weekDay!==undefined) {state.day=Number(d.weekDay);state.chart='week';state.view='explore';render();return;}
    if(d.day!==undefined) {state.day=Number(d.day);render();announce(`${days[state.day].date} selected. Breakdown updated.`);return;}
    if(d.metric) {state.metric=d.metric;render();announce(`Showing ${d.metric==='minutes'?'estimated time':'recorded visits'}.`);return;}
    if(d.destination) {state.destination=d.destination;render();announce(`Showing visits from ${topicById[state.route].short} to ${topicById[state.destination].short}.`);return;}
    if(d.action==='close') {dialog.close();return;}
    if(d.action==='rationale') {rationale();return;}
    if(d.action==='only-pinned') {state.onlyPinned=!state.onlyPinned;render();return;}
    if(d.action==='note') {openTrail(d.id,true);return;}
    if(d.action==='save-note') {state.notes[d.id]=document.getElementById('trail-note').value;dialog.close();render();announce('Note saved for this prototype session.');return;}
    if(d.action==='day-pages') {const day=days[state.day];openDialog(`${day.label}, ${day.date}`,`<p class="dialog-intro">${day.visits.length} recorded visits · ${mins(sum(day.values))} estimated · illustrative sample data.</p>${day.visits.map(v=>sourceRow(v,true)).join('')}`);return;}
    if(d.action==='connection-pages') {const seq=pairs.filter(p=>p.from===state.route&&p.to===state.destination);openDialog('The visits behind this connection',`<p class="dialog-intro">${seq.length} consecutive recorded sequences. Each pair occurred within 30 minutes. Sequence does not imply a relationship between the subjects.</p>${seq.map(p=>`<div class="rationale-row"><p class="eyebrow">${days[p.day].date}</p>${sourceRow(p.before,true)}${sourceRow(p.after,true)}</div>`).join('')}`);return;}
    if(d.action==='evidence') {openDialog('A record, with its limits.',`<div class="rationale-row"><h3>What the numbers show</h3><p>Visits count recorded page openings. A trail groups pages by suggested topic. Estimated time is approximate, and is not a measure of attention, productivity, or learning.</p></div><div class="rationale-row"><h3>What the chart leaves open</h3><p>A gap can mean another app, a different device, private browsing, a pause, or no capture. It does not establish inactivity. Ungrouped pages remain included in all totals.</p></div><div class="rationale-row"><h3>In this prototype</h3><p>Visits, dates, durations, and notes are illustrative. Every summary and chart is derived from the same in-memory sample; this is not your actual history. A real implementation would read the existing evidence calculation.</p></div>`);return;}
    if(d.action==='privacy') {openDialog('Your record stays yours.',`<p class="dialog-intro">This design prototype has no access to your browser history or extension database. The sample lives in memory. Notes and pins reset on reload.</p><div class="rationale-row"><h3>The product principle</h3><p>Keep search and records on this device. Use local grouping, and let the person correct topics or leave their own note. Browsing evidence is never a score for cognition, productivity, or learning.</p></div>`);}
  });
  document.addEventListener('input',event=>{
    if(event.target.matches('input[type="search"]')) {state.query=event.target.value;renderSearch();}
  });
  document.addEventListener('change',event=>{
    if(event.target.id==='route-origin') {state.route=event.target.value;render();document.getElementById('route-origin')?.focus({preventScroll:true});announce(`${topicById[state.route].label} selected as the starting trail.`);}
  });
  document.addEventListener('keydown',event=>{
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k') {
      if(dialog.open) return;
      event.preventDefault();
      let search=root.querySelector('input[type="search"]');
      if(!search) {state.view='library';render();search=root.querySelector('input[type="search"]');}
      search.focus();
    }
  });
  dialog.addEventListener('click',event=>{if(event.target===dialog) {const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) dialog.close();}});
  window.addEventListener('resize',alignConnections);
  render();
})();
