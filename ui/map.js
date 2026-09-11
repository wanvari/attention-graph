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
    this.loadAnalysis(params.get('refresh') === '1' || params.get('forceRefresh') === '1');
    window.addEventListener('resize', () => this.handleResize());
  }

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
        this.g.attr('transform', event.transform);
        this.updateLevelOfDetail(event.transform.k);
      });
    this.svg.call(this.zoom);
    this.svg.on('click', () => this.clearSelection());
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
    document.getElementById('show-pages')?.addEventListener('change', () => this.updateLevelOfDetail(this.currentScale));
    document.getElementById('graph-search')?.addEventListener('input', () => this.searchGraph());
    document.getElementById('graph-search')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { const node = this.searchMatches?.[0]; if (node) { node.type === 'topic' ? this.selectTopic(node.topic) : this.selectPage(node.page, node.parentTopicId); } }
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
      <button class="zoom-control" type="button" data-zoom="reset" aria-label="Fit graph to view" title="Fit graph to view">Fit</button>
      <button class="zoom-control" type="button" data-zoom="clear" aria-label="Clear selection" title="Clear selection">Clear</button>
    `;
    container.appendChild(controls);
    controls.addEventListener('click', event => {
      const action = event.target.dataset.zoom;
      if (!action) return;
      if (action === 'in') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1.7);
      if (action === 'out') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1 / 1.7);
      if (action === 'reset') this.fitToViewport();
      if (action === 'clear') { const search = document.getElementById('graph-search'); if (search) search.value = ''; this.clearSelection(); }
    });
  }

  handleResize() {
    const rect = document.getElementById('graph-container').getBoundingClientRect();
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;
    this.svg.attr('width', this.width).attr('height', this.height);
    this.fitToViewport(true);
  }

  async loadAnalysis(forceRefresh) {
    this.setLoading(true, forceRefresh ? 'Re-running local analysis...' : 'Loading stored analysis...');
    this.setStatus(forceRefresh ? 'Re-running the full local analysis...' : 'Loading stored analysis...');
    this.setHealth('checking', forceRefresh ? 'Analyzing locally' : 'Loading');
    try {
      await this.store.open();
      const analysis = await CTMapData.build(this.store, { windowDays: this.windowDays || 30, now: this.recordNow });
      analysis.corrections = await this.store.getAll('corrections');
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
      if (fresh.length >= 10) {
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
      <span>${escapeHtml(count)} pages visited since the last analysis run, so they are not on this map yet.</span>
      <a class="banner-link" href="audit.html">Open Audit to run one</a>
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
    this.g.selectAll('*').remove();
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
        <p>
          This map draws the persistent topic registry, so it stays empty until an analysis run has
          finished. Runs happen on their own when the machine is idle.
        </p>
        <div class="setup-box">
          <div>To run one now, open <a href="audit.html">Audit</a> and press <strong>Run now</strong>.</div>
          <div>That needs local Ollama at <code>http://localhost:11434</code> with <code>bge-m3:latest</code> and <code>qwen3:4b</code> pulled.</div>
          <div>If topics exist but are older than this window, widen it to 90 days.</div>
        </div>
      </div>
    `;
  }

  renderAnalysis(analysis) {
    this.analysis = analysis;
    for (const node of this.graphData.nodes) if (Number.isFinite(node.x)) this.savedPositions.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy });
    this.selected = null;
    this.graphData = this.buildGraphData(analysis);
    this.renderSummary(analysis);
    this.renderLegend();
    this.renderGraph(this.graphData);
    this.renderDefaultEvidence(analysis);
    this.searchGraph();
    const when = this.isDemo ? ' Synthetic sample, March 2026.' : analysis.generatedAt ? ` Analyzed ${timeAgo(analysis.generatedAt)}.` : '';
    this.setStatus(`${analysis.topics.length} topics mapped from ${analysis.coverage.visitsExpanded} expanded visits.${when}`);
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
    // Circle area follows estimated browsing time, with a minimum visible radius.
    const attentionMass = topic => topic.estimatedDwellMs;
    const topicRadius = d3.scaleSqrt()
      .domain([0, d3.max(visibleTopics, attentionMass) || 1])
      .range([0, 35]);
    const topicNodes = visibleTopics.map((topic, index) => ({
      id: topic.id,
      type: 'topic',
      topic,
      label: topic.label,
      color: globalThis.CTStudio ? CTStudio.topicColor(topic.id) : topic.color,
      attentionBand: topic.attentionBand,
      attentionRank: topic.attentionRank,
      radius: Math.max(12, topicRadius(attentionMass(topic))),
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
          label: page.domain,
          color: globalThis.CTStudio ? CTStudio.topicColor(topic.id) : topic.color,
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
      pageNodes.push({ id: `ungrouped:${page.id}`, type: 'page', page, pageIndex, siblingCount: analysis.uncategorized.pages.length, parentTopicId: null, label: page.domain, color: 'var(--text-dim, #a5b1c5)', radius: 6 });
    }
    const crossTopic = analysis.transitions.filter(t =>
      t.sourceTopicId !== t.targetTopicId &&
      visibleTopicIds.has(t.sourceTopicId) &&
      visibleTopicIds.has(t.targetTopicId)
    );
    const limited = flowLimitValue === 'all' ? crossTopic : crossTopic.slice(0, Number(flowLimitValue));
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
      nodes: [...topicNodes, ...pageNodes],
      links: [...membershipLinks, ...transitionLinks],
      transitionLinks
    };
  }

  renderGraph(data) {
    this.g.selectAll('*').remove();
    if (this.simulation) this.simulation.stop();
    // Re-measure: the header grows when the summary strip and legend render,
    // so the container is smaller than it was during setupSVG.
    const rect = document.getElementById('graph-container').getBoundingClientRect();
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;
    this.svg.attr('width', this.width).attr('height', this.height);
    this.computeTopicAnchors(data.nodes.filter(n => n.type === 'topic'));

    const transitionLayer = this.g.append('g').attr('class', 'transition-layer');
    const membershipLayer = this.g.append('g').attr('class', 'membership-layer');
    const nodeLayer = this.g.append('g').attr('class', 'node-layer');
    const labelLayer = this.g.append('g').attr('class', 'label-layer');

    const membership = membershipLayer.selectAll('line')
      .data(data.links.filter(link => link.type === 'membership'))
      .enter()
      .append('line')
      .attr('class', 'membership-link')
      .attr('stroke', link => link.color)
      .attr('stroke-opacity', 0.36)
      .attr('stroke-width', 1.4);

    const flowWidth = d3.scaleSqrt()
      .domain([1, d3.max(data.links, link => link.type === 'transition' ? link.weight : 1) || 1])
      .range([1.5, 4]);
    const transitions = transitionLayer.selectAll('path')
      .data(data.links.filter(link => link.type === 'transition'))
      .enter()
      .append('path')
      .attr('class', 'flow-link')
      .attr('fill', 'none')
      .attr('stroke', link => link.color)
      .attr('stroke-width', link => flowWidth(Math.max(1, link.weight)))
      .attr('stroke-opacity', 0.65)
      .attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', link => `${link.transition.sourceLabel} to ${link.transition.targetLabel}, ${link.weight} recorded sequences`)
      .on('keydown', (event, link) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selectTransition(link.transition); } if(event.key==='Escape')this.clearSelection(); })
      .attr('marker-end', link => `url(#flow-arrow-${link.transition.type})`)
      .on('click', (event, link) => {
        event.stopPropagation();
        this.selectTransition(link.transition);
      })
      .on('mouseover', (event, link) => this.showTooltip(event, this.transitionTooltip(link.transition)))
      .on('mouseout', () => this.hideTooltip());

    const node = nodeLayer.selectAll('circle')
      .data(data.nodes)
      .enter()
      .append('circle')
      .attr('class', d => d.type === 'topic' ? 'topic-node' : 'page-node')
      .attr('r', d => d.radius)
      .attr('fill', d => d.type === 'topic' ? d.color : 'var(--panel, #fff)')
      .attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', d => d.type === 'topic' ? `Trail: ${d.label}, ${d.topic.pageCount} pages` : `Page: ${d.page.title}`)
      .on('keydown', (event, d) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); d.type === 'topic' ? this.selectTopic(d.topic) : this.selectPage(d.page, d.parentTopicId); } if(event.key==='Escape')this.clearSelection(); })
      .attr('fill-opacity', d => d.type === 'topic' ? 0.92 : 1)
      .attr('stroke', d => {
        const darker = d3.color(d.color);
        return darker ? darker.darker(0.7).formatHex() : d.color;
      })
      .attr('stroke-width', d => d.type === 'topic' ? 1.5 : 1.5)
      .on('click', (event, d) => {
        event.stopPropagation();
        if (d.type === 'topic') this.selectTopic(d.topic);
        else this.selectPage(d.page, d.parentTopicId);
      })
      .on('mouseover', (event, d) => {
        this.showTooltip(event, d.type === 'topic' ? this.topicTooltip(d.topic) : this.pageTooltip(d.page));
        this.highlightNode(d);
      })
      .on('mouseout', () => {
        this.hideTooltip();
        if (!this.selected) this.searchGraph();
      })
      .call(d3.drag()
        .on('start', (event, d) => this.dragStarted(event, d))
        .on('drag', (event, d) => this.dragged(event, d))
        .on('end', (event, d) => this.dragEnded(event, d)));

    const labels = labelLayer.selectAll('text')
      .data(data.nodes)
      .enter()
      .append('text')
      .attr('class', d => d.type === 'topic' ? 'topic-label' : 'page-label')
      .attr('text-anchor', 'middle')
      .text(d => truncate(d.label, d.type === 'topic' ? 22 : 18));

    const sublabels = labelLayer.selectAll('text.topic-sublabel')
      .data(data.nodes.filter(d => d.type === 'topic'))
      .enter()
      .append('text')
      .attr('class', 'topic-sublabel')
      .attr('text-anchor', 'middle')
      .text(d => `${formatMinutes(d.topic.estimatedDwellMinutes)} · ${d.topic.visitCount} visit${d.topic.visitCount === 1 ? '' : 's'}`);

    const updatePositions = () => {
      membership
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      transitions.each((d, i, paths) => {
        const bend = d.hasReciprocal
          ? (d.transition.sourceTopicId < d.transition.targetTopicId ? 1 : -1)
          : 0;
        d3.select(paths[i]).attr('d', flowPath(d.source, d.target, d.source.radius + 6, d.target.radius + 12, bend));
      });

      node
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);

      labels
        .attr('x', d => d.x)
        .attr('y', d => d.y + (d.type === 'topic' ? 135 + Math.floor((d.topic.pages || d.topic.topPages).length / 12) * 28 : d.radius + 18));

      sublabels
        .attr('x', d => d.x)
        .attr('y', d => d.y + 155 + Math.floor((d.topic.pages || d.topic.topPages).length / 12) * 28);
    };

    for (const node of data.nodes) Object.assign(node, this.savedPositions.get(node.id) || this.anchorForNode(node));
    this.updatePositions = updatePositions;
    this.simulation = d3.forceSimulation(data.nodes)
      .force('link', d3.forceLink(data.links).id(d => d.id).distance(link => link.type === 'transition' ? 270 : 92).strength(link => link.type === 'transition' ? 0.025 : 0.08))
      .force('charge', d3.forceManyBody().strength(d => d.type === 'topic' ? -240 : -25))
      .force('collision', d3.forceCollide().radius(d => d.radius + (d.type === 'topic' ? 30 : 10)))
      .force('x', d3.forceX(d => this.anchorForNode(d).x).strength(d => d.type === 'topic' ? 0.35 : 0.65))
      .force('y', d3.forceY(d => this.anchorForNode(d).y).strength(d => d.type === 'topic' ? 0.35 : 0.65));

    // Settle the layout synchronously so the graph appears in its final shape
    // instead of bouncing while forces converge; the simulation stays alive
    // only to serve drag interactions.
    this.simulation.stop();
    for (let i = 0; i < 300 && this.simulation.alpha() > this.simulation.alphaMin(); i++) {
      this.simulation.tick();
    }
    updatePositions();
    this.simulation.on('tick', updatePositions);

    const ungrouped = data.nodes.filter(n => n.type === 'page' && !n.parentTopicId);
    this.ungroupedLabel = ungrouped.length ? labelLayer.append('text').attr('class', 'graph-group-label').attr('x', d3.min(ungrouped, n => n.x)).attr('y', d3.min(ungrouped, n => n.y) - 35).text(`${ungrouped.length} ungrouped pages`) : null;
    this.linkSelection = transitions;
    this.membershipSelection = membership;
    this.nodeSelection = node;
    this.labelSelection = labels;
    this.sublabelSelection = sublabels;
    this.updateLevelOfDetail(this.currentScale);
    this.fitToViewport(true);
  }

  computeTopicAnchors(topicNodes) {
    this.topicAnchors.clear();
    const nodes = [...topicNodes].sort((a,b) => a.id.localeCompare(b.id));
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * this.width / Math.max(400, this.height))));
    nodes.forEach((node,index) => this.topicAnchors.set(node.id, this.savedPositions.get(node.id) || {
      x: 170 + (index % columns) * 330, y: 160 + Math.floor(index / columns) * 290
    }));
  }

  anchorForNode(node) {
    if (node.type === 'topic') return this.topicAnchors.get(node.id) || { x: this.width / 2, y: this.height / 2 };
    const parent = this.topicAnchors.get(node.parentTopicId);
    if (!parent) return { x: 110 + (node.pageIndex % 8) * 72, y: 180 + Math.ceil(this.topicAnchors.size / Math.max(1, Math.ceil(Math.sqrt(this.topicAnchors.size * this.width / Math.max(400, this.height)))))*290 + Math.floor(node.pageIndex/8)*65 };
    const angle = (node.pageIndex / Math.max(1,node.siblingCount)) * Math.PI * 2 - Math.PI / 2;
    const radius = 105 + Math.floor(node.pageIndex / 12) * 28;
    return { x: parent.x + Math.cos(angle)*radius, y: parent.y + Math.sin(angle)*radius };
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
      ${metric(`${this.visibleTopicCount || analysis.topics.length} / ${analysis.topics.length}`, 'topics shown', 'Shown topics are the highest estimated-time topics selected by the Topics control.')}
      ${metric(this.graphData.nodes.filter(n => n.type === 'page').length, 'pages shown', 'Every recorded page in the selected trails, plus ungrouped pages in this period.')}
      ${metric(formatMinutes(categorized.estimatedActiveMinutes || 0), 'mapped estimated time', 'Estimated browsing time represented by the analyzed topic pages. Dwell is estimated from gaps and capped at 30 minutes.')}
      ${metric(visibleFlows.length, 'flow lines shown', 'Each line represents at least two observed sequences between these trails in the selected period.')}
      <div class="summary-note">Topic coverage: ${formatPercent(categorized.activeTimeCoverage || 0)} of estimated recorded time, ${formatPercent(categorized.visitCoverage || 0)} of visits.</div>
    `;
  }

  renderLegend() {
    document.getElementById('legend').innerHTML = `
      <span class="graph-key"><i></i>Trail · area = estimated time</span>
      <span class="graph-key page"><i></i>Page · color = its trail</span>
      <span class="graph-key flow"><i></i>Arrow · 2+ recorded sequences</span>
      <span>Drag a trail with its pages. Zoom in to reveal detail.</span>`;
  }

  renderDefaultEvidence(analysis) {
    const panel = document.getElementById('evidence-panel');
    const uncategorized = analysis.uncategorized || { pageCount: 0, estimatedDwellMinutes: 0 };
    const topTopic = analysis.topics[0];
    const collapsed = !!this.evidenceCollapsed;
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="evidence-header">
          <h2>Follow a connection.</h2>
          <button type="button" id="evidence-collapse-toggle" class="collapse-toggle" title="${collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${!collapsed}">${collapsed ? '+' : '−'}</button>
        </div>
        <div id="evidence-collapsible" class="evidence-collapsible" ${collapsed ? 'hidden' : ''}>
          <p>This map groups recorded pages into suggested topics and connects topics with at least two recorded consecutive sequences in this period.</p>
          <div class="metric-list">
            <div><strong>Time range</strong><span>${formatDate(analysis.coverage.startTime)} - ${formatDate(analysis.coverage.endTime)}</span></div>
            <div><strong>Trails shown</strong><span>${this.visibleTopicCount || analysis.topics.length} of ${analysis.topics.length} topics shown</span></div>
            <div><strong>Topic coverage</strong><span>${formatPercent(analysis.categorizedCoverage?.activeTimeCoverage ?? 0)} estimated time · ${formatPercent(analysis.categorizedCoverage?.visitCoverage ?? 0)} visits</span></div>
            <div><strong>Top topic</strong><span>${topTopic ? `${escapeHtml(topTopic.label)} (${topTopic.estimatedDwellMinutes}m est.)` : 'None'}</span></div>
            <div><strong>Uncategorized</strong><span>${uncategorized.pageCount ? `${uncategorized.pageCount} pages (${uncategorized.estimatedDwellMinutes}m est.) without a trail` : 'None'}</span></div>
            <div><strong>Recorded sequences</strong><span>${analysis.metrics.switching.switchCount} between-topic visits · ${analysis.metrics.switching.switchesPerActiveHour} changes per est. hour</span></div>
            <div><strong>Analyzed</strong><span>${analysis.generatedAt ? `${formatDate(new Date(analysis.generatedAt).getTime())} (${timeAgo(analysis.generatedAt)})` : 'n/a'}</span></div>
            <div><strong>Source</strong><span>${analysis.source}${analysis.fromCache ? ' (stored until re-run)' : ''}</span></div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('evidence-collapse-toggle').addEventListener('click', () => {
      this.evidenceCollapsed = !this.evidenceCollapsed;
      this.renderDefaultEvidence(analysis);
    });
  }

  selectTopic(topic) {
    this.selected = { kind: 'topic', id: topic.id };
    this.updateLevelOfDetail(this.currentScale);
    this.highlightTopic(topic.id);
    const panel = document.getElementById('evidence-panel');
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Selected trail</div>
        <h2>${escapeHtml(topic.label)}</h2>
        <p>Suggested topic. Check its pages to judge the grouping.</p>
        <button type="button" id="graph-neighborhood" class="secondary-btn">Zoom to this trail</button>
        <p>${escapeHtml(topic.rationale)}</p>
        <div class="metric-list">
          <div><strong>Time rank</strong><span>#${topic.attentionRank || 'n/a'} · ${escapeHtml(topic.attentionBandLabel || 'Unranked')}</span></div>
          <div><strong>Estimated time share</strong><span>${formatPercent(topic.attentionShare || 0)} of estimated recorded time</span></div>
          <div><strong>Visits</strong><span>${topic.visitCount}</span></div>
          <div><strong>Estimated time</strong><span>${topic.estimatedDwellMinutes}m · entire trail in this period</span></div>
          <div><strong>Top domains</strong><span>${topic.topDomains.map(d => escapeHtml(d.domain)).join(', ')}</span></div>
        </div>
        <h3>Evidence pages</h3>
        ${pageList(topic.topPages)}
        <p><a class="secondary-btn" href="${this.isDemo ? `demo.html?trail=${encodeURIComponent(topic.id)}` : `newtab.html?trail=${encodeURIComponent(topic.id)}`}">Open this trail on Home</a></p>
      </div>
    `;
    document.getElementById('graph-neighborhood').addEventListener('click', () => this.zoomToTopic(topic.id));

  }

  selectTransition(transition) {
    this.selected = { kind: 'transition', id: transition.id };
    this.highlightTransition(transition.id);
    const panel = document.getElementById('evidence-panel');
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Recorded connection</div>
        <h2>${escapeHtml(transition.sourceLabel)} -> ${escapeHtml(transition.targetLabel)}</h2>
        <div class="flow-type" style="border-color:${transition.color}">${escapeHtml(transition.label)}</div>

        <p>${escapeHtml(transition.rationale)}</p>
        <div class="metric-list">
          <div><strong>Observed transitions</strong><span>${transition.visitCount}</span></div>
          <div><strong>Days observed</strong><span>${(transition.days || []).length}</span></div>

        </div>
        <h3>Recorded page sequences</h3>
        ${transitionExamples(transition.examples?.slice(0, 20))}
        <h3>When these movements happened</h3>
        ${hourHistogram(transition.hourCounts)}
        <p>Lines describe consecutive recorded visits between topics. They do not establish a relationship between ideas or explain why you switched.</p>
      </div>
    `;

  }

  selectPage(page, topicId) {
    this.selected = { kind: 'page', id: page.id };
    if (topicId) this.highlightTopic(topicId);
    else { this.clearHighlight(); this.nodeSelection.style('opacity', node => node.page?.id === page.id ? 1 : 0.25); }
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
      </div>
    `;
  }

  highlightNode(node) {
    if (node.type === 'topic') this.highlightTopic(node.id);
    else this.highlightTopic(node.parentTopicId);
  }

  highlightTopic(topicId) {
    if (!this.nodeSelection || !this.linkSelection) return;
    this.nodeSelection.style('opacity', node => {
      if (node.id === topicId || node.parentTopicId === topicId) return 1;
      return 0.18;
    });
    this.linkSelection.style('opacity', link => {
      const source = link.source.id || link.source;
      const target = link.target.id || link.target;
      return source === topicId || target === topicId ? 0.95 : 0.08;
    });
    if (this.membershipSelection) {
      this.membershipSelection.style('opacity', link => (link.source.id || link.source) === topicId ? 0.45 : 0.06);
    }
  }

  highlightTransition(transitionId) {
    if (!this.linkSelection || !this.nodeSelection) return;
    const transition = this.analysis.transitions.find(t => t.id === transitionId);
    if (!transition) return;
    this.nodeSelection.style('opacity', node => {
      if (node.id === transition.sourceTopicId || node.id === transition.targetTopicId) return 1;
      if (node.parentTopicId === transition.sourceTopicId || node.parentTopicId === transition.targetTopicId) return 0.55;
      return 0.12;
    });
    this.linkSelection.style('opacity', link => link.transition.id === transitionId ? 1 : 0.08);
  }

  clearHighlight() {
    if (this.nodeSelection) this.nodeSelection.style('opacity', 1);
    if (this.linkSelection) this.linkSelection.style('opacity', 1);
    if (this.labelSelection) this.labelSelection.style('opacity', 1);
    if (this.membershipSelection) this.membershipSelection.style('opacity', 1);
  }

  clearSelection() {
    this.selected = null;
    this.clearHighlight();
    this.searchGraph();
    if (this.analysis && this.analysis.ok) this.renderDefaultEvidence(this.analysis);
  }

  searchGraph() {
    const query = document.getElementById('graph-search')?.value.trim().toLocaleLowerCase() || '';
    this.searchMatches = this.graphData.nodes.filter(node => `${node.label} ${node.page?.title || ''} ${node.page?.url || ''}`.toLocaleLowerCase().includes(query));
    if (!query) { if (!this.selected) this.clearHighlight(); if (this.analysis) this.setStatus(`${this.analysis.topics.length} trails · ${this.graphData.nodes.filter(n => n.type === 'page').length} pages in this period.`); return; }
    const ids = new Set(this.searchMatches.map(node => node.id));
    const parents = new Set(this.searchMatches.map(node => node.parentTopicId).filter(Boolean));
    this.nodeSelection?.style('opacity', node => ids.has(node.id) || ids.has(node.parentTopicId) || parents.has(node.id) ? 1 : 0.12);
    this.labelSelection?.style('opacity', node => ids.has(node.id) || ids.has(node.parentTopicId) || parents.has(node.id) ? 1 : 0.18);
    this.linkSelection?.style('opacity', .12);
    this.updateLevelOfDetail(this.currentScale);
    this.setStatus(`${this.searchMatches.length} matching trails and pages. Press Enter to inspect the first match.`);
  }

  updateLevelOfDetail(scale) {
    this.currentScale = scale;
    if (!this.labelSelection) return;
    const mode = document.getElementById('graph-labels')?.value || 'auto';
    const pages = document.getElementById('show-pages')?.checked !== false;
    this.nodeSelection.filter(d => d.type === 'page').style('display', pages ? null : 'none');
    this.labelSelection.style('font-size', d => `${(d.type === 'topic' ? 12 : 10) / scale}px`);
    this.sublabelSelection?.style('font-size', `${10 / scale}px`);
    this.labelSelection.style('display', d => {
      if (mode === 'off' || (d.type === 'page' && !pages)) return 'none';
      if (mode === 'auto' && this.width < 600 && scale < .65) return d.id === this.selected?.id ? null : 'none';
      return d.type === 'topic' || mode === 'all' || scale >= 1.1 ? null : 'none';
    });
    this.sublabelSelection?.style('display', mode === 'off' || scale < 0.8 ? 'none' : null);
    this.membershipSelection?.style('display', pages ? null : 'none');
    this.ungroupedLabel?.style('display', pages ? null : 'none').style('font-size', `${11 / scale}px`);
  }

  zoomToTopic(topicId) {
    const node = this.graphData.nodes.find(n => n.id === topicId);
    if (!node) return;
    const scale = Math.min(1.7, this.width / 380, this.height / 330);
    this.svg.transition().duration(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 300)
      .call(this.zoom.transform, d3.zoomIdentity.translate(this.width / 2 - node.x * scale, this.height / 2 - node.y * scale).scale(scale));
  }

  fitToViewport(immediate) {
    if (!this.graphData.nodes.length) return;
    const nodes = this.graphData.nodes.filter(d => Number.isFinite(d.x) && Number.isFinite(d.y));
    if (!nodes.length) return;
    const x = d3.extent(nodes, d => d.x);
    const y = d3.extent(nodes, d => d.y);
    const padding = 110;
    const width = Math.max(1, x[1] - x[0] + padding * 2);
    const height = Math.max(1, y[1] - y[0] + padding * 2);
    const scale = Math.min(1.35, Math.max(0.05, Math.min(this.width / width, this.height / height)));
    const tx = this.width / 2 - ((x[0] + x[1]) / 2) * scale;
    const ty = this.height / 2 - ((y[0] + y[1]) / 2) * scale;
    const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
    if (immediate) this.svg.call(this.zoom.transform, transform);
    else this.svg.transition().duration(350).call(this.zoom.transform, transform);
  }

  dragStarted(event, d) {
    this.simulation.stop();
    d.fx = d.x; d.fy = d.y;
  }

  dragged(event, d) {
    const dx = event.x - d.x, dy = event.y - d.y;
    d.x = d.fx = event.x; d.y = d.fy = event.y;
    if (d.type === 'topic') {
      this.topicAnchors.set(d.id, { x: d.x, y: d.y });
      for (const page of this.graphData.nodes.filter(n => n.parentTopicId === d.id)) {
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
    d3.select('#tooltip')
      .style('opacity', 1)
      .style('left', `${event.pageX + 12}px`)
      .style('top', `${event.pageY - 10}px`)
      .html(html);
  }

  hideTooltip() {
    d3.select('#tooltip').style('opacity', 0);
  }

  topicTooltip(topic) {
    return `<strong>${escapeHtml(topic.label)}</strong><br>#${topic.attentionRank || '?'} ${escapeHtml(topic.attentionBandLabel || 'topic')}<br>${topic.visitCount} visits · ${topic.estimatedDwellMinutes}m estimated<br>${formatPercent(topic.attentionShare || 0)} of estimated recorded time<br>${topic.pageCount} pages of evidence`;
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
      <strong>${escapeHtml(item.from.title)}</strong>
      <span>to ${escapeHtml(item.to.title)}</span>
    </li>
  `).join('')}</ul>`;
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
if (typeof document !== 'undefined' && (typeof module === 'undefined' || !module.exports) && !globalThis.__CT_DEMO__) {
  document.addEventListener('DOMContentLoaded', async () => {
    if (typeof d3 === 'undefined') { document.getElementById('loading').textContent = 'Map library unavailable. Reload this page.'; return; }
    if (new URLSearchParams(location.search).get('demo') !== '1') { new TopicMapVisualizer(); return; }
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
      new TopicMapVisualizer({ store, now: CTText.dayKeyToNoonMs(lastDay) + 9 * 3600000, isDemo: true });
    } catch (error) { document.getElementById('loading').textContent = error.message; }
  });
}
