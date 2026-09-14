(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTStudio = api;
  if (typeof document !== 'undefined') api.boot(document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10h-6v-7H9v7H3Z"/>',
    graph: '<circle cx="7" cy="7" r="3"/><circle cx="18" cy="5" r="2"/><circle cx="17" cy="18" r="3"/><circle cx="4" cy="19" r="2"/><path d="m10 7 6-2M9 9l6 7M6 10 4 17m2 2 8-1"/>',
    chart: '<path d="M4 4v16h17M8 15v-4m5 4V7m5 8V3"/>',
    layers: '<path d="m3 7 9-4 9 4-9 4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-2Z"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    enter: '<path d="M19 5v9H5m5-5-5 5 5 5"/>'
  };
  function icon(doc, name) {
    const span = doc.createElement('span'); span.className = 'studio-icon'; span.setAttribute('aria-hidden','true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.layers}</svg>`; return span;
  }
  function topicIndex(id) { let hash = 0; for (const char of String(id)) hash = (Math.imul(hash,31) + char.charCodeAt(0)) | 0; return (hash >>> 0) % 8; }
  function topicColor(id) { return `var(--trail-${topicIndex(id)})`; }
  function send(win, message) { return new Promise((resolve,reject) => win.chrome.runtime.sendMessage(message, reply => { const error=win.chrome.runtime.lastError; if(error || !reply?.ok) reject(new Error(error?.message || reply?.error || 'Preference unavailable')); else resolve(reply); })); }
  function apply(doc, value) {
    const theme=value === 'light' ? 'light' : 'dark'; doc.documentElement.dataset.theme=theme;
    doc.querySelectorAll('[data-studio-theme]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.studioTheme===theme)));
    doc.querySelectorAll('[data-studio-theme-toggle]').forEach(b=>{
      const next=theme==='dark'?'Light':'Dark';
      b.setAttribute('aria-label',`${next} theme`);b.dataset.tooltip=`${next} theme`;
      b.replaceChildren(icon(doc,theme==='dark'?'sun':'moon'));
    });
    try { doc.defaultView.localStorage.setItem('ct.studio.theme',theme); } catch { /* Cache is optional. */ }
  }
  function boot(doc) {
    if(doc.documentElement.dataset.studioBoot) return;
    doc.documentElement.dataset.studioBoot='true';
    const win=doc.defaultView; let saved='dark'; try {saved=win.localStorage.getItem('ct.studio.theme')||'dark';}catch{}
    apply(doc,saved);
    if(win.chrome?.runtime?.id) {
      send(win,{type:'GET_UI_THEME'}).then(r=>apply(doc,r.theme)).catch(()=>{});
      win.chrome.storage?.onChanged?.addListener((changes, area)=>{if(area==='local'&&changes.ctUiTheme)apply(doc,changes.ctUiTheme.newValue);});
    }
    win.addEventListener('storage',e=>{if(e.key==='ct.studio.theme')apply(doc,e.newValue);});
    doc.addEventListener('DOMContentLoaded',()=>{
      const host=doc.querySelector('[data-studio-view]');
      if(host) mount(host,{view:host.dataset.studioView,demo:new URLSearchParams(win.location.search).get('demo')==='1'});
    },{once:true});
  }
  function mount(host, options={}) {
    const doc=host.ownerDocument, win=doc.defaultView; boot(doc);
    if(host.classList.contains('studio-shell'))return;
    const view=options.view||'home', demo=!!options.demo;
    const links={home:demo?'demo.html':'newtab.html',map:demo?'map.html?demo=1':'map.html',explore:demo?'explore.html?demo=1':'explore.html',settings:demo?'demo.html?view=setup':'options.html',audit:demo?'demo.html?view=audit':'audit.html',...(options.links||{})};
    const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
    const children=[...host.childNodes];host.classList.add('studio-shell');host.dataset.studioPage=view;
    const side=el('aside','studio-sidebar'),brand=el('a','studio-brand');brand.href=links.home;
    brand.setAttribute('aria-label','Cognitive Trails');brand.dataset.tooltip=demo?'Cognitive Trails · Sample record':'Cognitive Trails';
    const mark=el('span','studio-mark','⌁');mark.setAttribute('aria-hidden','true');brand.prepend(mark);side.append(brand);
    const nav=el('nav','studio-nav');nav.setAttribute('aria-label','Workspace');
    for(const [key,label,glyph,href] of [['home','Home','home',links.home],['trails','Your trails','layers',`${links.home}${links.home.includes('?')?'&':'?'}view=trails`],['graph','Graph','graph',links.map],['explore','Explore','chart',links.explore]]) {
      const a=el('a');a.href=href;a.setAttribute('aria-label',label);a.dataset.tooltip=label;a.append(icon(doc,glyph));if(key===view)a.setAttribute('aria-current','page');nav.append(a);
    }
    side.append(nav);
    const bottom=el('nav','studio-sidebar-bottom');bottom.setAttribute('aria-label','Preferences');
    for(const [key,label,glyph,href] of [['settings','Settings','settings',links.settings],['audit','Record & privacy','lock',links.audit]]) {
      const a=el('a');a.href=href;a.setAttribute('aria-label',label);a.dataset.tooltip=label;a.append(icon(doc,glyph));if(key===view)a.setAttribute('aria-current','page');bottom.append(a);
    }
    const work=el('div','studio-work'),bar=el('div','studio-topbar'),crumb=el('div','studio-breadcrumb','Workspace / ');crumb.append(el('strong',null,({home:'Overview',graph:'Graph',explore:'Explore',trails:'Your trails',settings:'Settings',audit:'Record & privacy',diagnostics:'Page evidence'})[view]||'Record'));
    const status=el('span','studio-theme-status');status.setAttribute('aria-live','polite');
    const toggle=el('button');toggle.type='button';toggle.dataset.studioThemeToggle='';
    toggle.addEventListener('click',async()=>{
      const previous=doc.documentElement.dataset.theme,theme=previous==='dark'?'light':'dark';toggle.disabled=true;apply(doc,theme);
      try {if(win.chrome?.runtime?.id)await send(win,{type:'SET_UI_THEME',theme});status.textContent='';}
      catch{apply(doc,previous);status.textContent='Theme could not be saved. Try again.';}finally{toggle.disabled=false;}
    });
    bottom.append(toggle);side.append(bottom);
    bar.append(crumb,status);const body=el('div','studio-body');body.append(...children);work.append(bar,body);host.append(side,work);
    const search=body.querySelector('.nt-search');if(search)search.classList.add('studio-search');
    apply(doc,doc.documentElement.dataset.theme);
    return {body};
  }
  return {boot,mount,apply,topicIndex,topicColor,icon};
});
