/* A complete topic/page graph for the design prototype. Uses the already
   bundled D3. Records and node positions remain in memory. */
window.CTStudioGraph = (() => {
  'use strict';
  function screen({icon}) {
    return `<section class="graph-heading"><div><p class="eyebrow">A connected view of your record</p><h1>Your graph.</h1><p class="subhead">See the whole picture. Find your way back to a page.</p></div><span class="graph-date">${icon('calendar')}Sep 4 – 10, 2026</span></section>
      <section class="graph-workspace" aria-label="Interactive topic and page graph">
        <div class="graph-main"><div class="graph-toolbar"><div class="graph-scope"><span class="graph-live-dot"></span>All trails <span id="graph-counts"></span></div><div class="graph-options"><label class="graph-check"><input type="checkbox" id="graph-show-pages" checked>Pages</label><label class="graph-label-select"><span>Labels</span><select id="graph-labels" aria-label="Graph labels"><option value="auto">Auto</option><option value="all">All</option><option value="none">Off</option></select></label></div></div>
        <div class="graph-canvas"><svg id="studio-graph" aria-labelledby="graph-svg-title graph-svg-desc"><title id="graph-svg-title">Your trails and their recorded pages</title><desc id="graph-svg-desc">Large circles are topics; small circles are pages. Thin lines show topic membership. Arrowed lines show repeated recorded sequences between trails. Select a node or a line to inspect it. Drag nodes to arrange them, drag the background to pan, and use the zoom controls or pinch to zoom.</desc></svg><div class="graph-search-status" role="status" hidden></div><div class="graph-map-caption"><span class="graph-caption-top">YOUR BROWSING ATLAS</span><span>Grouped by subject. Connected by visits.</span></div><div class="graph-zoom"><button type="button" data-graph-action="out" aria-label="Zoom out">−</button><output id="graph-zoom-level" aria-label="Graph zoom">100%</output><button type="button" data-graph-action="in" aria-label="Zoom in">+</button><span></span><button type="button" data-graph-action="fit" aria-label="Fit all nodes">${icon('layers')}<span>Fit</span></button></div></div>
        <div class="graph-bottom"><div class="graph-key"><span><i class="key-topic"></i>Trail</span><span><i class="key-page"></i>Page</span><span><i class="key-flow">→</i>Recorded sequence</span></div><span class="graph-help">Drag to arrange · Pinch or scroll to zoom</span></div></div><aside class="graph-inspector" id="graph-inspector" aria-label="Graph selection details"></aside>
      </section><div class="graph-under"><div class="graph-topic-legend" id="graph-topic-legend"></div><button type="button" class="text-btn" data-action="evidence">About this record ${icon('external')}</button></div><p class="graph-evidence-note">Connections show consecutive recorded visits, not a relationship between ideas. Ungrouped pages remain part of your record.</p>`;
  }
  function mount(root,options) {
    const {topics,visits,pairs,days,icon,esc,mins,time,notes,announce,openDialog,sourceRow,memory}=options;
    const d3=window.d3;
    const svg=d3.select(root.querySelector('#studio-graph'));
    const canvas=root.querySelector('.graph-canvas');
    const inspector=root.querySelector('#graph-inspector');
    const byTopic=Object.fromEntries(topics.map(t=>[t.id,t]));
    const grouped=topics.filter(t=>t.id!=='other');
    const totals=id=>visits.filter(v=>v.topic===id).reduce((sum,v)=>sum+v.minutes,0);
    const topicPositions={rust:[235,190],models:[700,215],bread:[230,500],running:[705,520]};
    const pagePositions={rust:[[95,90],[280,53],[84,255],[396,117],[365,295]],models:[[625,74],[840,120],[855,317],[551,285]],bread:[[80,445],[160,621],[375,584]],running:[[552,457],[868,449],[824,628]],other:[[450,674],[590,702]]};
    const shortLabels={'Channels & message passing':'Channels','Shared state in async Rust':'Shared state','Async in depth':'Async in depth','Spawning tasks':'Spawning tasks','An async Rust overview':'Async overview','Model library':'Model library','Running a model locally':'Running locally','Quantization notes':'Quantization','The model collection':'Model collection','A beginner’s sourdough guide':'Sourdough guide','Sourdough starter':'The starter','Baking with sourdough':'Baking notes','Notes on running':'Running notes','Route ideas':'Route ideas','Training conversations':'Training','The daily links':'Daily links','A little of everything':'Everything else'};
    const nodes=[];
    grouped.forEach(t=>nodes.push({id:t.id,kind:'topic',topic:t.id,label:t.short,r:Math.max(24,Math.sqrt(totals(t.id))*2.1),x:topicPositions[t.id][0],y:topicPositions[t.id][1]}));
    topics.forEach(t=>t.pages.forEach((page,i)=>{
      const count=visits.filter(v=>v.page[2]===page[2]).length;
      nodes.push({id:`${t.id}-p${i}`,kind:'page',topic:t.id,label:page[0],short:shortLabels[page[0]],page,count,r:6+Math.sqrt(count),x:pagePositions[t.id][i][0],y:pagePositions[t.id][i][1]});
    }));
    nodes.forEach(n=>{const saved=memory.positions?.[n.id];if(saved){n.x=saved.x;n.y=saved.y;}n.ax=n.x;n.ay=n.y;});
    const byId=Object.fromEntries(nodes.map(n=>[n.id,n]));
    const memberships=nodes.filter(n=>n.kind==='page'&&n.topic!=='other').map(n=>({source:byId[n.topic],target:n}));
    const edges=[];
    grouped.forEach(a=>grouped.forEach(b=>{
      const sequences=pairs.filter(p=>p.from===a.id&&p.to===b.id);
      if(sequences.length>=2)edges.push({id:`${a.id}-${b.id}`,source:byId[a.id],target:byId[b.id],sequences});
    }));
    let selected=memory.selected||{kind:'topic',id:'rust'};
    let focus=memory.focus||false;
    let showPages=memory.showPages!==false;
    let labels=memory.labels||'auto';
    let query='';
    let width=canvas.clientWidth,height=canvas.clientHeight,baseScale=1;
    let transform=d3.zoomIdentity;
    let destroyed=false;
    const duration=()=>matchMedia('(prefers-reduced-motion: reduce)').matches?0:260;
    root.querySelector('#graph-show-pages').checked=showPages;
    root.querySelector('#graph-labels').value=labels;
    root.querySelector('#graph-counts').textContent=`${grouped.length} trails · ${nodes.filter(n=>n.kind==='page').length} pages`;
    root.querySelector('#graph-topic-legend').innerHTML=topics.map(t=>`<button type="button" class="graph-legend-item topic-${t.id}" data-graph-topic="${t.id}"><span class="topic-dot"></span>${t.short}</button>`).join('');
    const defs=svg.append('defs');
    defs.append('marker').attr('id','studio-arrow').attr('viewBox','0 -4 8 8').attr('refX',7).attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto').append('path').attr('d','M0,-3L7,0L0,3').attr('fill','none').attr('stroke','var(--graph-edge)').attr('stroke-width',1.4);
    const world=svg.append('g').attr('class','graph-world');
    const haloLayer=world.append('g').attr('class','graph-halos').attr('aria-hidden','true');
    const halos=haloLayer.selectAll('ellipse').data(nodes.filter(n=>n.kind==='topic')).join('ellipse').attr('class',n=>`topic-${n.topic}`).attr('rx',112).attr('ry',97);
    const membershipLayer=world.append('g').attr('class','graph-memberships').attr('aria-hidden','true');
    const memberLines=membershipLayer.selectAll('line').data(memberships).join('line').attr('class',e=>`graph-member topic-${e.source.topic}`);
    const flowLayer=world.append('g').attr('class','graph-flows');
    const flowGroups=flowLayer.selectAll('g').data(edges).join('g').attr('class','graph-flow').attr('data-edge-id',e=>e.id).attr('role','button').attr('tabindex',0).attr('aria-label',e=>`${byTopic[e.source.topic].short} to ${byTopic[e.target.topic].short}, ${e.sequences.length} recorded sequences. Inspect visits.`).on('click',(event,e)=>{event.stopPropagation();select({kind:'edge',id:e.id});}).on('keydown',(event,e)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select({kind:'edge',id:e.id});}});
    flowGroups.append('path').attr('class','graph-flow-hit');
    flowGroups.append('path').attr('class','graph-flow-line').attr('marker-end','url(#studio-arrow)');
    flowGroups.append('rect').attr('class','graph-flow-badge').attr('width',26).attr('height',22).attr('rx',7);
    flowGroups.append('text').attr('class','graph-flow-count').attr('text-anchor','middle').attr('dominant-baseline','central').text(e=>e.sequences.length);
    const nodeLayer=world.append('g');
    const nodeGroups=nodeLayer.selectAll('g').data(nodes).join('g').attr('class',n=>`graph-node graph-${n.kind} topic-${n.topic}`).attr('data-node-id',n=>n.id).attr('role','button').attr('tabindex',0).attr('aria-label',n=>`${n.kind==='topic'?'Trail':'Page'}: ${n.label}. ${n.kind==='topic'?`${totals(n.topic)} estimated minutes`:`${n.count} recorded visits`}. Inspect details.`)
      .on('click',(event,n)=>{event.stopPropagation();select({kind:n.kind,id:n.id});})
      .on('keydown',(event,n)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select({kind:n.kind,id:n.id});}});
    nodeGroups.append('circle').attr('class','graph-node-hit').attr('r',n=>Math.max(22,n.r+10));
    nodeGroups.filter(n=>n.kind==='topic').append('circle').attr('class','graph-node-ring').attr('r',n=>n.r+8);
    nodeGroups.append('circle').attr('class','graph-node-body').attr('r',n=>n.r);
    nodeGroups.filter(n=>n.kind==='topic').append('text').attr('class','graph-topic-glyph').attr('text-anchor','middle').attr('dominant-baseline','central').text(n=>({rust:'{ }',models:'◇',bread:'≈',running:'↗'}[n.id]));
    nodeGroups.filter(n=>n.kind==='page').append('path').attr('class','graph-page-glyph').attr('d','M-2.5,-3.5H2.5V3.5H-2.5ZM-1,-1H1M-1,1H1');
    nodeGroups.append('text').attr('class','graph-node-label').attr('text-anchor','middle').attr('y',n=>n.r+24).text(n=>n.kind==='topic'?n.label:n.short);
    nodeGroups.filter(n=>n.kind==='topic').append('text').attr('class','graph-node-meta').attr('text-anchor','middle').attr('y',n=>n.r+43).text(n=>`${byTopic[n.topic].pages.length} pages · ${mins(totals(n.topic))} est.`);
    nodeGroups.filter(n=>n.kind==='page').append('text').attr('class','graph-page-domain').attr('text-anchor','middle').attr('y',n=>n.r+40).text(n=>n.page[1]);
    const otherLabel=world.append('text').attr('class','graph-ungrouped-label').attr('x',525).attr('y',630).attr('text-anchor','middle').text('UNGROUPED · STILL IN YOUR RECORD');
    const sim=d3.forceSimulation(nodes).force('x',d3.forceX(n=>n.ax).strength(.22)).force('y',d3.forceY(n=>n.ay).strength(.22)).force('collision',d3.forceCollide(n=>n.kind==='topic'?64:37).strength(.8)).stop();
    if(!memory.positions)for(let i=0;i<80;i++)sim.tick();
    sim.on('tick',draw);
    let dragTopic=null;
    nodeGroups.call(d3.drag().container(()=>world.node()).on('start',(event,n)=>{
      if(!event.active)sim.alphaTarget(.06).restart();
      n.fx=n.x;n.fy=n.y;dragTopic=n.kind==='topic'?n.topic:null;
    }).on('drag',(event,n)=>{
      const dx=event.x-n.x,dy=event.y-n.y;
      n.fx=event.x;n.fy=event.y;n.ax=event.x;n.ay=event.y;
      if(dragTopic)nodes.filter(p=>p.kind==='page'&&p.topic===dragTopic).forEach(p=>{p.x+=dx;p.y+=dy;p.ax+=dx;p.ay+=dy;});
      n.x=event.x;n.y=event.y;draw();
    }).on('end',(event,n)=>{if(!event.active)sim.alphaTarget(0);n.fx=null;n.fy=null;dragTopic=null;}));
    const zoom=d3.zoom().extent(()=>[[0,0],[width,height]]).scaleExtent([.22,3.5]).filter(event=>event.type==='wheel'||(!event.ctrlKey&&!event.button&&!event.target.closest('.graph-node,.graph-flow'))).on('zoom',event=>{
      transform=event.transform;world.attr('transform',transform);memory.transform={x:transform.x,y:transform.y,k:transform.k};
      const percent=Math.round(transform.k/baseScale*100);root.querySelector('#graph-zoom-level').textContent=`${percent}%`;
      updateLabelVisibility();
    });
    svg.call(zoom).on('dblclick.zoom',null).on('click',event=>{if(event.target===svg.node()){focus=false;selected=null;paintSelection();renderInspector();announce('Showing the complete graph.');}});
    function curve(e) {
      const a=e.source,b=e.target,dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1;
      const s={x:a.x+dx/length*(a.r+13),y:a.y+dy/length*(a.r+13)};
      const t={x:b.x-dx/length*(b.r+15),y:b.y-dy/length*(b.r+15)};
      const bend=Math.abs(dx)>Math.abs(dy)?-26:24;
      const c={x:(s.x+t.x)/2-dy/length*bend,y:(s.y+t.y)/2+dx/length*bend};
      return {d:`M${s.x},${s.y}Q${c.x},${c.y} ${t.x},${t.y}`,mx:(s.x+2*c.x+t.x)/4,my:(s.y+2*c.y+t.y)/4};
    }
    function draw() {
      nodeGroups.attr('transform',n=>`translate(${n.x},${n.y})`);
      halos.attr('cx',n=>n.x).attr('cy',n=>n.y);
      memberLines.attr('x1',e=>e.source.x).attr('y1',e=>e.source.y).attr('x2',e=>e.target.x).attr('y2',e=>e.target.y);
      flowGroups.each(function(e){const c=curve(e),g=d3.select(this);g.selectAll('path').attr('d',c.d);g.select('rect').attr('x',c.mx-13).attr('y',c.my-11);g.select('text').attr('x',c.mx).attr('y',c.my);});
    }
    function fit(animate=false) {
      const visible=nodes.filter(n=>showPages||n.kind==='topic');
      const minX=d3.min(visible,n=>n.x-(n.kind==='topic'?110:75))-20;
      const maxX=d3.max(visible,n=>n.x+(n.kind==='topic'?110:75))+20;
      const minY=d3.min(visible,n=>n.y-n.r)-25;
      const maxY=d3.max(visible,n=>n.y+n.r+45)+25;
      const room=width<600?12:24;
      baseScale=Math.min((width-room*2)/(maxX-minX),(height-112)/(maxY-minY));
      const target=d3.zoomIdentity.translate((width-(maxX-minX)*baseScale)/2-minX*baseScale,(height-36-(maxY-minY)*baseScale)/2-minY*baseScale).scale(baseScale);
      (animate?svg.transition().duration(duration()):svg).call(zoom.transform,target);
    }
    function updateLabelVisibility() {
      const relative=transform.k/baseScale;
      world.attr('data-page-labels',labels==='all'||(labels==='auto'&&relative>=.88&&transform.k>=.6)?'show':'hide');
      world.attr('data-domains',labels==='all'||(labels==='auto'&&relative>=1.55)?'show':'hide');
      world.attr('data-all-labels',labels==='none'?'hide':'show');
      nodeGroups.filter(n=>n.kind==='page').select('.graph-node-label').text(n=>relative>=1.55||labels==='all'?n.label:n.short);
      nodeGroups.filter(n=>n.kind==='topic').select('.graph-node-label').style('font-size',`${Math.max(14,12/transform.k)}px`);
      nodeGroups.filter(n=>n.kind==='page').select('.graph-node-label').style('font-size',`${Math.max(12,11/transform.k)}px`);
      nodeGroups.selectAll('.graph-node-meta,.graph-page-domain').style('font-size',`${Math.max(11,10/transform.k)}px`);
      nodeGroups.select('.graph-node-label').attr('y',n=>n.r+Math.max(24,20/transform.k));
      nodeGroups.select('.graph-node-meta').attr('y',n=>n.r+Math.max(24,20/transform.k)+Math.max(19,16/transform.k));
      nodeGroups.select('.graph-page-domain').attr('y',n=>n.r+Math.max(24,20/transform.k)+Math.max(17,15/transform.k));
      const hitRadius=(matchMedia('(pointer: coarse)').matches?22:16)/transform.k;
      nodeGroups.select('.graph-node-hit').attr('r',n=>Math.max(n.r+10,hitRadius));
    }
    function selectionTopics() {
      if(!selected)return new Set();
      if(selected.kind==='edge'){const e=edges.find(e=>e.id===selected.id);return new Set([e.source.id,e.target.id]);}
      return new Set([byId[selected.id]?.topic||selected.id]);
    }
    function paintSelection() {
      const active=selectionTopics();
      const neighborhood=new Set(active);
      edges.forEach(e=>{if(active.has(e.source.id)||active.has(e.target.id)){neighborhood.add(e.source.id);neighborhood.add(e.target.id);}});
      const q=query.toLowerCase().trim();
      const matches=n=>[n.label,n.page?.[1]||'',byTopic[n.topic].label].join(' ').toLowerCase().includes(q);
      nodeGroups.classed('is-selected',n=>selected?.id===n.id).classed('is-faded',n=>q?!matches(n):(focus&&!neighborhood.has(n.topic))).classed('is-match',n=>q&&matches(n)).attr('aria-pressed',n=>String(selected?.id===n.id));
      halos.classed('is-active',n=>active.has(n.id)).classed('is-faded',n=>focus&&!neighborhood.has(n.topic));
      memberLines.classed('is-emphasized',e=>active.has(e.source.id)).classed('is-faded',e=>focus&&!neighborhood.has(e.source.id));
      flowGroups.classed('is-selected',e=>selected?.kind==='edge'&&selected.id===e.id).classed('is-emphasized',e=>active.has(e.source.id)||active.has(e.target.id)).classed('is-faded',e=>focus&&!active.has(e.source.id)&&!active.has(e.target.id)).attr('aria-pressed',e=>String(selected?.kind==='edge'&&selected.id===e.id));
      root.querySelectorAll('[data-graph-topic]').forEach(b=>b.setAttribute('aria-pressed',String(active.has(b.dataset.graphTopic))));
      memory.selected=selected;memory.focus=focus;
    }
    function select(value) {
      selected=value;paintSelection();renderInspector();
      const label=value.kind==='edge'?'Recorded connection':byId[value.id]?.label||'Ungrouped pages';
      announce(`${label} selected. Details updated beside the graph.`);
    }
    function inspectTop(type,title,topic) {
      return `<div class="graph-inspect-kicker"><span>${type}</span><button type="button" class="icon-btn" data-graph-action="clear" aria-label="Clear graph selection">${icon('close')}</button></div>${topic?`<div class="graph-inspect-icon topic-${topic.id}">${icon(topic.icon)}</div>`:''}<h2>${esc(title)}</h2>`;
    }
    function pageButton(n) {
      return `<button type="button" class="graph-source" data-graph-node="${n.id}"><span class="graph-source-letter">${esc(n.page[1][0].toUpperCase())}</span><span><strong>${esc(n.page[0])}</strong><small>${esc(n.page[1])}</small></span>${icon('arrow')}</button>`;
    }
    function focusButton() {return `<button type="button" class="graph-focus-button" data-graph-action="focus" aria-pressed="${focus}">${icon('search')}${focus?'Show full graph':'Focus this neighborhood'}</button>`;}
    function renderInspector() {
      if(!selected){
        inspector.innerHTML=`${inspectTop('GRAPH OVERVIEW','A way back to everything.')}<p class="graph-inspect-description">Every trail and page stays on the canvas. Select one to see the record behind it.</p><div class="graph-inspect-stats"><span><strong>${grouped.length}</strong><small>trails</small></span><span><strong>${nodes.filter(n=>n.kind==='page').length}</strong><small>pages</small></span><span><strong>${edges.length}</strong><small>connections</small></span></div><h3>Choose a starting point</h3>${grouped.map(t=>`<button type="button" class="graph-related topic-${t.id}" data-graph-node="${t.id}"><span class="topic-dot"></span><span>${t.short}</span>${icon('arrow')}</button>`).join('')}<p class="graph-inspect-footnote">Topic size reflects estimated time. Page size reflects recorded visits. Counts describe this sample record.</p>`;return;
      }
      if(selected.kind==='edge'){
        const edge=edges.find(e=>e.id===selected.id);
        inspector.innerHTML=`${inspectTop('RECORDED CONNECTION',`${byTopic[edge.source.id].short} → ${byTopic[edge.target.id].short}`)}<p class="graph-inspect-description">${edge.sequences.length} consecutive sequences across ${new Set(edge.sequences.map(p=>p.day)).size} days.</p>${focusButton()}<h3>The visits behind the line</h3>${edge.sequences.map(p=>`<div class="graph-sequence"><span>${days[p.day].date} · ${time(p.before.start)}</span><strong>${esc(p.before.page[0])}</strong><small>↓ followed by · ${time(p.after.start)}</small><strong>${esc(p.after.page[0])}</strong></div>`).join('')}<button type="button" class="primary-btn" data-graph-action="sources">Inspect source pages ${icon('external')}</button><p class="graph-inspect-footnote">Consecutive visits within 30 minutes. This is an observed sequence, not proof of a shared task.</p>`;return;
      }
      const n=byId[selected.id];
      const t=byTopic[n?.topic||selected.id];
      if(selected.kind==='page'){
        const pageVisits=visits.filter(v=>v.page[2]===n.page[2]);
        inspector.innerHTML=`${inspectTop('SELECTED PAGE',n.page[0],t)}<p class="graph-inspect-description">${esc(n.page[1])}</p><div class="graph-inspect-stats"><span><strong>${pageVisits.length}</strong><small>recorded visits</small></span><span><strong>${mins(pageVisits.reduce((sum,v)=>sum+v.minutes,0))}</strong><small>estimated time</small></span></div><h3>${t.id==='other'?'Grouping':'In this trail'}</h3><button type="button" class="graph-related topic-${t.id}" data-graph-topic="${t.id}"><span class="topic-dot"></span><span>${t.short}</span>${icon('arrow')}</button><h3>Recent visits</h3>${pageVisits.slice(-3).reverse().map(v=>`<div class="graph-visit"><span>${days[v.day].date} · ${time(v.start)}</span><strong>${v.minutes}m est.</strong></div>`).join('')}<a class="primary-btn" href="${esc(n.page[2])}" target="_blank" rel="noopener noreferrer">Open original page ${icon('external')}</a><button type="button" class="graph-focus-button" data-graph-action="page-visits">Inspect all ${pageVisits.length} visits</button><p class="graph-inspect-footnote">Estimated time describes visits to this page, across the selected week.</p>`;return;
      }
      const list=visits.filter(v=>v.topic===t.id),related=edges.filter(e=>e.source.id===t.id||e.target.id===t.id);
      inspector.innerHTML=`${inspectTop(t.id==='other'?'UNGROUPED PAGES':'SELECTED TRAIL',t.label,t)}<p class="graph-inspect-description">${t.id==='other'?'These pages stay visible without a suggested topic.':'A suggested group of your recorded pages.'}</p><div class="graph-inspect-stats"><span><strong>${t.pages.length}</strong><small>pages</small></span><span><strong>${list.length}</strong><small>visits</small></span><span><strong>${mins(totals(t.id))}</strong><small>est. time</small></span></div>${t.id==='other'?'':focusButton()}<div class="graph-inspector-section"><h3>Pages in this trail <span>${t.pages.length}</span></h3>${nodes.filter(n=>n.kind==='page'&&n.topic===t.id).map(pageButton).join('')}</div>${related.length?`<div class="graph-inspector-section"><h3>Recorded connections</h3>${related.map(e=>`<button type="button" class="graph-related topic-${e.source.id===t.id?e.target.id:e.source.id}" data-graph-edge="${e.id}"><span class="topic-dot"></span><span>${e.source.id===t.id?'To':'From'} ${byTopic[e.source.id===t.id?e.target.id:e.source.id].short}</span><strong>${e.sequences.length}</strong>${icon('arrow')}</button>`).join('')}</div>`:''}<button type="button" class="primary-btn" data-trail="${t.id}">Open ${t.id==='other'?'these pages':'this trail'} ${icon('arrow')}</button>${t.id==='other'?'':`<button type="button" class="graph-focus-button" data-action="note" data-id="${t.id}">${icon('note')}${notes[t.id]?'View your next-step note':'Leave a note for next time'}</button>`}`;
    }
    function togglePages() {
      nodeGroups.filter(n=>n.kind==='page').attr('display',showPages?null:'none').attr('tabindex',showPages?0:-1);
      membershipLayer.attr('display',showPages?null:'none');otherLabel.attr('display',showPages?null:'none');memory.showPages=showPages;
      if(!showPages&&selected?.kind==='page')select({kind:'topic',id:byId[selected.id].topic});
      if(!showPages&&selected?.id==='other'){selected=null;paintSelection();renderInspector();}
      announce(showPages?'All page nodes are visible.':'Topic overview. Page nodes hidden.');
    }
    function handleClick(event) {
      const button=event.target.closest('button');if(!button)return;
      const d=button.dataset;
      if(d.graphNode){const n=byId[d.graphNode];select({kind:n.kind,id:n.id});return;}
      if(d.graphTopic){select({kind:'topic',id:d.graphTopic});return;}
      if(d.graphEdge){select({kind:'edge',id:d.graphEdge});return;}
      if(!d.graphAction)return;
      if(d.graphAction==='in'||d.graphAction==='out')svg.transition().duration(duration()).call(zoom.scaleBy,d.graphAction==='in'?1.3:1/1.3);
      if(d.graphAction==='fit')fit(true);
      if(d.graphAction==='clear'){selected=null;focus=false;paintSelection();renderInspector();}
      if(d.graphAction==='focus'){focus=!focus;paintSelection();renderInspector();root.querySelector('[data-graph-action="focus"]')?.focus({preventScroll:true});announce(focus?'The selected neighborhood is emphasized. Other nodes remain visible.':'Showing the full graph.');}
      if(d.graphAction==='sources'){
        const edge=edges.find(e=>e.id===selected.id);openDialog('The pages behind this line',edge.sequences.map(p=>`<div class="rationale-row"><p class="eyebrow">${days[p.day].date}</p>${sourceRow(p.before,true)}${sourceRow(p.after,true)}</div>`).join(''),'RECORDED SEQUENCES');
      }
      if(d.graphAction==='page-visits'){
        const n=byId[selected.id];openDialog(esc(n.label),visits.filter(v=>v.page[2]===n.page[2]).map(v=>`<div class="rationale-row"><p class="eyebrow">${days[v.day].date}</p>${sourceRow(v,true)}</div>`).join(''));
      }
    }
    function handleChange(event) {
      if(event.target.id==='graph-show-pages'){showPages=event.target.checked;togglePages();}
      if(event.target.id==='graph-labels'){labels=event.target.value;memory.labels=labels;updateLabelVisibility();}
    }
    root.addEventListener('click',handleClick);root.addEventListener('change',handleChange);
    draw();
    svg.attr('viewBox',`0 0 ${width} ${height}`);
    fit();
    if(memory.savedTransform)svg.call(zoom.transform,d3.zoomIdentity.translate(memory.savedTransform.x,memory.savedTransform.y).scale(memory.savedTransform.k));
    togglePages();paintSelection();renderInspector();
    const resize=new ResizeObserver(()=>{if(destroyed)return;const w=canvas.clientWidth,h=canvas.clientHeight;if(w===width&&h===height)return;width=w;height=h;svg.attr('viewBox',`0 0 ${width} ${height}`);fit();});
    resize.observe(canvas);
    return {
      search(value) {
        query=value;paintSelection();const q=query.trim().toLowerCase();const count=nodes.filter(n=>[n.label,n.page?.[1]||'',byTopic[n.topic].label].join(' ').toLowerCase().includes(q)).length;
        const status=root.querySelector('.graph-search-status');status.hidden=!q;status.textContent=count?`${count} matching nodes · Clear search to see all`:'No matching nodes · Try a trail, page, or website';
      },
      destroy() {
        destroyed=true;sim.stop();resize.disconnect();svg.interrupt();svg.on('.zoom',null);root.removeEventListener('click',handleClick);root.removeEventListener('change',handleChange);memory.positions=Object.fromEntries(nodes.map(n=>[n.id,{x:n.x,y:n.y}]));memory.savedTransform={x:transform.x,y:transform.y,k:transform.k};
      }
    };
  }
  return {screen,mount};
})();
