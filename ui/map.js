const FLOW_COLORS = CTMapData.TRANSITION_TYPES;

class TopicMapVisualizer {
  // `deps.store` is the seam a headless render test drives this through; the
  // extension page passes nothing and gets the real IndexedDB store.
  constructor(deps) {
    this.recordNow = deps && deps.now;
    this.isDemo = !!(deps && deps.isDemo);
    this.store = (deps && deps.store) || CTStore.createStore({});
    this.svg = null;
    this.g = null;
    this.width = 1000;
    this.height = 650;
    this.zoom = null;
    this.simulation = null;
    this.analysis = null;
    this.graphData = { nodes: [], links: [] };
    this.currentScale = 1;
    this.selected = null;
    this.topicAnchors = new Map();
    this.savedPositions = new Map();
    this.init();
  }

  init() {
    this.setupSVG();
    this.setupControls();
    this.addZoomControls();
    const params = new URLSearchParams(window.location.search);
    this.ready=this.loadAnalysis(params.get('refresh') === '1' || params.get('forceRefresh') === '1');
    this.resizeListener=()=>this.handleResize();window.addEventListener('resize',this.resizeListener);
  }

  dispose() {this.loadVersion++;this.svg?.interrupt();this.simulation?.stop();window.removeEventListener('resize',this.resizeListener);this.store.close?.();}

