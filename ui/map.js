const FLOW_COLORS = CTMapData.TRANSITION_TYPES;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// The graph is a constellation: every trail is a circle, related titles share
// a soft halo, and arrows are repeated recorded sequences. Layout is seeded
// and fixed-length, so the same record always draws the same map.
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
    this.graphData = { nodes: [], links: [], transitionLinks: [], groups: [] };
    this.currentScale = 1;
    this.selected = null;
    this.savedPositions = new Map();
    this.initialTrail = new URLSearchParams(window.location.search).get('trail');
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
    // Arrowheads are sized in user space so thick lines don't produce giant arrows.
    for (const type of Object.keys(FLOW_COLORS)) {
      defs.append('marker')
        .attr('id', `flow-arrow-${type}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 9)
        .attr('refY', 0)
        .attr('markerWidth', 11)
        .attr('markerHeight', 11)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4.5 L10,0 L0,4.5 L2.5,0 Z')
        .attr('fill', 'var(--text-dim, #a9b2c4)');
    }

    this.g = this.svg.append('g');
    this.zoom = d3.zoom()
      .scaleExtent([0.08, 5])
      // When the inspector sits below the canvas, a plain wheel scrolls the
      // page; pinch or Ctrl/⌘ + wheel still zooms the map.
      .filter(event => (!event.ctrlKey || event.type === 'wheel') && !event.button &&
        (event.type !== 'wheel' || event.ctrlKey || event.metaKey || !this.stackedLayout()))
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
    // A click on empty canvas returns to the overview; d3-zoom suppresses the
    // click that ends a pan, so dragging the map never clears a selection.
    this.svg.on('click', event => {
      this.hideTooltip();
      if (event.target === this.svg.node() && this.selected) this.clearSelection();
    });
  }

  stackedLayout() {
    const workspace = document.querySelector('.workspace');
    return !!workspace && getComputedStyle(workspace).gridTemplateColumns.trim().split(/\s+/).length < 2;
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
    for (const id of ['show-pages', 'show-flows']) document.getElementById(id)?.addEventListener('change', () => this.updateLevelOfDetail(this.currentScale));
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
      <button class="zoom-control" type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
      <button class="zoom-control" type="button" data-zoom="reset" aria-label="Fit every trail in view" title="Fit every trail in view">Fit</button>
      <button class="zoom-control" type="button" data-zoom="clear" aria-label="Clear selection" title="Clear selection">Clear</button>
    `;
    container.appendChild(controls);
    const modes=document.createElement('div');modes.className='graph-focus-tabs';modes.setAttribute('role','group');modes.setAttribute('aria-label','Map detail');
    for(const [label,id] of [['Pages','show-pages'],['Connections','show-flows']]) {
      const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.graphMode=id;
      button.addEventListener('click',()=>{const input=document.getElementById(id);input.checked=!input.checked;input.dispatchEvent(new Event('change'));});modes.append(button);
    }
    container.append(modes);
    controls.addEventListener('click', event => {
      const action = event.target.dataset.zoom;
      if (!action) return;
      if (action === 'in' || action === 'out') this.overviewMode = false;
      if (action === 'in') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1.6);
      if (action === 'out') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1 / 1.6);
      if (action === 'reset' || action === 'clear') {
        const search = document.getElementById('graph-search'); if (search) search.value = '';
        this.query = ''; this.clearSelection();
        if (action === 'reset') this.fitToViewport();
      }
    });
  }

  handleResize() {
    this.hideTooltip();
    const rect = document.getElementById('graph-container').getBoundingClientRect();
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;
    this.svg.attr('width', this.width).attr('height', this.height);
    if (!this.updatePositions) return;
    if (this.selected) this.updateLevelOfDetail(this.currentScale); else this.fitToViewport(true);
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
      this.setHealth('ok', this.isDemo ? 'Recorded sample' : `Grouped ${timeAgo(analysis.generatedAt)}`);
      this.renderAnalysis(analysis);
      this.setLoading(false);
      this.openInitialTrail();
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

  // A trail link from Home or Your trails opens that trail once.
  openInitialTrail() {
    const id = this.initialTrail; this.initialTrail = null;
    const node = id && this.graphData.nodes.find(n => n.type === 'topic' && n.id === id);
    if (node) this.openNode(node);
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
      <button type="button" id="staleness-dismiss" class="banner-dismiss" title="Dismiss" aria-label="Dismiss">×</button>
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
    this.graphData = { nodes: [], links: [], transitionLinks: [], groups: [] };
    this.selected = null;
    this.searchMatches = [];
    this.nodeSelection = this.labelSelection = this.haloSelection = this.groupLabelSelection = this.updatePositions = null;
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
    for (const node of this.graphData.nodes) if (Number.isFinite(node.x)) this.savedPositions.set(node.id, { x: node.x, y: node.y });
    this.selected = null;
    this.graphData = this.buildGraphData(analysis);
    this.renderSummary(analysis);
    this.renderLegend();
    this.renderGraph(this.graphData);
    this.searchGraph();
    const when = this.isDemo ? ' Synthetic sample, March 2026.' : analysis.generatedAt ? ` Grouped ${timeAgo(analysis.generatedAt)}.` : '';
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
    // Circle area follows visit count, within readable bounds.
    const topicRadius = d3.scaleSqrt()
      .domain([0, Math.max(8, d3.max(visibleTopics, topic => topic.visitCount) || 1)])
      .range([7, 30]);
    // Trails keep the same color here as on Home and Your trails.
    const colorFor = topic => globalThis.CTStudio ? CTStudio.topicColor(topic.id) : topic.color;
    const topicNodes = visibleTopics.map((topic, index) => ({
      id: topic.id,
      type: 'topic',
      topic,
      label: topic.label,
      color: colorFor(topic),
      attentionBand: topic.attentionBand,
      attentionRank: topic.attentionRank,
      radius: Math.max(8, topicRadius(topic.visitCount)),
      index
    }));
    const nodeById = new Map(topicNodes.map(n => [n.id, n]));
    const groups = CTMapData.buildTopicGroups(visibleTopics);
    for (const group of groups) {
      const members = group.topicIds.map(id => nodeById.get(id));
      for (const member of members) member.groupId = group.id;
      // A halo takes the color of its busiest trail.
      group.color = members.slice().sort((a, b) => b.topic.visitCount - a.topic.visitCount || a.id.localeCompare(b.id))[0].color;
    }

    const maxPageVisits = d3.max(visibleTopics, topic => d3.max(topic.topPages, page => page.visitCount)) || 1;
    const pageRadius = d3.scaleSqrt().domain([0, maxPageVisits]).range([3.5, 9]);
    const pageNodes = [];
    const membershipLinks = [];
    for (const topic of visibleTopics) {
      const parent = nodeById.get(topic.id);
      for (const [pageIndex, page] of (topic.pages || topic.topPages).entries()) {
        const node = {
          id: `${topic.id}:${page.id}`,
          type: 'page',
          pageIndex,
          page,
          parentTopicId: topic.id,
          label: page.title,
          groupId: parent.groupId,
          color: parent.color,
          radius: Math.max(3.5, pageRadius(page.visitCount))
        };
        pageNodes.push(node);
        membershipLinks.push({ id: `member:${topic.id}:${page.id}`, type: 'membership', source: topic.id, target: node.id, color: parent.color });
      }
    }

    for (const [pageIndex, page] of (analysis.uncategorized?.pages || []).entries()) {
      pageNodes.push({ id: `ungrouped:${page.id}`, type: 'page', page, pageIndex, parentTopicId: null, label: page.title, color: 'var(--text-faint, #838da1)', radius: 3.5 });
    }
    const crossTopic = analysis.transitions.filter(t =>
      t.sourceTopicId !== t.targetTopicId &&
      visibleTopicIds.has(t.sourceTopicId) &&
      visibleTopicIds.has(t.targetTopicId)
    );
    // When both directions between two topics are visible (A->B and B->A),
    // straight lines overlap almost exactly. Curve each one so both remain
    // legible instead of looking like one line with an arrow on each end.
    const keys = new Set(crossTopic.map(t => `${t.sourceTopicId}->${t.targetTopicId}`));
    const transitionLinks = crossTopic.map(transition => ({
      id: transition.id,
      type: 'transition',
      source: transition.sourceTopicId,
      target: transition.targetTopicId,
      transition,
      weight: transition.visitCount,
      hasReciprocal: keys.has(`${transition.targetTopicId}->${transition.sourceTopicId}`)
    }));
    const collection = analysis.uncategorized?.pages?.length
      ? [{ id: 'collection:ungrouped', type: 'collection', label: `${analysis.uncategorized.pages.length} pages without a trail`, color: 'var(--text-faint, #838da1)', radius: 18, index: topicNodes.length }]
      : [];
    return {
      nodes: [...topicNodes, ...collection, ...pageNodes],
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
    this.layoutConstellation(data);
    for (const node of data.nodes.filter(n => n.type === 'page')) Object.assign(node, this.anchorForNode(node));
    const byId = new Map(data.nodes.map(n => [n.id, n]));
    for (const link of data.links) {
      if (typeof link.source === 'string') link.source = byId.get(link.source);
      if (typeof link.target === 'string') link.target = byId.get(link.target);
    }
    const related = data.groups.filter(g => g.related);
    const haloLayer = this.g.append('g').attr('class', 'halo-layer');
    this.haloSelection = haloLayer.selectAll('path').data(related).enter().append('path')
      .attr('class', 'graph-region').attr('fill', g => g.color).attr('stroke', g => g.color)
      .attr('vector-effect', 'non-scaling-stroke').attr('role', 'button').attr('tabindex', 0)
      .attr('aria-label', g => `Related titles: ${g.label}, ${g.topicIds.length} trails`)
      .on('click', (event, group) => { event.stopPropagation(); this.selectGroup(group); })
      .on('keydown', (event, group) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selectGroup(group); } });
    const transitionLayer = this.g.append('g').attr('class', 'transition-layer');
    const membershipLayer = this.g.append('g').attr('class', 'membership-layer');
    const nodeLayer = this.g.append('g').attr('class', 'node-layer');
    this.svg.selectAll('.label-overlay').remove();
    const labelLayer = this.svg.append('g').attr('class', 'label-layer label-overlay');
    this.groupLabelSelection = labelLayer.selectAll('.group-label').data(related).enter().append('text')
      .attr('class', 'group-label').attr('aria-hidden', 'true').style('fill', g => g.color)
      .on('click', (event, group) => { event.stopPropagation(); this.selectGroup(group); });
    this.membershipSelection = membershipLayer.selectAll('line').data(data.links.filter(l => l.type === 'membership')).enter().append('line')
      .attr('class', 'membership-link').attr('stroke', l => l.color).attr('vector-effect', 'non-scaling-stroke').attr('stroke-width', 1);
    const activateLink = (event, link) => { event.stopPropagation(); this.selectTransition(link.transition); this.zoomToNodes([link.source, link.target], 110); };
    this.linkSelection = transitionLayer.selectAll('path.flow-link').data(data.transitionLinks).enter().append('path')
      .attr('class', 'flow-link').attr('fill', 'none')
      .attr('stroke-width', l => Math.min(3.2, 1 + Math.sqrt(l.weight) / 3)).attr('vector-effect', 'non-scaling-stroke')
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
      .attr('fill', n => n.type === 'topic' ? n.color : null).attr('stroke', n => n.type === 'page' ? n.color : null)
      .attr('vector-effect', 'non-scaling-stroke')
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
      .text(n => truncate(n.label, 30)).on('click', activateNode);
    this.labelWidths = new Map();
    this.labelCharLimit = null;
    this.updatePositions = () => {
      this.nodeSelection.attr('cx', n => n.x).attr('cy', n => n.y);
      this.membershipSelection.attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
      this.updateHalos();
      this.updateLevelOfDetail(this.currentScale);
    };
    this.updatePositions();
    this.fitToViewport(true);
  }

  // Groups of related titles, then every other trail, take slots on a
  // sunflower spiral: the largest groups sit near the middle and the layout
  // fills a disc without a grid. A short, seeded force relaxation then pulls
  // repeatedly sequenced trails together and removes overlaps.
  layoutConstellation(data) {
    const topics = data.nodes.filter(n => n.type === 'topic');
    const byId = new Map(topics.map(n => [n.id, n]));
    const slots = data.groups.filter(g => g.related).map(g => ({ id: g.id, members: g.topicIds.map(id => byId.get(id)).filter(Boolean), related: true }));
    const grouped = new Set(slots.flatMap(s => s.members.map(n => n.id)));
    for (const node of topics) if (!grouped.has(node.id)) slots.push({ id: node.id, members: [node], related: false });
    const weight = slot => slot.members.reduce((sum, n) => sum + n.topic.visitCount, 0);
    slots.sort((a, b) => b.members.length - a.members.length || weight(b) - weight(a) || a.id.localeCompare(b.id));
    let area = 0;
    slots.forEach((slot, index) => {
      const size = slot.members.reduce((sum, n) => sum + (n.radius + 24) ** 2, 0);
      const distance = Math.sqrt((area + size / 2) / Math.PI) * 1.9;
      area += size;
      const angle = index * GOLDEN_ANGLE;
      slot.x = Math.cos(angle) * distance; slot.y = Math.sin(angle) * distance;
      for (const node of slot.members) {
        const kept = this.savedPositions.get(node.id);
        node.slotX = slot.x; node.slotY = slot.y; node.related = slot.related;
        node.x = kept ? kept.x : slot.x + (hashUnit(node.id) - .5) * 48;
        node.y = kept ? kept.y : slot.y + (hashUnit(`${node.id}:y`) - .5) * 48;
        node.fx = node.fy = null; node.vx = node.vy = 0;
      }
    });
    const links = data.transitionLinks.map(l => ({ source: typeof l.source === 'string' ? l.source : l.source.id, target: typeof l.target === 'string' ? l.target : l.target.id, weight: l.weight }));
    const simulation = d3.forceSimulation(topics)
      .force('slot-x', d3.forceX(n => n.slotX).strength(n => n.related ? .2 : .07))
      .force('slot-y', d3.forceY(n => n.slotY).strength(n => n.related ? .2 : .07))
      .force('link', d3.forceLink(links).id(n => n.id).distance(l => 60 + l.source.radius + l.target.radius).strength(l => Math.min(.3, .07 * Math.log1p(l.weight))))
      .force('charge', d3.forceManyBody().strength(-30).distanceMax(240))
      .force('collide', d3.forceCollide(n => n.radius + 16).strength(.95).iterations(2))
      .stop();
    if (typeof simulation.randomSource === 'function' && typeof d3.randomLcg === 'function') simulation.randomSource(d3.randomLcg(0.42));
    simulation.tick(Math.min(420, 160 + topics.length * 2));
    for (const node of topics) { node.vx = node.vy = 0; }
    const collection = data.nodes.find(n => n.type === 'collection');
    if (collection) {
      const extent = Math.max(160, ...topics.map(n => Math.hypot(n.x, n.y) + n.radius));
      const kept = this.savedPositions.get(collection.id);
      collection.x = kept ? kept.x : extent * .74 + 70;
      collection.y = kept ? kept.y : extent * .74 + 40;
    }
  }

  // Halos are smoothed hulls around each related group's circles.
  updateHalos() {
    if (!this.haloSelection) return;
    const byId = new Map(this.graphData.nodes.map(n => [n.id, n]));
    const line = d3.line().curve(d3.curveCatmullRomClosed.alpha(.9));
    this.haloSelection.attr('d', group => {
      const points = [];
      for (const id of group.topicIds) {
        const node = byId.get(id); if (!node) continue;
        const pad = node.radius + 24;
        for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; points.push([node.x + Math.cos(a) * pad, node.y + Math.sin(a) * pad]); }
      }
      const hull = d3.polygonHull(points) || points;
      const xs = hull.map(p => p[0]), ys = hull.map(p => p[1]);
      group.bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      return line(hull);
    });
  }

  anchorForNode(node) {
    const parent = this.graphData.nodes.find(n => n.id === (node.parentTopicId || 'collection:ungrouped')) || { x: 0, y: 0, radius: 10 };
    const angle = node.pageIndex * GOLDEN_ANGLE;
    const radius = parent.radius + 30 + 14 * Math.sqrt(node.pageIndex);
    return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
  }

  renderSummary(analysis) {
    const strip = document.getElementById('summary-strip');
    const categorized = analysis.categorizedCoverage || {};
    const visibleFlows = this.graphData.transitionLinks || [];
    const metric = (value, label, title) => `
      <div class="summary-card" title="${escapeAttribute(title)}">
        <span>${escapeHtml(value)}</span>
        <label>${escapeHtml(label)}</label>
      </div>
    `;
    strip.innerHTML = `
      ${metric(`${this.visibleTopicCount || analysis.topics.length} / ${analysis.topics.length}`, 'trails shown', 'Shown topics are the highest estimated-time topics selected by the Trails control.')}
      ${metric(this.graphData.nodes.filter(n => n.type === 'page').length, 'recorded pages', 'Pages available through search and selected trail detail, including ungrouped pages.')}
      ${metric(formatMinutes(categorized.estimatedActiveMinutes || 0), 'grouped estimated time', 'Estimated browsing time represented by the analyzed topic pages. Dwell is estimated from gaps and capped at 30 minutes.')}
      ${metric(visibleFlows.length, 'repeated routes', 'Directed trail pairs with at least two consecutive visit sequences. Select a trail to see its routes.')}
      <div class="summary-note">Grouped: ${formatPercent(categorized.activeTimeCoverage || 0)} of estimated recorded time, ${formatPercent(categorized.visitCoverage || 0)} of visits.</div>
    `;
  }

  renderLegend() {
    document.getElementById('legend').innerHTML = `
      <span class="graph-key"><i></i>Larger circle · more visits</span>
      <span class="graph-key halo"><i></i>Halo · shared words in trail titles</span>
      <span class="graph-key flow"><i></i>Arrow · visited next, 2+ times</span>`;
  }

  // The inspector beside the canvas. Every view starts from a fresh frame.
  panelFrame(title, subtitle, kicker, back = true) {
    const panel = document.getElementById('evidence-panel'); panel.textContent = ''; panel.scrollTop = 0;
    const section = document.createElement('div'); section.className = 'evidence-section';
    if (kicker) { const k = document.createElement('div'); k.className = 'panel-kicker'; k.textContent = kicker; section.append(k); }
    const heading = document.createElement('h2'); heading.textContent = title;
    const note = document.createElement('p'); note.className = 'graph-browser-note'; note.textContent = subtitle;
    section.append(heading, note); panel.append(section);
    if (back) this.addOverviewButton();
    return section;
  }

  selectGroup(group) {
    this.hideTooltip(); this.query = '';
    const search = document.getElementById('graph-search'); if (search) search.value = '';
    this.selected = { kind: 'group', id: group.id };
    const nodes = this.graphData.nodes.filter(n => n.type === 'topic' && group.topicIds.includes(n.id));
    const section = this.panelFrame(group.label, `${nodes.length} trails share “${group.cue}” in their titles. This is a visual grouping; saved trails are unchanged.`, 'Related titles');
    this.appendNodeList(section, nodes);
    this.appendSites(section, nodes.flatMap(n => n.topic.pages || n.topic.topPages));
    this.appendTimeline(section, group.topicIds);
    this.updateLevelOfDetail(this.currentScale);
    this.zoomToNodes(nodes.flatMap(n => [{ x: n.x - n.radius, y: n.y - n.radius }, { x: n.x + n.radius, y: n.y + n.radius }]), 110);
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
    this.setStatus(`${this.analysis.topics.length} trails · ${this.graphData.nodes.filter(n => n.type === 'page').length} recorded pages. Selected: ${node.type === 'page' ? node.page.title : node.label}`);
    if (node.type === 'topic') { this.selectTopic(node.topic); this.focusTopic(node.id); }
    else if (node.type === 'collection') {
      this.selected = { kind: 'collection', id: node.id };
      const pages = this.graphData.nodes.filter(n => n.type === 'page' && !n.parentTopicId);
      const section = this.panelFrame('Pages without a trail', `${pages.length} recorded pages have no trail. Search by title or website, or browse the full list.`, 'Loose pages');
      this.appendNodeList(section, pages); this.appendConnectionAudit(section);
      this.updateLevelOfDetail(this.currentScale);
      this.zoomToNodes([node, ...pages.slice(0, 120)], 60);
    } else {
      this.selectPage(node.page, node.parentTopicId);
      this.updateLevelOfDetail(this.currentScale);
      this.zoomToNodes([node, ...(node.parentTopicId ? [this.graphData.nodes.find(n => n.id === node.parentTopicId)] : [])], Math.min(140, this.width / 4));
      this.addOverviewButton();
    }
  }

  // Selection zooms to the trail and its page satellites; nothing moves.
  focusTopic(topicId) {
    const root = this.graphData.nodes.find(n => n.id === topicId); if (!root) return;
    const pages = document.getElementById('show-pages')?.checked !== false ? this.graphData.nodes.filter(n => n.parentTopicId === topicId) : [];
    this.overviewMode = false;
    this.zoomToNodes([root, ...pages], 90);
  }

  zoomToTopic(topicId) { this.focusTopic(topicId); }

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

  renderDefaultEvidence(analysis) {
    const topics = this.graphData.nodes.filter(n => n.type === 'topic');
    const collection = this.graphData.nodes.find(n => n.type === 'collection');
    const section = this.panelFrame('All trails', `${topics.length} trails in the last ${analysis.windowDays || this.windowDays || 30} days, busiest first. Select a circle, a halo, or a row.`, 'Browse', false);
    this.appendNodeList(section, collection ? [...topics, collection] : topics);
    const details = document.createElement('details'); details.className = 'graph-record-details';
    details.innerHTML = `<summary>About this map</summary>
      <p>Circle size shows recorded visits, within readable limits. Halos group trails whose titles share a distinctive word; they suggest related subjects and leave saved trails unchanged.</p>
      <p>Arrows show repeated visit order across any tabs; they do not prove a link was clicked. Positions come from these relationships, not from time.</p>
      <p>${formatDate(analysis.coverage.startTime)} – ${formatDate(analysis.coverage.endTime)}.</p>`;
    section.append(details);
    this.appendConnectionAudit(section);
  }

  selectTopic(topic) {
    this.selected = { kind: 'topic', id: topic.id };
    this.updateLevelOfDetail(this.currentScale);
    const panel = document.getElementById('evidence-panel');
    const trailHref = this.isDemo ? `demo.html?trail=${encodeURIComponent(topic.id)}` : `newtab.html?view=trails&trail=${encodeURIComponent(topic.id)}`;
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Selected trail</div>
        <h2>${escapeHtml(topic.label)}</h2>
        <p>${formatCount(topic.pageCount, 'page')} · ${formatCount(topic.visitCount, 'visit')} · ${formatMinutes(topic.estimatedDwellMinutes)} estimated in this period</p>
        <div class="evidence-actions"><a class="secondary-btn" href="${trailHref}">Open trail details</a><button type="button" id="graph-neighborhood" class="secondary-btn">Zoom to this trail</button></div>
        <details class="graph-record-details"><summary>How this trail was made</summary><p>Pages grouped by their recorded content, or your saved correction.</p><p>${escapeHtml(topic.rationale)}</p><p>${formatPercent(topic.attentionShare || 0)} of grouped estimated time in this period.</p></details>
        <h3>Pages</h3>
        <div id="graph-topic-pages"></div>
      </div>
    `;
    this.appendNodeList(document.getElementById('graph-topic-pages'), this.graphData.nodes.filter(n => n.parentTopicId === topic.id));
    const section = panel.querySelector('.evidence-section');
    const group = this.graphData.groups.find(g => g.related && g.topicIds.includes(topic.id));
    if (group) {
      const related=document.createElement('section');related.innerHTML=`<h3>Related titles · ${escapeHtml(group.label)}</h3><p>Shared title word: “${escapeHtml(group.cue)}”.</p>`;
      this.appendNodeList(related,this.graphData.nodes.filter(n=>n.type==='topic'&&n.id!==topic.id&&group.topicIds.includes(n.id)));section.append(related);
    }
    const routes = this.graphData.transitionLinks.filter(l => l.source.id === topic.id || l.target.id === topic.id);
    if (routes.length) {
      const connections = document.createElement('section'); connections.innerHTML = `<h3>Repeated routes · ${routes.length}</h3>`;
      const list = document.createElement('div'); list.className = 'graph-browser-list';
      for (const link of routes.sort((a, b) => b.weight - a.weight)) {
        const other = link.source.id === topic.id ? link.target : link.source;
        const row = document.createElement('button'); row.type = 'button'; row.className = 'graph-result';
        row.innerHTML = `<i class="studio-dot" style="background:${escapeAttribute(other.color)}"></i><span><strong>${link.source.id === topic.id ? 'To' : 'From'} ${escapeHtml(other.label)}</strong><small>${formatCount(link.weight, 'recorded sequence')}</small></span>`;
        row.addEventListener('click', () => { this.selectTransition(link.transition); this.zoomToNodes([link.source, link.target], 110); });
        list.append(row);
      }
      connections.append(list); section.append(connections);
    }
    this.appendSites(section, topic.pages || topic.topPages);
    this.appendTimeline(section, [topic.id]);
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
        <h2>${escapeHtml(transition.sourceLabel)} → ${escapeHtml(transition.targetLabel)}</h2>
        <div class="flow-type">${escapeHtml(transition.label)}</div>
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
    document.getElementById('evidence-panel').innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Page evidence</div>
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
    this.selected = null;
    this.searchGraph();
  }

  searchGraph() {
    const query = document.getElementById('graph-search')?.value.trim().toLocaleLowerCase() || '';
    this.query = query;
    this.searchMatches = query ? this.graphData.nodes.filter(node => `${node.label} ${node.page?.title || ''} ${node.page?.url || ''}`.toLocaleLowerCase().includes(query)) : [];
    this.updateLevelOfDetail(this.currentScale);
    if (query) {
      const section = this.panelFrame('Search results', `${formatCount(this.searchMatches.length, 'match')} for “${query}”. Press Enter to open the first.`, 'Search');
      if (this.searchMatches.length) this.appendNodeList(section, this.searchMatches);
      else { const p = document.createElement('p'); p.textContent = 'No matching trails or pages. Try a different title or website.'; section.append(p); }
      this.setStatus(`${this.searchMatches.length} matching trails and pages.`);
    } else if (this.analysis?.ok) {
      if (!this.selected) this.renderDefaultEvidence(this.analysis);
      this.setStatus(`${this.analysis.topics.length} trails · ${this.graphData.nodes.filter(n => n.type === 'page').length} pages in this period.`);
    }
  }

  updateLevelOfDetail(scale) {
    this.currentScale = scale;
    document.querySelectorAll('[data-graph-mode]').forEach(b=>b.setAttribute('aria-pressed',String(!!document.getElementById(b.dataset.graphMode)?.checked)));
    if (!this.labelSelection || !this.nodeSelection) return;
    const transform = this.svg.node().__zoom || {x: 0, y: 0, k: scale};
    const mode = document.getElementById('graph-labels')?.value || 'auto';
    const showPages = document.getElementById('show-pages')?.checked !== false;
    const showFlows = document.getElementById('show-flows')?.checked !== false;
    const active = this.selected;
    const selectedTopic = active?.kind === 'topic' ? active.id : active?.kind === 'page' ? active.topicId : null;
    const selectedEdge = active?.kind === 'transition' ? this.analysis.transitions.find(t => t.id === active.id) : null;
    const groupTopics = active?.kind === 'group' ? new Set(this.graphData.groups.find(g => g.id === active.id)?.topicIds || []) : null;
    const neighbors = new Set(selectedTopic ? this.graphData.transitionLinks.filter(l => l.source.id === selectedTopic || l.target.id === selectedTopic).flatMap(l => [l.source.id, l.target.id]) : []);
    const matches = new Set((this.query ? this.searchMatches : []).map(n => n.id));
    const matchedParents = new Set((this.query ? this.searchMatches : []).map(n => n.parentTopicId).filter(Boolean));
    const related = node => !active || node.id === active.id || node.page?.id === active.id ||
      (selectedTopic && (node.id === selectedTopic || node.parentTopicId === selectedTopic || (showFlows && neighbors.has(node.id)))) ||
      (groupTopics && (groupTopics.has(node.id) || groupTopics.has(node.parentTopicId))) ||
      (active.kind === 'collection' && (node.type === 'collection' || (node.type === 'page' && !node.parentTopicId))) ||
      (selectedEdge && [selectedEdge.sourceTopicId, selectedEdge.targetTopicId].includes(node.id));
    const visible = node => {
      if (node.type !== 'page') return true;
      if (node.page?.id === active?.id) return true;
      if (!node.parentTopicId) return active?.kind === 'collection';
      if (!showPages) return false;
      if (selectedTopic) return node.parentTopicId === selectedTopic;
      if (groupTopics) return groupTopics.has(node.parentTopicId) && scale >= 1.2;
      return !active && scale >= 1.6;
    };
    // Trails keep a readable on-screen size when zoomed out, and grow only a
    // little when zoomed in, so the layout's spacing stays meaningful.
    const onScreen = Math.max(.55, Math.min(1.35, scale));
    this.nodeSelection.each(node => {
      node.visible = visible(node);
      node.renderRadius = (node.type === 'page' ? Math.min(7, Math.max(3.5, node.radius * scale)) : node.type === 'collection' ? 16 : node.radius * onScreen) / scale;
    }).attr('r', n => n.renderRadius).style('display', n => n.visible ? null : 'none')
      .style('opacity', n => this.query ? (matches.has(n.id) || matches.has(n.parentTopicId) || matchedParents.has(n.id) ? 1 : .14) : related(n) ? 1 : .16)
      .attr('aria-pressed', n => String(!!active && (n.id === active.id || n.page?.id === active.id)));
    this.membershipSelection.style('display', l => l.target.visible ? null : 'none').style('opacity', l => related(l.target) ? .45 : .08);
    this.haloSelection?.style('opacity', g => this.query ? (g.topicIds.some(id => matches.has(id) || matchedParents.has(id)) ? 1 : .25)
      : !active || (groupTopics && active.id === g.id) || g.topicIds.includes(selectedTopic) ? 1 : .25);
    const path = link => flowPath(link.source, link.target, link.source.renderRadius + 4 / scale, link.target.renderRadius + 7 / scale,
      link.hasReciprocal ? (link.transition.sourceTopicId < link.transition.targetTopicId ? 1 : -1) : .35);
    const showFlow = (link,index) => active?.kind === 'transition' ? link.id === active.id
      : selectedTopic ? showFlows && (link.source.id === selectedTopic || link.target.id === selectedTopic)
      : groupTopics ? groupTopics.has(link.source.id) && groupTopics.has(link.target.id)
      : active?.kind === 'collection' ? false
      : showFlows && index < this.graphData.overviewFlowLimit;
    this.linkSelection.attr('d', path).style('display', (l,i) => showFlow(l,i) ? null : 'none').style('opacity', active ? .95 : .55);
    this.flowHitSelection?.attr('d', path).style('display', (l,i) => showFlow(l,i) ? null : 'none');
    // Labels are placed in screen coordinates, tested against actual glyph
    // widths and every visible circle, so zooming out never piles text up.
    // Group names claim space first; trail names fill the gaps by rank.
    const occupied = [{x:12, y:8, w:Math.min(this.width-24,300), h:36}, {x:this.width-230, y:8, w:220, h:44}], placements = new Map(), margin = 12;
    const intersects = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
    const screen = node => ({x: node.x * scale + transform.x, y: node.y * scale + transform.y, r: node.renderRadius * scale});
    for (const n of this.graphData.nodes.filter(n => n.visible && n.type !== 'page')) {
      const p = screen(n); occupied.push({x:p.x-p.r-3, y:p.y-p.r-3, w:p.r*2+6, h:p.r*2+6});
    }
    this.groupLabelSelection?.style('display','none').each((group,index,elements)=>{
      if (mode === 'off' || !group.bounds || (active && !(groupTopics && active.id === group.id)) || this.query) return;
      // Measure the rendered (uppercase, tracked) name rather than estimating it.
      const element = elements[index], text = truncate(group.label, 26);
      element.textContent = text; element.style.display = '';
      const w = (element.getComputedTextLength ? element.getComputedTextLength() : text.length * 8) + 12;
      element.style.display = 'none';
      const x = (group.bounds.x + group.bounds.w / 2) * scale + transform.x, y = group.bounds.y * scale + transform.y - 4;
      const box = {x: x - w / 2, y: y - 15, w, h: 21};
      if (box.x < margin || box.x + box.w > this.width - margin || box.y < margin || box.y + box.h > this.height - 60) return;
      if (occupied.some(other => intersects(box, other))) return;
      occupied.push(box);
      d3.select(element).attr('x', x).attr('y', y).attr('text-anchor', 'middle').style('display', null);
    });
    const labels = [];
    const chars = this.width < 400 ? 14 : this.width < 600 ? 18 : 28;
    if (this.labelCharLimit !== chars) { this.labelSelection.text(n => truncate(n.label, n.type === 'collection' ? 32 : chars)); this.labelCharLimit = chars; }
    this.labelSelection.style('display','none').each((n,i,elements) => {
      if (mode === 'off' || !n.visible || (active && !related(n)) || (this.query && !matches.has(n.id) && !matchedParents.has(n.id))) return;
      if (n.type === 'page' && !selectedTopic && active?.kind !== 'collection' && n.page?.id !== active?.id && scale < (mode === 'all' ? 1.2 : 1.8)) return;
      // Far out, only the busiest trails are named; zooming in reveals the rest.
      if (n.type === 'topic' && mode !== 'all' && !active && !this.query && scale < .5 && n.index >= 14 && n.id !== this.hoveredId) return;
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
      const p = screen(n), height = 18, gap = p.r+6, w=width+8;
      const candidates = [
        {x:p.x-w/2,y:p.y+gap,w,h:height},
        {x:p.x+gap,y:p.y-height/2,w,h:height},
        {x:p.x-gap-w,y:p.y-height/2,w,h:height},
        {x:p.x-w/2,y:p.y-gap-height,w,h:height},
        {x:p.x+gap,y:p.y-height-4,w,h:height},
        {x:p.x+gap,y:p.y+4,w,h:height},
        {x:p.x-gap-w,y:p.y-height-4,w,h:height},
        {x:p.x-gap-w,y:p.y+4,w,h:height}
      ];
      const box = candidates.find(b => b.x>=margin && b.y>=margin && b.x+b.w<=this.width-margin && b.y+b.h<=this.height-60 && !occupied.some(other => intersects(b,other)));
      if (!box) continue;
      occupied.push({x:box.x-2,y:box.y-2,w:box.w+4,h:box.h+4}); placements.set(n.id,box);
      d3.select(element).style('display',null).attr('text-anchor','start').attr('x',box.x+4).attr('y',box.y+13);
    }
    this.labelPlacements = placements;
    const hint = document.getElementById('graph-view-status');
    if (hint) hint.textContent = active ? active.kind === 'topic' ? `${this.graphData.nodes.filter(n=>n.visible&&n.type==='page'&&n.parentTopicId===active.id).length} pages around this trail · others dimmed` : 'Selection highlighted · Clear or Esc returns to every trail'
      : `${this.graphData.groups.filter(g=>g.related).length} related groups · ${this.visibleTopicCount} trails · ${this.stackedLayout() ? 'pinch or ⌘/Ctrl-scroll to zoom' : 'scroll to zoom'}, drag to move`;
  }

  zoomToNodes(nodes, padding = 95, immediate = false) {
    nodes = nodes.filter(Boolean);
    if (!nodes.length) return;
    const x = d3.extent(nodes,n => n.x), y = d3.extent(nodes,n => n.y);
    const scale = Math.max(.08, Math.min(2.2, (this.width-padding*2)/Math.max(1,x[1]-x[0]), (this.height-padding*2)/Math.max(1,y[1]-y[0])));
    const target = d3.zoomIdentity.translate(this.width/2-(x[0]+x[1])/2*scale, this.height/2-(y[0]+y[1])/2*scale).scale(scale);
    const duration = immediate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 380;
    if (!duration) this.svg.call(this.zoom.transform,target);
    else this.svg.transition().duration(duration).ease(d3.easeCubicOut).call(this.zoom.transform,target);
  }

  fitToViewport(immediate) {
    this.overviewMode = true;
    const roots = this.graphData.nodes.filter(n => n.type !== 'page');
    this.zoomToNodes(roots.flatMap(n => [{x:n.x-n.radius-30,y:n.y-n.radius-30},{x:n.x+n.radius+30,y:n.y+n.radius+30}]), this.width < 600 ? 16 : 36, immediate);
  }

  dragStarted(event, d) {
    this.simulation?.stop();
    d.fx = d.x; d.fy = d.y;
  }

  dragged(event, d) {
    const dx = event.x - d.x, dy = event.y - d.y;
    d.x = d.fx = event.x; d.y = d.fy = event.y;
    if (d.type === 'topic' || d.type === 'collection') {
      for (const page of this.graphData.nodes.filter(n => n.parentTopicId === d.id || (d.type === 'collection' && n.type === 'page' && !n.parentTopicId))) {
        page.x += dx; page.y += dy;
      }
    }
    this.updatePositions();
  }

  dragEnded(event, d) {
    for (const node of this.graphData.nodes) if (node.id === d.id || node.parentTopicId === d.id) this.savedPositions.set(node.id, { x: node.x, y: node.y });
  }

  setLoading(visible, message) {
    const loading = document.getElementById('loading');
    loading.style.display = visible ? 'block' : 'none';
    if (message) loading.textContent = message;
  }

  setStatus(message) {
    document.getElementById('status-line').textContent = message;
    document.title = `Cognitive Trails · ${String(message || '').slice(0, 70)}`;
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
      .style('max-width', `${Math.min(240, window.innerWidth - 32)}px`)
      .style('opacity', 1)
      .html(html);
    const box = tooltip.node().getBoundingClientRect();
    tooltip.style('left', `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - box.width - 12))}px`)
      .style('top', `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - box.height - 12))}px`);
  }

  hideTooltip() {
    d3.select('#tooltip').style('opacity', 0).style('display', 'none');
  }

  topicTooltip(topic) {
    return `<strong>${escapeHtml(topic.label)}</strong><br>${formatCount(topic.pageCount, 'page')} · ${formatCount(topic.visitCount, 'visit')}<br>${formatMinutes(topic.estimatedDwellMinutes)} estimated`;
  }

  pageTooltip(page) {
    return `<strong>${escapeHtml(page.domain)}</strong><br>${escapeHtml(page.title)}<br>${formatCount(page.visitCount, 'visit')}`;
  }

  transitionTooltip(transition) {
    return `<strong>${escapeHtml(transition.sourceLabel)} → ${escapeHtml(transition.targetLabel)}</strong><br>${escapeHtml(transition.label)}<br>${transition.visitCount} consecutive visits<br>on ${(transition.days || []).length} day(s)${transition.uncertain ? ' · label uncertain' : ''}`;
  }
}

// A stable value in [0, 1) from a string, for seeded initial positions.
function hashUnit(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
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
  const offset = Math.min(46, distance * 0.2) * bend * canonicalFlip;
  const cx = midX + -uy * offset;
  const cy = midY + ux * offset;
  return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
}

function hourHistogram(hourCounts) {
  const counts = Array.isArray(hourCounts) ? hourCounts : [];
  const max = Math.max(1, ...counts);
  if (!counts.some(Boolean)) return '<p>No hour-of-day detail recorded.</p>';
  return `<div class="hour-histogram">${counts.map((count, hour) => `
    <span title="${hour}:00 - ${count} movement(s)" style="height:${Math.round((count / max) * 100)}%"></span>
  `).join('')}</div><div class="hour-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
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
  return `${value} ${noun}${value === 1 ? '' : noun.endsWith('ch') ? 'es' : 's'}`;
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
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
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
      const view=new TopicMapVisualizer({ store, now: CTText.dayKeyToNoonMs(lastDay) + 9 * 3600000, isDemo: true });window.CTPageDispose=()=>view.dispose();await view.ready;
    } catch (error) { document.getElementById('loading').textContent = error.message; }
  });
}
