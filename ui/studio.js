(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTStudio = api;
  if (typeof document !== 'undefined') api.boot(document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const pageBoots=new Map(),scriptLoads=new Map();
  let navigationQueue=Promise.resolve();
  function onPage(file,run) {
    pageBoots.set(file,run);
    if(typeof document!=='undefined'&&document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{if(location.pathname.endsWith('/'+file))run();},{once:true});
  }
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10h-6v-7H9v7H3Z"/>',
    graph: '<circle cx="7" cy="7" r="3"/><circle cx="18" cy="5" r="2"/><circle cx="17" cy="18" r="3"/><circle cx="4" cy="19" r="2"/><path d="m10 7 6-2M9 9l6 7M6 10 4 17m2 2 8-1"/>',
    chart: '<path d="M4 4v16h17M8 15v-4m5 4V7m5 8V3"/>',
    layers: '<path d="m3 7 9-4 9 4-9 4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
    settings: '<path d="M4 7h7m6 0h3M4 17h3m6 0h7"/><circle cx="14" cy="7" r="3"/><circle cx="10" cy="17" r="3"/>',
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
    const win=doc.defaultView; setupNavigation(doc); let saved='dark'; try {saved=win.localStorage.getItem('ct.studio.theme')||'dark';}catch{}
    apply(doc,saved);
    if(win.chrome?.runtime?.id) {
      const revision=doc.documentElement.dataset.themeRevision;
      send(win,{type:'GET_UI_THEME'}).then(r=>{if(revision===doc.documentElement.dataset.themeRevision)apply(doc,r.theme);}).catch(()=>{});
      win.chrome.storage?.onChanged?.addListener((changes, area)=>{if(area==='local'&&changes.ctUiTheme)apply(doc,changes.ctUiTheme.newValue);});
    }
    win.addEventListener('storage',e=>{if(e.key==='ct.studio.theme')apply(doc,e.newValue);});
    doc.addEventListener('DOMContentLoaded',()=>{
      const host=doc.querySelector('[data-studio-view]');
      if(host) mount(host,{view:host.dataset.studioView,demo:new URLSearchParams(win.location.search).get('demo')==='1'});
    },{once:true});
  }
  async function navigate(doc, href, push=true) {
    const win=doc.defaultView,url=new URL(href,win.location.href),file=url.pathname.split('/').pop();
    const response=await win.fetch(url.href);if(!response.ok)throw new Error('Page unavailable');
    const next=new win.DOMParser().parseFromString(await response.text(),'text/html');
    for(const script of doc.scripts)if(script.src&&!scriptLoads.has(script.src))scriptLoads.set(script.src,Promise.resolve());
    for(const source of next.querySelectorAll('script[src]')) {
      const src=new URL(source.getAttribute('src'),url).href;
      if([...doc.scripts].some(s=>s.src===src))continue;
      if(!scriptLoads.has(src))scriptLoads.set(src,new Promise((resolve,reject)=>{const script=doc.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;doc.head.append(script);}));
      await scriptLoads.get(src);
    }
    const styles=[...next.querySelectorAll('link[rel="stylesheet"]')].map(n=>new URL(n.getAttribute('href'),url).href);
    const oldStyles=[...doc.querySelectorAll('link[rel="stylesheet"]')].filter(n=>!styles.includes(n.href));
    for(const href of styles)if(![...doc.querySelectorAll('link[rel="stylesheet"]')].some(n=>n.href===href)) {
      // Page stylesheets follow studio.css, whose tokens they build on.
      await new Promise((resolve,reject)=>{const link=doc.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=reject;doc.head.append(link);});
    }
    const update=async()=>{
      win.CTPageDispose?.();win.CTPageDispose=null;
      if(push)win.history.pushState({ctNavigation:true},'',url.href);
      doc.title=next.title;oldStyles.forEach(n=>n.remove());
      next.body.querySelectorAll('script').forEach(n=>n.remove());
      doc.body.replaceChildren(...[...next.body.childNodes].map(n=>doc.importNode(n,true)));
      const host=doc.querySelector('[data-studio-view]');
      if(host)mount(host,{view:host.dataset.studioView,demo:url.searchParams.get('demo')==='1'});
      await pageBoots.get(file)?.();
      win.scrollTo(0,0);
    };
    if(doc.startViewTransition&&!win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const transition=doc.startViewTransition(update);win.ctLastNavigationTransition=transition;
      // Animation failure must not undo a completed navigation.
      transition.ready.catch(()=>{});await transition.updateCallbackDone;
    } else await update();
  }

  function setupNavigation(doc) {
    const win=doc.defaultView;
    const go=(url,push)=>{navigationQueue=navigationQueue.catch(()=>{}).then(()=>navigate(doc,url,push)).catch(()=>win.location.assign(url));};
    doc.addEventListener('click',event=>{
      const a=event.target.closest?.('a[href]');
      if(!a||event.defaultPrevented||event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||a.target==='_blank'||a.hasAttribute('download'))return;
      const url=new URL(a.href,win.location.href);
      if(url.origin!==win.location.origin||!/(?:newtab|demo|map|explore|options|audit|diagnostics)\.html$/.test(url.pathname)||url.hash)return;
      if(url.href===win.location.href){event.preventDefault();doc.querySelector('input[type="search"]')?.focus();return;}
      event.preventDefault();go(url.href,true);
    });
    win.addEventListener('popstate',()=>go(win.location.href,false));
  }

  function mount(host, options={}) {
    const doc=host.ownerDocument, win=doc.defaultView; boot(doc);
    if(host.classList.contains('studio-shell'))return;
    const view=options.view||'home', demo=!!options.demo;
    const links={home:demo?'demo.html':'newtab.html',map:demo?'map.html?demo=1':'map.html',explore:demo?'explore.html?demo=1':'explore.html',settings:demo?'demo.html?view=setup':'options.html',audit:demo?'demo.html?view=audit':'audit.html',...(options.links||{})};
    const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
    const children=[...host.childNodes];host.classList.add('studio-shell');host.dataset.studioPage=view;
    const side=el('aside','studio-sidebar'),brand=el('button','studio-brand');brand.type='button';
    brand.setAttribute('aria-label','Focus search');brand.dataset.tooltip='Search · /';brand.append(icon(doc,'search'));
    brand.addEventListener('click',()=>{
      const search=doc.querySelector('input[type="search"]');
      if(search){search.focus({preventScroll:true});search.select();}else navigate(doc,links.home).catch(()=>win.location.assign(links.home));
    });
    const hover=el('span','studio-hover-pill');hover.setAttribute('aria-hidden','true');side.append(hover,brand);
    const follow=target=>{
      if(!target)return;const r=target.getBoundingClientRect(),s=side.getBoundingClientRect();
      hover.style.width=`${r.width}px`;hover.style.height=`${r.height}px`;
      hover.style.transform=`translate(${r.left-s.left-1}px,${r.top-s.top-1}px)`;hover.style.opacity='1';
    };
    side.addEventListener('pointerover',event=>follow(event.target.closest('a,button')));
    side.addEventListener('focusin',event=>follow(event.target.closest('a,button')));
    side.addEventListener('pointerleave',()=>{hover.style.opacity='0';});
    side.addEventListener('focusout',event=>{if(!side.contains(event.relatedTarget))hover.style.opacity='0';});
    side.addEventListener('click',event=>{
      const link=event.target.closest('a');
      if(link && new URL(link.href).href===win.location.href && !event.metaKey && !event.ctrlKey){event.preventDefault();doc.querySelector('input[type="search"]')?.focus();}
    });
    const nav=el('nav','studio-nav');nav.setAttribute('aria-label','Workspace');
    for(const [key,label,glyph,href] of [['home','Home','home',links.home],['trails','Your trails','layers',`${links.home}${links.home.includes('?')?'&':'?'}view=trails`],['graph','Graph','graph',links.map],['explore','Explore','chart',links.explore]]) {
      const a=el('a');a.href=href;a.setAttribute('aria-label',label);a.dataset.tooltip=label;a.append(icon(doc,glyph));if(key===view)a.setAttribute('aria-current','page');nav.append(a);
    }
    side.append(nav);
    const bottom=el('nav','studio-sidebar-bottom');bottom.setAttribute('aria-label','Preferences');
    for(const [key,label,glyph,href] of [['settings','Settings','settings',links.settings],['audit','Record & privacy','lock',links.audit]]) {
      const a=el('a');a.href=href;a.setAttribute('aria-label',label);a.dataset.tooltip=label;a.append(icon(doc,glyph));if(key===view)a.setAttribute('aria-current','page');bottom.append(a);
    }
    const work=el('div','studio-work'),bar=el('div','studio-topbar');
    const status=el('span','studio-theme-status');status.setAttribute('aria-live','polite');
    const toggle=el('button');toggle.type='button';toggle.dataset.studioThemeToggle='';
    toggle.addEventListener('click',async()=>{
      const previous=doc.documentElement.dataset.theme,theme=previous==='dark'?'light':'dark';
      doc.documentElement.dataset.themeRevision=String(Number(doc.documentElement.dataset.themeRevision||0)+1);
      toggle.disabled=true;apply(doc,theme);
      try {if(win.chrome?.runtime?.id)await send(win,{type:'SET_UI_THEME',theme});status.textContent='';}
      catch{apply(doc,previous);status.textContent='Theme could not be saved. Try again.';}finally{toggle.disabled=false;}
    });
    bottom.append(toggle);side.append(bottom);
    bar.append(status);const body=el('div','studio-body');body.append(...children);work.append(bar,body);host.append(side,work);
    const search=body.querySelector('.nt-search');if(search)search.classList.add('studio-search');
    if(doc.studioDock)side.replaceWith(doc.studioDock);else doc.studioDock=side;
    const currentLinks={home:links.home,trails:`${links.home}${links.home.includes('?')?'&':'?'}view=trails`,graph:links.map,explore:links.explore,settings:links.settings,audit:links.audit};
    for(const a of doc.studioDock.querySelectorAll('a')) {a.removeAttribute('aria-current');if(a.href===new URL(currentLinks[view]||links.home,win.location.href).href)a.setAttribute('aria-current','page');}
    apply(doc,doc.documentElement.dataset.theme);
    return {body};
  }
  return {boot,mount,apply,topicIndex,topicColor,icon,onPage,navigate};
});