  setupSVG() {
    const container = document.getElementById('graph-container');
    const rect = container.getBoundingClientRect();
    this.width = rect.width || 1000;
    this.height = rect.height || 650;

    this.svg = d3.select('#graph')
      .attr('width', this.width)
      .attr('height', this.height);

    this.svg.selectAll('*').remove();
    const defs = this.svg.append('defs');
    // One marker per flow type so arrowheads match their line color, sized in
    // user space so thick lines don't produce giant arrows.
    for (const [type, item] of Object.entries(FLOW_COLORS)) {
      defs.append('marker')
        .attr('id', `flow-arrow-${type}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 9)
        .attr('refY', 0)
        .attr('markerWidth', 12)
        .attr('markerHeight', 12)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4.5 L10,0 L0,4.5 L2.5,0 Z')
        .attr('fill', 'var(--text-dim, #a9a2c9)');
    }

    this.g = this.svg.append('g');
    this.zoom = d3.zoom()
      .scaleExtent([0.05, 4])
      .wheelDelta(event => {
        // Trackpad pinches arrive as wheel events with ctrlKey set and tiny
        // deltas, so they need a boost while two-finger scroll stays gentle.
        const base = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.0022;
        return -event.deltaY * base * (event.ctrlKey ? 5 : 1);
      })
      .on('zoom', event => {
        this.hideTooltip();
        if (event.sourceEvent) this.overviewMode = false;
        this.g.attr('transform', event.transform);
        this.updateLevelOfDetail(event.transform.k);
      });
    this.svg.call(this.zoom);
    this.svg.on('click', () => this.hideTooltip());
  }

  setupControls() {
    const windowSelect = document.getElementById('window-days');
    if (windowSelect) {
      windowSelect.addEventListener('change', () => {
        this.windowDays = Number(windowSelect.value) || 30;
        this.loadAnalysis(false);
      });
    }
    document.getElementById('graph-labels')?.addEventListener('change', () => this.updateLevelOfDetail(this.currentScale));
    document.getElementById('show-pages')?.addEventListener('change', () => { if(document.getElementById('show-pages').checked)document.getElementById('show-flows').checked=false; if(this.selected)this.layoutFocus(); this.updateLevelOfDetail(this.currentScale); });
    document.getElementById('show-flows')?.addEventListener('change', () => { if(document.getElementById('show-flows').checked)document.getElementById('show-pages').checked=false; if(this.selected)this.layoutFocus(); this.updateLevelOfDetail(this.currentScale); });
    document.getElementById('graph-search')?.addEventListener('input', () => this.searchGraph());
    document.getElementById('graph-search')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { const node = this.searchMatches?.[0]; if (node) this.openNode(node); }
      if (event.key === 'Escape') { event.target.value = ''; this.clearSelection(); }
    });
    document.getElementById('flow-limit').addEventListener('change', () => {
      if (this.analysis && this.analysis.ok) this.renderAnalysis(this.analysis);
    });
    document.getElementById('topic-limit').addEventListener('change', () => {
      if (this.analysis && this.analysis.ok) this.renderAnalysis(this.analysis);
    });
  }

  addZoomControls() {
    const container = document.getElementById('graph-container');
    const controls = document.createElement('div');
    controls.className = 'zoom-controls';
    controls.innerHTML = `
      <button class="zoom-control" type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
      <button class="zoom-control" type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">-</button>
      <button class="zoom-control" type="button" data-zoom="reset" aria-label="Fit graph to view" title="Fit graph to view">Overview</button>
      <button class="zoom-control" type="button" data-zoom="clear" aria-label="Clear selection" title="Clear selection">Clear</button>
    `;
    container.appendChild(controls);
    const modes=document.createElement('div');modes.className='graph-focus-tabs';modes.setAttribute('role','group');modes.setAttribute('aria-label','Map detail');
    for(const [label,id] of [['Pages','show-pages'],['Connections','show-flows']]) {
      const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.graphMode=id;
      button.addEventListener('click',()=>{const input=document.getElementById(id);input.checked=true;input.dispatchEvent(new Event('change'));});modes.append(button);
    }
    container.append(modes);
    controls.addEventListener('click', event => {
      const action = event.target.dataset.zoom;
      if (!action) return;
      if (action === 'in' || action === 'out') this.overviewMode = false;
      if (action === 'in') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1.7);
      if (action === 'out') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1 / 1.7);
      if (action === 'reset') { const search = document.getElementById('graph-search'); if (search) search.value = ''; this.query = ''; this.clearSelection(); this.fitToViewport(); }
      if (action === 'clear') { const search = document.getElementById('graph-search'); if (search) search.value = ''; this.clearSelection(); }
    });
  }

  handleResize() {
    this.hideTooltip();
    const rect = document.getElementById('graph-container').getBoundingClientRect();
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;
    this.svg.attr('width', this.width).attr('height', this.height);
    if (!this.selected && this.updatePositions) {
      this.renderGraph(this.graphData);
    } else if(this.selected) this.layoutFocus(); else this.updateLevelOfDetail(this.currentScale);
  }

  async loadAnalysis(forceRefresh) {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    this.setLoading(true, forceRefresh ? 'Refreshing your record...' : 'Loading your record...');
    this.setStatus('Loading your record...');
    this.setHealth('checking', 'Loading');
    try {
      await this.store.open();
      const analysis = await CTMapData.build(this.store, { windowDays: this.windowDays || 30, now: this.recordNow });
      if (version !== this.loadVersion) return;
      if (!analysis.ok) {
        this.renderUnavailable(analysis);
        return;
      }
      this.analysis = analysis;
      this.setHealth('ok', this.isDemo ? 'Recorded sample' : `Registry · last run ${timeAgo(analysis.generatedAt)}`);
      this.renderAnalysis(analysis);
      this.setLoading(false);
      this.checkStaleness(analysis);
    } catch (error) {
      if (version !== this.loadVersion) return;
      console.error(error);
      this.renderUnavailable({
        ok: false,
        message: error.message || String(error),
        warnings: ['Analysis failed before the topic map could be built.']
      });
    }
  }

  // If the stored analysis is being shown but the user has browsed since it
  // was generated, offer a re-run instead of silently serving stale claims.
  async checkStaleness(analysis) {
    if (this.isDemo || typeof chrome === 'undefined' || !chrome.history) return;
    const since = (analysis.coverage && analysis.coverage.endTime) || Date.parse(analysis.generatedAt);
    try {
      const items = await new Promise(resolve =>
        chrome.history.search({ text: '', startTime: since, maxResults: 100 }, resolve));
      const fresh = (items || []).filter(item =>
        item && item.url && !CTPrivacy.isFilteredDomain(item.url) && Number(item.lastVisitTime) > since);
      if (fresh.length >= 10 && this.analysis === analysis) {
        this.showStalenessBanner({ newItemCount: fresh.length, atLimit: (items || []).length >= 100 });
      }
    } catch {
      // Staleness detection is best-effort; never block the map on it.
    }
  }

  showStalenessBanner(staleness) {
    const banner = document.getElementById('staleness-banner');
    if (!banner) return;
    const count = staleness.atLimit ? `${staleness.newItemCount}+` : String(staleness.newItemCount);
    banner.hidden = false;
    banner.innerHTML = `
      <span>${escapeHtml(count)} newer history entries are available. Refresh to read the latest saved pages.</span>
      <a class="banner-link" href="map.html?refresh=1">Refresh graph</a>
      <button type="button" id="staleness-dismiss" class="banner-dismiss" title="Dismiss">×</button>
    `;
    document.getElementById('staleness-dismiss').addEventListener('click', () => {
      banner.hidden = true;
    });
  }

  // The map reads the registry, so "nothing to draw" almost always means the
  // pipeline has not run yet, not that Ollama is down. Say which.
  renderUnavailable(result) {
    this.analysis = result;
    this.simulation?.stop();
    this.svg.interrupt();
    this.g.selectAll('*').remove();
    this.svg.selectAll('.label-overlay').remove();
    this.graphData = { nodes: [], links: [], transitionLinks: [] };
    this.selected = null;
    this.searchMatches = [];
    this.nodeSelection = this.labelSelection = this.updatePositions = null;
    const hint = document.getElementById('graph-view-status');
    if (hint) hint.textContent = 'No trails in this view';
    this.setLoading(false);
    const failed = !!result.message;
    this.setHealth('unavailable', failed ? 'Registry unavailable' : 'No topics yet');
    this.setStatus(failed
      ? result.message
      : `No topics with activity in the last ${this.windowDays || 30} days.`);
    document.getElementById('summary-strip').innerHTML = '';
    document.getElementById('legend').innerHTML = '';
    document.getElementById('evidence-panel').innerHTML = failed ? `
      <div class="evidence-section">
        <h2>Could not read the registry</h2>
        <p>${escapeHtml(result.message)}</p>
      </div>
    ` : `
      <div class="evidence-section">
        <h2>Nothing mapped yet</h2>
        <p>No recorded pages in this period. Try 90 days, or <a href="newtab.html">open Home</a>.</p>
        <p><a href="options.html">Set up page grouping</a> to create trails as you browse.</p>
      </div>
    `;
  }

  renderAnalysis(analysis) {
    this.hideTooltip();
    this.analysis = analysis;
    for (const node of this.graphData.nodes) if (Number.isFinite(node.x)) this.savedPositions.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy });
    this.selected = null;
    this.graphData = this.buildGraphData(analysis);
    this.renderSummary(analysis);
    this.renderLegend();
    this.renderGraph(this.graphData);
    this.renderAtlas();
    this.searchGraph();
    const when = this.isDemo ? ' Synthetic sample, March 2026.' : analysis.generatedAt ? ` Analyzed ${timeAgo(analysis.generatedAt)}.` : '';
    this.setStatus(`${analysis.topics.length} trails · ${analysis.coverage.visitsExpanded} recorded visits.${when}`);
  }

  buildGraphData(analysis) {
    const flowLimitValue = document.getElementById('flow-limit').value;
    const topicLimitValue = document.getElementById('topic-limit').value;
    const rankedTopics = analysis.topics.slice().sort((a, b) =>
      b.estimatedDwellMs - a.estimatedDwellMs || b.visitCount - a.visitCount || a.label.localeCompare(b.label)
    );
    const visibleTopics = topicLimitValue === 'all'
      ? rankedTopics
      : rankedTopics.slice(0, Number(topicLimitValue));
    const visibleTopicIds = new Set(visibleTopics.map(topic => topic.id));
    this.visibleTopicCount = visibleTopics.length;
    // Keep density visible even when the whole record is zoomed out.
    const attentionMass = topic => topic.visitCount;
    const topicRadius = d3.scaleSqrt()
      .domain([0, Math.max(100, d3.max(visibleTopics, attentionMass) || 1)])
      .range([11, 28]);
    const groups = CTMapData.buildTopicGroups(visibleTopics);
    const groupByTopic = new Map(groups.flatMap(g => g.topicIds.map(id => [id, g])));
    const topicNodes = visibleTopics.map((topic, index) => ({
      id: topic.id,
      type: 'topic',
      topic,
      label: topic.label,
      groupId: groupByTopic.get(topic.id)?.id,
      color: globalThis.CTStudio ? CTStudio.topicColor(groupByTopic.get(topic.id)?.related ? groupByTopic.get(topic.id).id : topic.id) : topic.color,
      attentionBand: topic.attentionBand,
      attentionRank: topic.attentionRank,
      radius: topicRadius(attentionMass(topic)),
      index
    }));

    const maxPageVisits = d3.max(visibleTopics, topic => d3.max(topic.topPages, page => page.visitCount)) || 1;
    const pageRadius = d3.scaleSqrt().domain([0, maxPageVisits]).range([4, 12]);
    const pageNodes = [];
    const membershipLinks = [];
    for (const topic of visibleTopics) {
      for (const [pageIndex, page] of (topic.pages || topic.topPages).entries()) {
        const node = {
          id: `${topic.id}:${page.id}`,
          type: 'page',
          pageIndex,
          siblingCount: (topic.pages || topic.topPages).length,
          page,
          parentTopicId: topic.id,
          label: page.title,
          groupId: groupByTopic.get(topic.id)?.id,
          color: topicNodes.find(n => n.id === topic.id).color,
          radius: Math.max(4.5, pageRadius(page.visitCount))
        };
        pageNodes.push(node);
        membershipLinks.push({
          id: `member:${topic.id}:${page.id}`,
          type: 'membership',
          source: topic.id,
          target: node.id,
          weight: 1,
          color: globalThis.CTStudio ? CTStudio.topicColor(topic.id) : topic.color
        });
      }
    }

    for (const [pageIndex, page] of (analysis.uncategorized?.pages || []).entries()) {
      pageNodes.push({ id: `ungrouped:${page.id}`, type: 'page', page, pageIndex, siblingCount: analysis.uncategorized.pages.length, parentTopicId: null, label: page.title, color: 'var(--text-dim, #a5b1c5)', radius: 6 });
    }
    const crossTopic = analysis.transitions.filter(t =>
      t.sourceTopicId !== t.targetTopicId &&
      visibleTopicIds.has(t.sourceTopicId) &&
      visibleTopicIds.has(t.targetTopicId)
    );
    const limited = crossTopic;
    // When both directions between two topics are visible (A->B and B->A),
    // straight lines overlap almost exactly. Curve each one so both remain
    // legible instead of looking like one line with an arrow on each end.
    const limitedKeys = new Set(limited.map(t => `${t.sourceTopicId}->${t.targetTopicId}`));
    const transitionLinks = limited.map(transition => ({
      id: transition.id,
      type: 'transition',
      source: transition.sourceTopicId,
      target: transition.targetTopicId,
      transition,
      weight: transition.visitCount,
      color: transition.color,
      hasReciprocal: limitedKeys.has(`${transition.targetTopicId}->${transition.sourceTopicId}`)
    }));

    return {
      nodes: [...topicNodes, ...(analysis.uncategorized?.pages?.length ? [{id:'collection:ungrouped',type:'collection',label:`${analysis.uncategorized.pages.length} ungrouped pages`,color:'var(--text-dim, #a5b1c5)',radius:28,index:topicNodes.length}] : []), ...pageNodes],
      links: [...membershipLinks, ...transitionLinks],
      transitionLinks, groups, overviewFlowLimit: flowLimitValue === 'all' ? Infinity : Number(flowLimitValue)
    };
  }

  renderGraph(data) {
    this.g.selectAll('*').remove();
    this.simulation?.stop();
    const rect = document.getElementById('graph-container').getBoundingClientRect();
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;
    this.svg.attr('width', this.width).attr('height', this.height);
    const roots = data.nodes.filter(n => n.type !== 'page');
    this.computeTopicAnchors(roots);
    for (const node of roots) Object.assign(node, this.topicAnchors.get(node.id));
    for (const node of data.nodes.filter(n => n.type === 'page')) Object.assign(node, this.anchorForNode(node));
    const byId = new Map(data.nodes.map(n => [n.id, n]));
    for (const link of data.links) {
      if (typeof link.source === 'string') link.source = byId.get(link.source);
      if (typeof link.target === 'string') link.target = byId.get(link.target);
    }
    const groupLayer = this.g.append('g').attr('class', 'group-layer');
    this.groupSelection = groupLayer.selectAll('rect').data(this.groupBounds).enter().append('rect')
      .attr('class', 'graph-region').attr('x', g => g.x).attr('y', g => g.y).attr('width', g => g.w).attr('height', g => g.h)
      .attr('rx', 18).attr('fill', g => g.color).attr('fill-opacity', .055).attr('stroke', g => g.color).attr('stroke-opacity', .35)
      .attr('vector-effect', 'non-scaling-stroke').attr('role', 'button').attr('tabindex', 0)
      .attr('aria-label', g => `Group: ${g.label}, ${g.topicIds.length} trails`)
      .on('click', (event, group) => { event.stopPropagation(); this.selectGroup(group); })
      .on('keydown', (event, group) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selectGroup(group); } });
    const transitionLayer = this.g.append('g').attr('class', 'transition-layer');
    const membershipLayer = this.g.append('g').attr('class', 'membership-layer');
    const nodeLayer = this.g.append('g').attr('class', 'node-layer');
    this.svg.selectAll('.label-overlay').remove();
    const labelLayer = this.svg.append('g').attr('class', 'label-layer label-overlay');
    this.groupLabelSelection = labelLayer.selectAll('.group-label').data(this.groupBounds).enter().append('text')
      .attr('class', 'group-label').attr('aria-hidden', 'true')
      .on('click', (event, group) => { event.stopPropagation(); this.selectGroup(group); });
    this.membershipSelection = membershipLayer.selectAll('line').data(data.links.filter(l => l.type === 'membership')).enter().append('line')
      .attr('class', 'membership-link').attr('stroke', l => l.color).attr('stroke-opacity', .4).attr('vector-effect', 'non-scaling-stroke').attr('stroke-width', 1);
    const activateLink = (event, link) => { event.stopPropagation(); this.selectTransition(link.transition); this.zoomToNodes([link.source, link.target]); };
    this.linkSelection = transitionLayer.selectAll('path.flow-link').data(data.transitionLinks).enter().append('path')
      .attr('class', 'flow-link').attr('fill', 'none').attr('stroke', 'var(--text-dim, #a5b1c5)')
      .attr('stroke-width', l => Math.min(3, 1 + Math.sqrt(l.weight) / 3)).attr('vector-effect', 'non-scaling-stroke').attr('stroke-opacity', .5)
      .attr('marker-end', l => `url(#flow-arrow-${l.transition.type})`).attr('role', 'button').attr('tabindex', 0)
      .attr('aria-label', l => `${l.transition.sourceLabel} to ${l.transition.targetLabel}, ${l.weight} recorded sequences`)
      .on('click', activateLink).on('keydown', (event, link) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateLink(event, link); } })
      .on('mouseover', (event, link) => this.showTooltip(event, this.transitionTooltip(link.transition))).on('mouseout', () => this.hideTooltip());
    this.flowHitSelection = transitionLayer.selectAll('path.flow-hit').data(data.transitionLinks).enter().append('path')
      .attr('class', 'flow-hit').attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 14).attr('vector-effect', 'non-scaling-stroke')
      .on('click', activateLink).on('mouseover', (event, link) => this.showTooltip(event, this.transitionTooltip(link.transition))).on('mouseout', () => this.hideTooltip());
    const activateNode = (event, node) => { event.stopPropagation(); this.openNode(node); };
    this.nodeSelection = nodeLayer.selectAll('circle').data(data.nodes).enter().append('circle')
      .attr('class', n => n.type === 'topic' ? 'topic-node' : n.type === 'collection' ? 'collection-node' : 'page-node')
      .attr('fill', n => n.type === 'topic' ? n.color : 'var(--panel, #fff)').attr('stroke', n => n.color)
      .attr('stroke-width', n => n.type === 'collection' ? 2 : 1.5).attr('vector-effect', 'non-scaling-stroke')
      .attr('stroke-dasharray', n => n.type === 'collection' ? '4 3' : null)
      .attr('role', 'button').attr('tabindex', 0)
      .attr('aria-label', n => n.type === 'topic' ? `Trail: ${n.label}, ${n.topic.pageCount} pages` : n.type === 'collection' ? n.label : `Page: ${n.page.title}`)
      .on('click', activateNode).on('keydown', (event, node) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateNode(event, node); } if (event.key === 'Escape') this.clearSelection(); })
      .on('mouseover', (event, node) => {
        this.hoveredId = node.id;
        this.showTooltip(event, node.type === 'topic' ? this.topicTooltip(node.topic) : node.type === 'collection' ? 'Pages without a trail. Select to browse every page.' : this.pageTooltip(node.page));
        this.updateLevelOfDetail(this.currentScale);
      }).on('mouseout', () => { this.hoveredId = null; this.hideTooltip(); this.updateLevelOfDetail(this.currentScale); })
      .call(d3.drag().on('start', (e,n) => this.dragStarted(e,n)).on('drag', (e,n) => this.dragged(e,n)).on('end', (e,n) => this.dragEnded(e,n)));
    this.labelSelection = labelLayer.selectAll('.node-label').data(data.nodes).enter().append('text')
      .attr('class', n => n.type === 'page' ? 'page-label' : 'topic-label').attr('aria-hidden', 'true')
      .text(n => truncate(n.label, n.type === 'collection' ? 30 : roots.length > 60 ? 21 : 30)).on('click', activateNode);
    this.labelWidths = new Map();
    this.labelCharLimit = null;
    this.updatePositions = () => {
      this.nodeSelection.attr('cx', n => n.x).attr('cy', n => n.y);
      this.membershipSelection.attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
      this.updateLevelOfDetail(this.currentScale);
    };
    this.updatePositions();
    this.fitToViewport(true);
  }

  atlasFrame(title, subtitle, back=false) {
    const atlas=document.getElementById('graph-atlas');
    if(!atlas)return document.getElementById('evidence-panel');
    document.querySelector('.workspace').hidden=true;atlas.hidden=false;atlas.replaceChildren();
    const head=document.createElement('div');head.className='atlas-heading';
    const text=document.createElement('div'),h=document.createElement('h2'),p=document.createElement('p');h.textContent=title;p.textContent=subtitle;text.append(h,p);head.append(text);
    if(back){const b=document.createElement('button');b.type='button';b.className='graph-back';b.textContent='← All trails';b.addEventListener('click',()=>{document.getElementById('graph-search').value='';this.clearSelection();});head.prepend(b);}
    atlas.append(head);return atlas;
  }

  renderAtlas() {
    if(!document.getElementById('graph-atlas')){this.renderDefaultEvidence(this.analysis);return;}
    this.selected=null;this.focusIds=null;
    const related=this.graphData.groups.filter(g=>g.related),others=this.graphData.groups.filter(g=>!g.related);
    const atlas=this.atlasFrame('Find a place to return to', `${this.visibleTopicCount} trails, organized by related titles. Choose a group, then a trail to explore its pages.`);
    const all=document.createElement('button');all.type='button';all.className='atlas-all';all.textContent='Browse all trails ↗';
    all.addEventListener('click',()=>{const frame=this.atlasFrame('All trails',`${this.visibleTopicCount} trails in this period.`,true);this.appendNodeList(frame,this.graphData.nodes.filter(n=>n.type==='topic'));});atlas.firstElementChild.append(all);
    const grid=document.createElement('div');grid.className='atlas-grid';
    for(const group of [...related,...others]) {
      const nodes=this.graphData.nodes.filter(n=>n.type==='topic'&&group.topicIds.includes(n.id));
      const card=document.createElement('button');card.type='button';card.className='atlas-group';card.setAttribute('aria-label',`Group: ${group.label}, ${nodes.length} trails`);
      card.style.setProperty('--group-color',CTStudio.topicColor(group.id));
      const top=document.createElement('div');top.className='atlas-card-heading';
      const title=document.createElement('strong');title.textContent=group.label;
      const count=document.createElement('span');count.textContent=`${nodes.length} trails`;top.append(title,count);
      const preview=document.createElement('div');preview.className='atlas-preview';
      for(const node of nodes.slice(0,3)){const row=document.createElement('span');row.textContent=node.label;preview.append(row);}
      const foot=document.createElement('span');foot.className='atlas-card-foot';foot.textContent=`${nodes.reduce((sum,n)=>sum+n.topic.visitCount,0).toLocaleString()} visits · Open group ↗`;
      card.append(top,preview,foot);card.addEventListener('click',()=>this.selectGroup(group));grid.append(card);
    }
    atlas.append(grid);
    const ungrouped=this.graphData.nodes.find(n=>n.type==='collection');
    if(ungrouped){const b=document.createElement('button');b.type='button';b.className='atlas-ungrouped';b.textContent=`${this.analysis.uncategorized.pages.length.toLocaleString()} pages without a trail`;b.addEventListener('click',()=>this.openNode(ungrouped));atlas.append(b);}
    this.appendConnectionAudit(atlas);
  }

  revealGraph() {
    const atlas=document.getElementById('graph-atlas');if(atlas){atlas.hidden=true;atlas.replaceChildren();}
    document.querySelector('.workspace').hidden=false;
    const r=document.getElementById('graph-container').getBoundingClientRect();
    this.width=r.width||this.width;this.height=r.height||this.height;this.svg.attr('width',this.width).attr('height',this.height);
  }

  layoutFocus() {
    const active=this.selected;if(!active||active.kind==='collection'||active.kind==='group')return;
    const nodes=this.graphData.nodes;
    const topicId=active.kind==='topic'?active.id:active.topicId;
    const root=nodes.find(n=>n.id===topicId)||nodes.find(n=>n.page?.id===active.id);
    if(!root)return;
    const routes=document.getElementById('show-flows')?.checked;
    const links=routes?this.graphData.transitionLinks.filter(l=>l.source.id===root.id||l.target.id===root.id).sort((a,b)=>b.weight-a.weight).slice(0,8):[];
    const neighbors=[...new Set(links.map(l=>l.source.id===root.id?l.target:l.source))];
    const pages=topicId?nodes.filter(n=>n.type==='page'&&n.parentTopicId===topicId):[];
    const chosen=pages.find(n=>n.page.id===active.id);
    const leaves=routes?neighbors:[...(chosen?[chosen]:[]),...pages.filter(n=>n!==chosen)].slice(0,8);
    this.focusIds=new Set([root.id,...leaves.map(n=>n.id)]);
    Object.assign(root,{x:-150,y:0});
    leaves.forEach((node,i)=>Object.assign(node,{x:160,y:(i-(leaves.length-1)/2)*85}));
    if(!leaves.length)Object.assign(root,{x:0,y:0});
    this.overviewMode=false;this.updatePositions();this.zoomToNodes([root,...leaves],100,true);
  }

  computeTopicAnchors(nodes) {
    this.topicAnchors.clear();
    const groups = this.graphData.groups.map(g => ({...g, nodes: nodes.filter(n => g.topicIds.includes(n.id))}));
    const collection = nodes.find(n => n.type === 'collection');
    if (collection) groups.push({id:'subject:ungrouped',label:'Pages without a trail',topicIds:[],nodes:[collection]});
    this.narrowOverview = this.width < 600 && nodes.length > 30;
    const aspect = this.width / Math.max(350, this.height), area = Math.max(12, nodes.length) * 50000;
    const w = Math.sqrt(area * aspect), h = Math.sqrt(area / aspect);
    const tree = d3.hierarchy({children:groups}).sum(g => g.nodes ? Math.max(3, g.nodes.length) : 0);
    d3.treemap().size([w,h]).paddingInner(24).round(true)(tree);
    this.groupBounds = tree.leaves().map((leaf, index) => {
      const group = leaf.data;
      const cols=this.width<340?1:2, cellWidth=(this.width-20)/cols, cellHeight=cols===1?46:80;
      const x=this.narrowOverview?(index%cols)*cellWidth-this.width/2+10:leaf.x0-w/2;
      const y=this.narrowOverview?Math.floor(index/cols)*cellHeight-Math.ceil(groups.length/cols)*cellHeight/2:leaf.y0-h/2;
      const width=this.narrowOverview?cellWidth-10:leaf.x1-leaf.x0, height=this.narrowOverview?cellHeight-10:leaf.y1-leaf.y0;
      const columns = Math.max(1, Math.ceil(Math.sqrt(group.nodes.length * Math.max(1,width-64) / Math.max(1,height-110)))) ;
      const rows = Math.ceil(group.nodes.length / columns);
      group.nodes.forEach((node,i) => this.topicAnchors.set(node.id, this.narrowOverview
        ? {x:x+(i%columns+.5)*width/columns,y:y+(Math.floor(i/columns)+.5)*height/rows}
        : {x:x+32+(i%columns+.5)*(width-64)/columns, y:y+110+(Math.floor(i/columns)+.5)*(height-150)/rows}));
      return {...group,x,y,w:width,h:height,color:group.related && globalThis.CTStudio ? CTStudio.topicColor(group.id) : 'var(--text-dim, #a5b1c5)'};
    });
  }

  anchorForNode(node) {
    const parent = this.topicAnchors.get(node.parentTopicId || 'collection:ungrouped') || {x: 0, y: 0};
    const angle = node.pageIndex * Math.PI * (3 - Math.sqrt(5));
    const radius = 65 + 18 * Math.sqrt(node.pageIndex);
    return {x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius};
  }

  renderSummary(analysis) {
    const strip = document.getElementById('summary-strip');
    const coverage = analysis.coverage;
    const categorized = analysis.categorizedCoverage || {};
    const visibleFlows = this.graphData.transitionLinks || [];
    const metric = (value, label, title) => `
      <div class="summary-card" title="${escapeAttribute(title)}">
        <span>${escapeHtml(value)}</span>
        <label>${escapeHtml(label)}</label>
      </div>
    `;
    strip.innerHTML = `
      ${metric(`${this.visibleTopicCount || analysis.topics.length} / ${analysis.topics.length}`, 'trails shown', 'Shown topics are the highest estimated-time topics selected by the Topics control.')}
      ${metric(this.graphData.nodes.filter(n => n.type === 'page').length, 'recorded pages', 'Pages available through search and selected trail detail, including ungrouped pages.')}
      ${metric(formatMinutes(categorized.estimatedActiveMinutes || 0), 'grouped estimated time', 'Estimated browsing time represented by the analyzed topic pages. Dwell is estimated from gaps and capped at 30 minutes.')}
      ${metric(visibleFlows.length, 'repeated routes', 'Directed trail pairs with at least two consecutive visit sequences. Select a trail to see its routes.')}
      <div class="summary-note">Topic coverage: ${formatPercent(categorized.activeTimeCoverage || 0)} of estimated recorded time, ${formatPercent(categorized.visitCoverage || 0)} of visits.</div>
    `;
  }

  renderLegend() {
    document.getElementById('legend').innerHTML = `
      <span class="graph-key"><i></i>Bigger circle · more visits</span>
      <span>Boxes · shared words in trail titles</span>
      <span class="graph-key flow"><i></i>Arrow · visited next, 2+ times</span>
      <span>Select a group or trail to explore</span>`;
  }

  selectGroup(group) {
    this.hideTooltip(); this.query = '';
    const search = document.getElementById('graph-search'); if (search) search.value = '';
    if (group.id === 'subject:ungrouped') { this.openNode(this.graphData.nodes.find(n => n.type === 'collection')); return; }
    this.selected = {kind:'group',id:group.id};
    const nodes = this.graphData.nodes.filter(n => n.type === 'topic' && group.topicIds.includes(n.id));
    const atlas=this.atlasFrame(group.label, group.related ? `These ${nodes.length} trails share “${group.cue}” in their titles.` : `${nodes.length} trails without a shared title match.`, true);
    const columns=document.createElement('div');columns.className='atlas-group-content';
    const list=document.createElement('div'), context=document.createElement('div');context.className='atlas-context';
    this.appendNodeList(list,nodes);this.appendSites(context,nodes.flatMap(n=>n.topic.pages));this.appendTimeline(context,group.topicIds);
    columns.append(list,context);atlas.append(columns);
  }

  appendSites(panel, pages) {
    const sites = new Map();
    for (const page of pages) {
      const row = sites.get(page.domain) || {visits:0,pages:0}; row.visits += page.visitCount; row.pages++; sites.set(page.domain,row);
    }
    const section = document.createElement('section'); section.className = 'graph-sites';
    section.innerHTML = '<h3>Busiest websites</h3>';
    const max = Math.max(1,...[...sites.values()].map(s => s.visits));
    for (const [domain, row] of [...sites].sort((a,b) => b[1].visits-a[1].visits).slice(0,8)) {
      const line = document.createElement('div'); line.className = 'graph-site-row';
      line.innerHTML = `<span>${escapeHtml(domain)}</span><small>${row.visits} visits · ${row.pages} ${row.pages===1?'page':'pages'}</small><i style="width:${row.visits/max*100}%"></i>`;
      section.append(line);
    }
    panel.append(section);
  }

  appendTimeline(panel, topicIds) {
    const ids = new Set(topicIds), rows = (this.analysis.timeline || []).map((event,index) => ({event,index}))
      .filter(({event}) => event.time >= this.analysis.coverage.startTime && event.time < this.analysis.coverage.endTime && event.topicIds.some(id => ids.has(id)));
    const details = document.createElement('details'); details.className = 'graph-record-details';
    details.innerHTML = `<summary>Browsing order · ${rows.length} visits</summary><p>Recorded page openings, in time order. This can include different tabs.</p>`;
    const list = document.createElement('ol'); list.className = 'graph-timeline';
    const more = document.createElement('button'); more.type='button'; more.className='graph-more'; let count=0;
    const append = () => {
      const end=Math.min(rows.length,count+30);
      for (;count<end;count++) {
        const {event,index}=rows[count], before=rows[count-1], li=document.createElement('li');
        const gap = before && (before.event.day !== event.day || event.time-before.event.time>1800000);
        const interrupted = before && index > before.index+1;
        li.innerHTML = `${gap ? '<small class="graph-sequence-break">Later browsing</small>' : interrupted ? '<small class="graph-sequence-break">Other pages in between</small>' : ''}<time>${escapeHtml(new Date(event.time).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</time><a href="${escapeAttribute(event.url)}" target="_blank" rel="noreferrer">${escapeHtml(event.title)}</a>`;
        list.append(li);
      }
      more.textContent=`Show more (${rows.length-count} remaining)`; more.hidden=count>=rows.length;
    };
    more.addEventListener('click',append);details.append(list,more);panel.append(details);append();
  }

  appendConnectionAudit(panel) {
    const audit = this.analysis.sequenceAudit; if (!audit) return;
    const details=document.createElement('details'); details.className='graph-record-details graph-connection-audit';
    const excluded=Object.values(audit.excluded).reduce((sum,n)=>sum+n,0);
    details.innerHTML=`<summary>How connections are counted</summary>
      <p>${audit.candidateCount} consecutive visit steps = ${excluded} excluded + ${audit.pairs.length} with both pages grouped + ${audit.uncovered} with an ungrouped page.</p>
      <p>The ${audit.uncovered} ungrouped steps contain ${audit.uniqueUngroupedPagePairs} distinct directed page pairs and ${audit.uniqueUngroupedWebsitePairs} distinct directed hostname pairs. Repeat steps count again. These are not hyperlinks.</p>
      <p>Excluded: ${audit.excluded.simultaneous} tied timestamps, ${audit.excluded.gap} gaps over 30 minutes, ${audit.excluded.dayBoundary} date boundaries, ${audit.excluded.reload} reloads, ${audit.excluded.samePage} repeated URLs, ${audit.excluded.paused} paused steps. Each step has one exclusion reason.</p>
      <p>Arrows require two steps in the same direction between trails. Same-trail steps stay inside the trail. ${this.analysis.singleTransitions} trail pairs seen only once have no arrow.</p>`;
    const examples=document.createElement('details');examples.innerHTML=`<summary>Inspect ungrouped steps (${audit.uncovered})</summary>`;
    const list=document.createElement('div'), more=document.createElement('button');more.type='button';more.className='graph-more';let count=0;
    const append=()=>{
      const rows=audit.ungroupedPairs.slice(count,count+30); count+=rows.length;
      list.insertAdjacentHTML('beforeend',transitionExamples(rows.map(p=>({...p,at:p.to.time}))));
      more.textContent=`Show more (${audit.uncovered-count} remaining)`;more.hidden=count>=audit.uncovered;
    };
    more.addEventListener('click',append);examples.append(list,more);details.append(examples);panel.append(details);
    details.addEventListener('toggle',()=>{if(details.open&&!count)append();});
  }

  openNode(node) {
    this.hideTooltip();
    const search = document.getElementById('graph-search');
    if (search) search.value = '';
    this.query = '';
    this.revealGraph();
    this.setStatus(`${this.analysis.topics.length} trails · ${this.graphData.nodes.filter(n => n.type === 'page').length} recorded pages. Selected: ${node.type === 'page' ? node.page.title : node.label}`);
    if (node.type === 'topic') { this.selectTopic(node.topic); this.zoomToTopic(node.id); }
    else if (node.type === 'collection') {
      this.selected = {kind: 'collection', id: node.id};
      const pages = this.graphData.nodes.filter(n => n.type === 'page' && !n.parentTopicId);
      const atlas=this.atlasFrame('Ungrouped pages', `${pages.length} recorded pages without a trail. Search by title or website, or browse the full list.`, true);
      this.appendNodeList(atlas,pages);this.appendConnectionAudit(atlas);
      return;
    } else {
      this.selectPage(node.page, node.parentTopicId);
      this.zoomToNodes([node], Math.min(100, this.width / 4));
    }
    this.layoutFocus();this.addOverviewButton();
  }

  addOverviewButton() {
    const panel = document.getElementById('evidence-panel');
    if (panel.querySelector('.graph-back')) return;
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'graph-back'; button.textContent = '← All trails';
    button.addEventListener('click', () => {
      const search = document.getElementById('graph-search'); if (search) search.value = '';
      this.query = ''; this.clearSelection(); this.fitToViewport();
    });
    panel.prepend(button); panel.scrollTop = 0;
  }

  appendNodeList(host, nodes) {
    const list = document.createElement('div'); list.className = 'graph-browser-list';
    const more = document.createElement('button'); more.className = 'graph-more'; more.type = 'button';
    let count = 0;
    const appendBatch = () => {
      const next = nodes.slice(count, count + 30); count += next.length;
      for (const node of next) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'graph-result';
        const dot = document.createElement('i'); dot.className = 'studio-dot'; dot.style.background = node.color;
        const text = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small');
        name.textContent = node.type === 'page' ? node.page.title : node.label;
        detail.textContent = node.type === 'topic' ? `${formatCount(node.topic.pageCount, 'page')} · ${formatMinutes(node.topic.estimatedDwellMinutes)} estimated` :
          node.type === 'collection' ? 'Browse every recorded page without a trail' : `${node.page.domain} · ${formatCount(node.page.visitCount, 'visit')}`;
        text.append(name, detail); button.append(dot, text);
        button.addEventListener('click', () => this.openNode(node)); list.append(button);
      }
      more.textContent = `Show more (${nodes.length - count} remaining)`; more.hidden = count >= nodes.length;
    };
    more.addEventListener('click', appendBatch); host.append(list, more); appendBatch();
  }

  renderBrowser(nodes, title, subtitle, back = false) {
    const panel = document.getElementById('evidence-panel'); panel.textContent = '';
    const heading = document.createElement('h2'); heading.textContent = title;
    const note = document.createElement('p'); note.className = 'graph-browser-note'; note.textContent = subtitle;
    panel.append(heading, note);
    if (nodes.length) this.appendNodeList(panel, nodes);
    else { const empty = document.createElement('p'); empty.textContent = 'No matches. Try part of a trail name, page title, or website.'; panel.append(empty); }
    if (back) this.addOverviewButton();
  }

  renderDefaultEvidence(analysis) {
    const nodes = this.graphData.nodes.filter(n => n.type !== 'page');
    const collection = nodes.find(n => n.type === 'collection');
    this.renderBrowser(collection ? [collection, ...nodes.filter(n => n !== collection)] : nodes,
      'Browse your trails', 'Select a box for related trails, or a circle for pages.');
    const details = document.createElement('details'); details.className = 'graph-record-details';
    details.innerHTML = `<summary>About this graph</summary>
      <p>Boxes use shared words in trail titles. They suggest related subjects. Saved page groupings stay the same.</p>
      <p>Circle size shows visit volume, with minimum and maximum sizes for readability. Arrows show repeated visit order across any tabs; they do not prove a link was clicked.</p>
      <p>${formatDate(analysis.coverage.startTime)} – ${formatDate(analysis.coverage.endTime)}.</p>`;
    document.getElementById('evidence-panel').append(details);
    this.appendConnectionAudit(document.getElementById('evidence-panel'));
  }

  selectTopic(topic) {
    this.selected = { kind: 'topic', id: topic.id };
    this.updateLevelOfDetail(this.currentScale);
    const panel = document.getElementById('evidence-panel');
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Selected trail</div>
        <h2>${escapeHtml(topic.label)}</h2>
        <p>${formatCount(topic.pageCount, 'page')} · ${formatCount(topic.visitCount, 'visit')} · ${formatMinutes(topic.estimatedDwellMinutes)} estimated</p>
        <button type="button" id="graph-neighborhood" class="secondary-btn">Zoom to this trail</button>
        <details class="graph-record-details"><summary>How this trail was made</summary><p>Pages grouped by their recorded content, or your saved correction.</p><p>${escapeHtml(topic.rationale)}</p><p>${formatPercent(topic.attentionShare || 0)} of grouped estimated time in this period.</p></details>
        <h3>Pages</h3>
        <div id="graph-topic-pages"></div>
        <p><a class="secondary-btn" href="${this.isDemo ? `demo.html?trail=${encodeURIComponent(topic.id)}` : `newtab.html?trail=${encodeURIComponent(topic.id)}`}">Open this trail on Home</a></p>
      </div>
    `;
    this.appendNodeList(document.getElementById('graph-topic-pages'), this.graphData.nodes.filter(n => n.parentTopicId === topic.id));
    const group = this.groupBounds.find(g => g.related && g.topicIds.includes(topic.id));
    if (group) {
      const related=document.createElement('section');related.innerHTML=`<h3>Related titles · ${escapeHtml(group.label)}</h3><p>Shared title word: “${escapeHtml(group.cue)}”.</p>`;
      this.appendNodeList(related,this.graphData.nodes.filter(n=>n.type==='topic'&&n.id!==topic.id&&group.topicIds.includes(n.id)));panel.append(related);
    }
    this.appendSites(panel, topic.pages || topic.topPages);
    this.appendTimeline(panel, [topic.id]);
    this.addOverviewButton();
    document.getElementById('graph-neighborhood').addEventListener('click', () => this.zoomToTopic(topic.id));

  }

  selectTransition(transition) {
    this.selected = { kind: 'transition', id: transition.id };
    this.updateLevelOfDetail(this.currentScale);
    const panel = document.getElementById('evidence-panel');
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Recorded connection</div>
        <h2>${escapeHtml(transition.sourceLabel)} -> ${escapeHtml(transition.targetLabel)}</h2>
        <div class="flow-type" style="border-color:${transition.color}">${escapeHtml(transition.label)}</div>

        <p>These trails were visited one after the other ${transition.visitCount} times.</p>
        <div class="metric-list">
          <div><strong>Observed transitions</strong><span>${transition.visitCount}</span></div>
          <div><strong>Days observed</strong><span>${(transition.days || []).length}</span></div>

        </div>
        <h3>Recorded page sequences</h3>
        ${transitionExamples(transition.examples?.slice(0, 20))}
        <h3>When these movements happened</h3>
        ${hourHistogram(transition.hourCounts)}
        <p>Recorded order across browser tabs. A clicked hyperlink is not verified.</p>
      </div>
    `;
    this.addOverviewButton();
  }

  selectPage(page, topicId) {
    this.selected = { kind: 'page', id: page.id, topicId };
    this.updateLevelOfDetail(this.currentScale);
    document.getElementById('evidence-panel').innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Page Evidence</div>
        <h2>${escapeHtml(page.title)}</h2>
        <div class="metric-list">
          <div><strong>Domain</strong><span>${escapeHtml(page.domain)}</span></div>
          <div><strong>Visits</strong><span>${page.visitCount}</span></div>
          <div><strong>Estimated time</strong><span>${page.estimatedDwellMinutes}m · this page in this period</span></div>
          <div><strong>Last visit</strong><span>${formatDate(page.lastVisitTime)}</span></div>
        </div>
        <a class="evidence-link" href="${escapeAttribute(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(page.url)}</a>
        ${page.reason ? `<p>Ungrouped: ${escapeHtml(page.reason.replaceAll(/[-_]/g,' '))}.</p>` : ''}
      </div>
    `;
  }

  clearSelection() {
    this.selected = null; this.focusIds=null;
    this.searchGraph();
  }

  searchGraph() {
    const query = document.getElementById('graph-search')?.value.trim().toLocaleLowerCase() || '';
    this.query = query;
    this.searchMatches = query ? this.graphData.nodes.filter(node => `${node.label} ${node.page?.title || ''} ${node.page?.url || ''}`.toLocaleLowerCase().includes(query)) : [];
    this.updateLevelOfDetail(this.currentScale);
    if (query) {
      const atlas=this.atlasFrame('Search results', `${this.searchMatches.length} matches for “${query}”`, true);
      if(this.searchMatches.length)this.appendNodeList(atlas,this.searchMatches);else {const p=document.createElement('p');p.textContent='No matching trails or pages. Try a different title or website.';atlas.append(p);}
      this.setStatus(`${this.searchMatches.length} matching trails and pages. Press Enter to inspect the first match.`);
    } else {
      if (!this.selected && this.analysis?.ok) this.renderAtlas();
      if (this.analysis?.ok) this.setStatus(`${this.analysis.topics.length} trails · ${this.graphData.nodes.filter(n => n.type === 'page').length} pages in this period.`);
    }
  }

  updateLevelOfDetail(scale) {
    this.currentScale = scale;
    document.querySelectorAll('[data-graph-mode]').forEach(b=>b.setAttribute('aria-pressed',String(document.getElementById(b.dataset.graphMode)?.checked)));
    if (!this.labelSelection || !this.nodeSelection) return;
    const transform = this.svg.node().__zoom || {x: 0, y: 0, k: scale};
    const mode = document.getElementById('graph-labels')?.value || 'auto';
    const showPages = document.getElementById('show-pages')?.checked !== false;
    const active = this.selected;
    const selectedTopic = active?.kind === 'topic' ? active.id : active?.kind === 'page' ? active.topicId : null;
    const selectedEdge = active?.kind === 'transition' ? this.analysis.transitions.find(t => t.id === active.id) : null;
    const matches = new Set((this.query ? this.searchMatches : []).map(n => n.id));
    const matchedParents = new Set((this.query ? this.searchMatches : []).map(n => n.parentTopicId).filter(Boolean));
    const related = node => !active || node.id === active.id || node.page?.id === active.id || (selectedTopic && (node.id === selectedTopic || node.parentTopicId === selectedTopic)) ||
      (active.kind === 'group' && node.groupId === active.id) ||
      (active.kind === 'collection' && (node.type === 'collection' || (node.type === 'page' && !node.parentTopicId))) ||
      (selectedEdge && [selectedEdge.sourceTopicId, selectedEdge.targetTopicId].includes(node.id));
    const visible = node => {
      if(this.focusIds && !this.focusIds.has(node.id))return false;
      if (node.type !== 'page') return !(this.narrowOverview && this.overviewMode && !active);
      if (!showPages) return false;
      if (node.page?.id === active?.id) return true;
      if (!node.parentTopicId) return active?.kind === 'collection' || (active?.kind === 'page' && !active.topicId);
      if (selectedTopic) return node.parentTopicId === selectedTopic;
      return !active && !this.overviewMode && scale >= 1.1;
    };
    this.nodeSelection.each(node => {
      node.visible = visible(node);
      node.renderRadius = (node.type === 'page' ? Math.min(8, Math.max(5, node.radius * scale)) : node.type === 'collection' ? 15 : node.radius * Math.min(1.25, Math.max(1,scale))) / scale;
    }).attr('r', n => n.renderRadius).style('display', n => n.visible ? null : 'none')
      .style('opacity', n => this.query ? (matches.has(n.id) || matches.has(n.parentTopicId) || matchedParents.has(n.id) ? 1 : .18) : related(n) ? 1 : .2)
      .attr('aria-pressed', n => String(!!active && (n.id === active.id || n.page?.id === active.id)));
    this.membershipSelection.style('display', l => l.target.visible ? null : 'none').style('opacity', l => related(l.target) ? 1 : .1);
    const path = link => flowPath(link.source, link.target, link.source.renderRadius + 4 / scale, link.target.renderRadius + 8 / scale,
      link.hasReciprocal ? (link.transition.sourceTopicId < link.transition.targetTopicId ? 1 : -1) : 0);
    const showFlow = (link,index) => active?.kind === 'transition' ? link.id === active.id
      : selectedTopic ? document.getElementById('show-flows')?.checked && this.focusIds?.has(link.source.id) && this.focusIds?.has(link.target.id) && (link.source.id === selectedTopic || link.target.id === selectedTopic)
      : active?.kind === 'group' ? link.source.groupId === active.id && link.target.groupId === active.id
      : !active && document.getElementById('show-flows')?.checked && index < this.graphData.overviewFlowLimit;
    this.linkSelection.attr('d', path).style('display', (l,i) => showFlow(l,i) ? null : 'none').style('opacity',1);
    this.flowHitSelection?.attr('d', path).style('display', (l,i) => showFlow(l,i) ? null : 'none');
    // Labels are placed in screen coordinates, tested against actual glyph
    // widths and every visible root. This applies to panning and every label
    // mode, including “More”; zooming out can never cause a text pile-up.
    const occupied = [{x:12, y:8, w:Math.min(this.width-24,340), h:44}], placements = new Map(), margin = 12;
    const intersects = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
    const screen = node => ({x: node.x * scale + transform.x, y: node.y * scale + transform.y, r: node.renderRadius * scale});
    const regionById = new Map((this.groupBounds || []).map(g => [g.id,{x:g.x*scale+transform.x,y:g.y*scale+transform.y,w:g.w*scale,h:g.h*scale}]));
    this.groupSelection?.style('display',active?'none':null).style('opacity', g => !active || active.kind==='group' && active.id===g.id || g.topicIds.includes(selectedTopic) ? 1 : .25);
    this.groupLabelSelection?.style('display','none').each((group,index,elements)=>{
      const x=group.x*scale+transform.x+12,y=group.y*scale+transform.y+12,w=group.w*scale-24;
      if (mode==='off'||w<80||x<12||y<58||x+w>this.width-12||y+24>this.height-65||active) return;
      const label=truncate(`${group.label} · ${group.topicIds.length || 'ungrouped'}`,Math.floor(w/8));
      const box={x,y,w:Math.min(w,label.length*8),h:24};
      if(occupied.some(other=>intersects(box,other)))return;
      occupied.push(box);
      d3.select(elements[index]).text(label).attr('x',x).attr('y',y+16).style('display',null);
    });
    for (const n of this.graphData.nodes.filter(n => n.visible && n.type !== 'page' && related(n))) {
      const p = screen(n); occupied.push({x:p.x-p.r-3, y:p.y-p.r-3, w:p.r*2+6, h:p.r*2+6});
    }
    const labels = [];
    const chars = this.width < 400 ? 12 : this.width < 600 ? 15 : !this.focusIds && this.visibleTopicCount > 60 ? 21 : 30;
    if (this.labelCharLimit !== chars) { this.labelSelection.text(n => truncate(n.label, n.type === 'collection' ? 30 : chars)); this.labelCharLimit = chars; }
    this.labelSelection.style('display','none').style('stroke-width', '3px').style('font-size', n => `${n.type === 'page' ? 12 : 13}px`).each((n,i,elements) => {
      if (mode === 'off' || !n.visible || (active && !related(n)) || (this.query && !matches.has(n.id) && !matchedParents.has(n.id))) return;
      if (!this.focusIds && n.type === 'page' && scale < (mode === 'all' ? .8 : 1.3) && n.page?.id !== active?.id) return;
      const point = screen(n);
      if (point.x < 0 || point.x > this.width || point.y < 0 || point.y > this.height) return;
      const element = elements[i], text = element.textContent;
      const key = `${n.type}:${text}`;
      // Measure while visible; SVG text metrics are independent of transforms.
      element.style.display = '';
      const width = this.labelWidths.get(key) || (element.getComputedTextLength ? element.getComputedTextLength() : text.length * 7);
      this.labelWidths.set(key, width); element.style.display = 'none';
      const priority = active && (n.id === active.id || n.page?.id === active.id) ? -4 : n.id === this.hoveredId ? -3 : matches.has(n.id) ? -2 : n.type === 'collection' ? -1 : n.type === 'topic' ? n.index : 10000+n.pageIndex;
      labels.push({n,element,width,priority});
    });
    labels.sort((a,b) => a.priority-b.priority);
    for (const {n,element,width} of labels) {
      const p = screen(n), height = 18, gap = p.r+7, w=width+8;
      const candidates = [
        {x:p.x+gap,y:p.y-height/2,w,h:height},
        {x:p.x-w/2,y:p.y+gap,w,h:height},
        {x:p.x-gap-w,y:p.y-height/2,w,h:height},
        {x:p.x-w/2,y:p.y-gap-height,w,h:height},
        {x:p.x+gap,y:p.y-height-5,w,h:height},
        {x:p.x+gap,y:p.y+5,w,h:height},
        {x:p.x-gap-w,y:p.y-height-5,w,h:height},
        {x:p.x-gap-w,y:p.y+5,w,h:height}
      ];
      const region = !active && this.overviewMode && n.type==='topic' ? regionById.get(n.groupId) : null;
      const box = candidates.find(b => b.x>=margin && b.y>=margin && b.x+b.w<=this.width-margin && b.y+b.h<=this.height-65 &&
        (!region || b.x>=region.x+4 && b.y>=region.y+4 && b.x+b.w<=region.x+region.w-4 && b.y+b.h<=region.y+region.h-4) &&
        !occupied.some(other => intersects(b,other)));
      if (!box) continue;
      occupied.push({x:box.x-3,y:box.y-3,w:box.w+6,h:box.h+6}); placements.set(n.id,box);
      d3.select(element).style('display',null).style('opacity',1).attr('text-anchor','start')
        .attr('x',box.x+4).attr('y',box.y+13);
    }
    this.labelPlacements = placements;
    const hint = document.getElementById('graph-view-status');
    if (hint) hint.textContent = active ? document.getElementById('show-flows')?.checked ? `${this.graphData.nodes.filter(n=>n.visible&&n.type==='topic').length-1} connected trails · repeated visit order` : `${this.graphData.nodes.filter(n=>n.visible&&n.type==='page').length} pages shown · all pages in the list` : `${this.graphData.groups.filter(g=>g.related).length} related groups · ${this.visibleTopicCount} trails`;
  }

  zoomToNodes(nodes, padding = 95, immediate = false) {
    if (!nodes.length) return;
    const x = d3.extent(nodes,n => n.x), y = d3.extent(nodes,n => n.y);
    const scale = Math.max(.05, Math.min(1.65, (this.width-padding*2)/Math.max(1,x[1]-x[0]), (this.height-padding*2)/Math.max(1,y[1]-y[0])));
    const target = d3.zoomIdentity.translate(this.width/2-(x[0]+x[1])/2*scale, this.height/2-(y[0]+y[1])/2*scale).scale(scale);
    const duration = immediate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 260;
    if (!duration) this.svg.call(this.zoom.transform,target);
    else this.svg.transition().duration(duration).call(this.zoom.transform,target);
  }

  zoomToTopic(topicId) { this.layoutFocus(); }

  fitToViewport(immediate) {
    if(this.selected) {this.layoutFocus();return;}
    this.overviewMode = true;
    this.zoomToNodes((this.groupBounds || []).flatMap(g=>[{x:g.x,y:g.y},{x:g.x+g.w,y:g.y+g.h}]), this.width < 600 ? 24 : 50, immediate);
  }

  dragStarted(event, d) {
    this.simulation?.stop();
    d.fx = d.x; d.fy = d.y;
  }

  dragged(event, d) {
    const group=this.focusIds?null:this.groupBounds.find(g=>g.nodes.some(n=>n.id===d.id));
    const x=group?Math.max(group.x+40,Math.min(group.x+group.w-40,event.x)):event.x;
    const y=group?Math.max(group.y+75,Math.min(group.y+group.h-35,event.y)):event.y;
    const dx = x - d.x, dy = y - d.y;
    d.x = d.fx = x; d.y = d.fy = y;
    if (d.type === 'topic' || d.type === 'collection') {
      this.topicAnchors.set(d.id, { x: d.x, y: d.y });
      for (const page of this.graphData.nodes.filter(n => n.parentTopicId === d.id || (d.type === 'collection' && n.type === 'page' && !n.parentTopicId))) {
        page.x += dx; page.y += dy; page.fx = page.x; page.fy = page.y;
      }
    }
    this.updatePositions();
  }

  dragEnded(event, d) {
    for (const node of this.graphData.nodes) if (node.id === d.id || node.parentTopicId === d.id) this.savedPositions.set(node.id, { x: node.x, y: node.y, fx: node.x, fy: node.y });
  }

  setLoading(visible, message) {
    const loading = document.getElementById('loading');
    loading.style.display = visible ? 'block' : 'none';
    if (message) loading.textContent = message;
  }

  showProgress(message) {
    this.setLoading(true, message);
    this.setStatus(message);
    if (/ollama/i.test(message)) this.setHealth('checking', 'Checking Ollama');
    else if (/embedding|labeling|auditing|analyzing/i.test(message)) this.setHealth('checking', 'Analyzing locally');
    else if (/history|visits/i.test(message)) this.setHealth('checking', 'Reading history');
  }

  setStatus(message) {
    document.getElementById('status-line').textContent = message;
    document.title = `Cognitive Trails - ${String(message || '').slice(0, 70)}`;
  }

  setHealth(state, label) {
    const pill = document.getElementById('health-pill');
    pill.textContent = label;
    pill.className = `health-pill ${state}`;
  }

  showTooltip(event, html) {
    const tooltip = d3.select('#tooltip')
      .style('display', 'block')
      .style('position', 'fixed')
      .style('max-width', `${Math.min(230, window.innerWidth - 32)}px`)
      .style('opacity', 1)
      .html(html);
    const box = tooltip.node().getBoundingClientRect();
    tooltip.style('left', `${Math.max(8, Math.min(event.clientX + 12, window.innerWidth - box.width - 12))}px`)
      .style('top', `${Math.max(8, Math.min(event.clientY + 12, window.innerHeight - box.height - 12))}px`);
  }

  hideTooltip() {
    d3.select('#tooltip').style('opacity', 0).style('display', 'none');
  }

  topicTooltip(topic) {
    return `<strong>${escapeHtml(topic.label)}</strong><br>${formatCount(topic.pageCount, 'page')} · ${formatCount(topic.visitCount, 'visit')}<br>${formatMinutes(topic.estimatedDwellMinutes)} estimated`;
  }

  pageTooltip(page) {
    return `<strong>${escapeHtml(page.domain)}</strong><br>${escapeHtml(page.title)}<br>${page.visitCount} visits`;
  }

  transitionTooltip(transition) {
    return `<strong>${escapeHtml(transition.sourceLabel)} -> ${escapeHtml(transition.targetLabel)}</strong><br>${escapeHtml(transition.label)}<br>${transition.visitCount} consecutive visits<br>on ${(transition.days || []).length} day(s)${transition.uncertain ? ' · label uncertain' : ''}`;
  }
}

function flowPath(source, target, sourcePadding, targetPadding, bend) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const x1 = source.x + ux * sourcePadding;
  const y1 = source.y + uy * sourcePadding;
  const x2 = target.x - ux * targetPadding;
  const y2 = target.y - uy * targetPadding;
  if (!bend) return `M${x1},${y1} L${x2},${y2}`;
  // The (ux, uy) unit vector negates when source/target swap, so combining it
  // with a sign that also flips per-direction (bend) would cancel out and put
  // both edges of a reciprocal pair on the same side. A position-based flip
  // (independent of which node is "source" for this particular link) keeps
  // the two directions bowing to opposite sides instead.
  const canonicalFlip = (source.x > target.x || (source.x === target.x && source.y > target.y)) ? -1 : 1;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const offset = Math.min(38, distance * 0.18) * bend * canonicalFlip;
  const cx = midX + -uy * offset;
  const cy = midY + ux * offset;
  return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
}

// Evidence strength renders as a bar with a coarse word, never a number:
// the heuristic score ranks clusters for the audit gate, it is not a
// probability the record can honestly display (spec D4).
function confidenceBar(confidence) {
  const value = Math.max(0, Math.min(1, confidence || 0));
  const strength = value >= 0.75 ? 'strong' : value >= 0.55 ? 'moderate' : 'limited';
  return `
    <div class="confidence">
      <div class="confidence-meta"><span>Evidence</span><strong>${strength}</strong></div>
      <div class="confidence-track"><div style="width:${Math.round(value * 100)}%"></div></div>
    </div>
  `;
}

function hourHistogram(hourCounts) {
  const counts = Array.isArray(hourCounts) ? hourCounts : [];
  const max = Math.max(1, ...counts);
  if (!counts.some(Boolean)) return '<p>No hour-of-day detail recorded.</p>';
  return `<div class="hour-histogram">${counts.map((count, hour) => `
    <span title="${hour}:00 - ${count} movement(s)" style="height:${Math.round((count / max) * 100)}%"></span>
  `).join('')}</div><div class="hour-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
}

function pageList(pages) {
  if (!pages || !pages.length) return '<p>No page evidence available.</p>';
  return `<ul class="evidence-list">${pages.map(page => `
    <li>
      <strong>${escapeHtml(page.title)}</strong>
      <span>${escapeHtml(page.domain)} · ${page.visitCount} visits · ${page.estimatedDwellMinutes}m estimated</span>
    </li>
  `).join('')}</ul>`;
}

function transitionExamples(items) {
  if (!items || !items.length) return '<p>No representative visits available.</p>';
  return `<ul class="evidence-list">${items.map(item => `
    <li>
      <a href="${escapeAttribute(item.from.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.from.title)}</a>
      <span>→ <a href="${escapeAttribute(item.to.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.to.title)}</a></span>
      ${item.at ? `<small>${escapeHtml(formatDate(item.at))}</small>` : ''}
    </li>
  `).join('')}</ul>`;
}

function formatCount(value, noun) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function formatDate(ms) {
  if (!ms) return 'n/a';
  return new Date(ms).toLocaleString();
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'earlier';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function truncate(text, limit) {
  const value = String(text || '');
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

// ---- module surface ------------------------------------------------------
// Exported so a headless test can construct the visualizer against a seeded
// store. Nothing in the class touches chrome.* on the render path.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TopicMapVisualizer };
} else {
  globalThis.CTMap = { TopicMapVisualizer };
}

// Extension and read-only sample boot use the same map renderer.
if (typeof document !== 'undefined' && (typeof module === 'undefined' || !module.exports)) {
  CTStudio.onPage('map.html', async () => {
    if (typeof d3 === 'undefined') { document.getElementById('loading').textContent = 'Map library unavailable. Reload this page.'; return; }
    if (new URLSearchParams(location.search).get('demo') !== '1') { const view=new TopicMapVisualizer();window.CTPageDispose=()=>view.dispose();await view.ready;return; }
    try {
      const response = await fetch('../fixtures/current/snapshot.json');
      if (!response.ok) throw new Error('Sample record is unavailable.');
      const snapshot = await response.json();
      const store = { open: async () => {}, getAll: async name => snapshot[name] || [],
        get: async (name, key) => (snapshot[name] || []).find(r => r.key === key) || null,
        getSettingsMap: async () => Object.fromEntries((snapshot.settings || []).map(r => [r.key, r.value])),
        range: (lower, upper) => ({ lower, upper }),
        byIndex: async (name, index, query) => (snapshot[name] || []).filter(r => !query || (r.dayKey >= query.lower && r.dayKey <= query.upper)) };
      const lastDay = (snapshot.daily_metrics || []).map(r => r.day).sort().pop();
      for (const a of document.querySelectorAll('.buttons a')) {
        a.href = a.textContent === 'Audit' ? 'demo.html?view=audit' : a.textContent === 'Settings' ? 'demo.html?view=setup' : 'demo.html';
      }
      const view=new TopicMapVisualizer({ store, now: CTText.dayKeyToNoonMs(lastDay) + 9 * 3600000, isDemo: true });window.CTPageDispose=()=>view.dispose();await view.ready;
    } catch (error) { document.getElementById('loading').textContent = error.message; }
  });
}
