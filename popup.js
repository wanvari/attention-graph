const FLOW_COLORS = AttentionAnalysis.TRANSITION_TYPES;

class TopicMapVisualizer {
  constructor() {
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
        .attr('fill', item.color);
    }

    this.g = this.svg.append('g');
    this.zoom = d3.zoom()
      .scaleExtent([0.2, 4])
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
    document.getElementById('refresh-btn').addEventListener('click', () => this.loadAnalysis(true));
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
      <button class="zoom-control" type="button" data-zoom="in" title="Zoom in">+</button>
      <button class="zoom-control" type="button" data-zoom="out" title="Zoom out">-</button>
      <button class="zoom-control" type="button" data-zoom="reset" title="Fit graph to view">Fit</button>
    `;
    container.appendChild(controls);
    controls.addEventListener('click', event => {
      const action = event.target.dataset.zoom;
      if (!action) return;
      if (action === 'in') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1.7);
      if (action === 'out') this.svg.transition().duration(180).call(this.zoom.scaleBy, 1 / 1.7);
      if (action === 'reset') this.fitToViewport();
    });
  }

  handleResize() {
    const container = document.getElementById('graph-container');
    const rect = container.getBoundingClientRect();
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;
    this.svg.attr('width', this.width).attr('height', this.height);
    if (this.analysis && this.analysis.ok) this.renderAnalysis(this.analysis);
  }

  async loadAnalysis(forceRefresh) {
    this.setLoading(true, forceRefresh ? 'Re-running local analysis...' : 'Loading stored analysis...');
    this.setStatus(forceRefresh ? 'Re-running the full local analysis...' : 'Loading stored analysis...');
    this.setHealth('checking', forceRefresh ? 'Analyzing locally' : 'Loading');
    try {
      let analysis;
      if (typeof chrome === 'undefined' || !chrome.history) {
        this.setStatus('Demo mode: Chrome history API is unavailable in this context.');
        analysis = await AttentionAnalysis.createDemoAnalysis();
      } else {
        analysis = await AttentionAnalysis.runAnalysis({
          forceRefresh,
          onProgress: message => this.showProgress(message)
        });
      }
      if (!analysis.ok) {
        this.renderUnavailable(analysis);
        return;
      }
      this.analysis = analysis;
      this.setHealth('ok', analysis.fromCache
        ? `Stored analysis · ${timeAgo(analysis.generatedAt)}`
        : 'Fresh local analysis');
      this.renderAnalysis(analysis);
      this.setLoading(false);
    } catch (error) {
      console.error(error);
      this.renderUnavailable({
        ok: false,
        message: error.message || String(error),
        warnings: ['Analysis failed before the topic map could be built.']
      });
    }
  }

  renderUnavailable(result) {
    this.analysis = result;
    this.g.selectAll('*').remove();
    this.setLoading(false);
    this.setHealth('bad', 'Ollama unavailable');
    this.setStatus(result.message || 'Local analysis is unavailable.');
    const health = result.health || {};
    const extensionOrigin = health.origin || (location.origin && location.origin.startsWith('chrome-extension://') ? location.origin : '');
    const originsValue = extensionOrigin
      ? `http://localhost,http://127.0.0.1,${extensionOrigin}`
      : 'http://localhost,http://127.0.0.1,chrome-extension://YOUR_EXTENSION_ID';
    const setupDetails = health.originRejected ? `
        <div>Ollama is reachable, but it rejected this extension origin.</div>
        <div>Set <code>OLLAMA_ORIGINS</code> to allow this local extension:</div>
        <div><code>launchctl setenv OLLAMA_ORIGINS "${escapeHtml(originsValue)}"</code></div>
        <div>Then quit and reopen Ollama, and refresh this page.</div>
      ` : `
        <div>Expected local endpoint: <code>http://localhost:11434</code></div>
        <div>Required models: <code>bge-m3:latest</code> and <code>gemma3:12b-32k</code></div>
        <div>Start Ollama, install missing models, then refresh.</div>
      `;
    document.getElementById('summary-strip').innerHTML = '';
    document.getElementById('legend').innerHTML = '';
    document.getElementById('evidence-panel').innerHTML = `
      <div class="evidence-section">
        <h2>Local analysis unavailable</h2>
        <p>${escapeHtml(result.message || 'Could not run the local topic map.')}</p>
        <div class="setup-box">
          ${setupDetails}
        </div>
      </div>
    `;
  }

  renderAnalysis(analysis) {
    this.analysis = analysis;
    this.graphData = this.buildGraphData(analysis);
    this.renderSummary(analysis);
    this.renderLegend();
    this.renderGraph(this.graphData);
    this.renderDefaultEvidence(analysis);
    const when = analysis.generatedAt ? ` Analyzed ${timeAgo(analysis.generatedAt)}.` : '';
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
    // Circle area encodes estimated attention: dwell time plus a small floor
    // per visit so visit-heavy, low-dwell topics stay visible.
    const attentionMass = topic => topic.estimatedDwellMs + topic.visitCount * 45000;
    const topicRadius = d3.scaleSqrt()
      .domain([0, d3.max(visibleTopics, attentionMass) || 1])
      .range([14, 54]);
    const topicNodes = visibleTopics.map((topic, index) => ({
      id: topic.id,
      type: 'topic',
      topic,
      label: topic.label,
      color: topic.color,
      attentionBand: topic.attentionBand,
      attentionRank: topic.attentionRank,
      radius: Math.max(18, topicRadius(attentionMass(topic))),
      index
    }));

    const maxPageVisits = d3.max(visibleTopics, topic => d3.max(topic.topPages, page => page.visitCount)) || 1;
    const pageRadius = d3.scaleSqrt().domain([0, maxPageVisits]).range([4, 12]);
    const pageNodes = [];
    const membershipLinks = [];
    for (const topic of visibleTopics) {
      for (const page of topic.topPages.slice(0, 3)) {
        const node = {
          id: `${topic.id}:${page.id}`,
          type: 'page',
          page,
          parentTopicId: topic.id,
          label: page.domain,
          color: topic.color,
          radius: Math.max(4.5, pageRadius(page.visitCount))
        };
        pageNodes.push(node);
        membershipLinks.push({
          id: `member:${topic.id}:${page.id}`,
          type: 'membership',
          source: topic.id,
          target: node.id,
          weight: 1,
          color: topic.color
        });
      }
    }

    const crossTopic = analysis.transitions.filter(t =>
      t.sourceTopicId !== t.targetTopicId &&
      visibleTopicIds.has(t.sourceTopicId) &&
      visibleTopicIds.has(t.targetTopicId)
    );
    const limited = flowLimitValue === 'all' ? crossTopic : crossTopic.slice(0, Number(flowLimitValue));
    const transitionLinks = limited.map(transition => ({
      id: transition.id,
      type: 'transition',
      source: transition.sourceTopicId,
      target: transition.targetTopicId,
      transition,
      weight: transition.visitCount,
      color: transition.color
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
      .attr('stroke-opacity', 0.16)
      .attr('stroke-width', 1.4);

    const flowWidth = d3.scaleSqrt()
      .domain([1, d3.max(data.links, link => link.type === 'transition' ? link.weight : 1) || 1])
      .range([1.5, 7]);
    const transitions = transitionLayer.selectAll('line')
      .data(data.links.filter(link => link.type === 'transition'))
      .enter()
      .append('line')
      .attr('class', 'flow-link')
      .attr('stroke', link => link.color)
      .attr('stroke-width', link => flowWidth(Math.max(1, link.weight)))
      .attr('stroke-opacity', link => Math.max(0.38, Math.min(0.85, link.transition.confidence)))
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
      .attr('fill', d => d.type === 'topic' ? d.color : '#fff')
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
        if (!this.selected) this.clearHighlight();
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

      transitions.each((d, i, lines) => {
        const shortened = shortenLine(d.source, d.target, d.source.radius + 6, d.target.radius + 12);
        d3.select(lines[i])
          .attr('x1', shortened.x1)
          .attr('y1', shortened.y1)
          .attr('x2', shortened.x2)
          .attr('y2', shortened.y2);
      });

      node
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);

      labels
        .attr('x', d => d.x)
        .attr('y', d => d.y + (d.type === 'topic' ? 2 : d.radius + 13));

      sublabels
        .attr('x', d => d.x)
        .attr('y', d => d.y + d.radius + 15);
    };

    this.simulation = d3.forceSimulation(data.nodes)
      .force('link', d3.forceLink(data.links).id(d => d.id).distance(link => link.type === 'transition' ? 230 : 72).strength(link => link.type === 'transition' ? 0.18 : 0.55))
      .force('charge', d3.forceManyBody().strength(d => d.type === 'topic' ? -780 : -90))
      .force('collision', d3.forceCollide().radius(d => d.radius + 10))
      .force('x', d3.forceX(d => this.anchorForNode(d).x).strength(d => d.type === 'topic' ? 0.08 : 0.22))
      .force('y', d3.forceY(d => this.anchorForNode(d).y).strength(d => d.type === 'topic' ? 0.08 : 0.22));

    // Settle the layout synchronously so the graph appears in its final shape
    // instead of bouncing while forces converge; the simulation stays alive
    // only to serve drag interactions.
    this.simulation.stop();
    for (let i = 0; i < 300 && this.simulation.alpha() > this.simulation.alphaMin(); i++) {
      this.simulation.tick();
    }
    updatePositions();
    this.simulation.on('tick', updatePositions);

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
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    const base = Math.min(this.width, this.height);
    const primary = topicNodes.filter(node => node.attentionBand === 'primary');
    const outer = topicNodes.filter(node => node.attentionBand !== 'primary');
    const placeRing = (nodes, radius, offset) => {
      const count = Math.max(nodes.length, 1);
      nodes.forEach((node, index) => {
        const angle = offset + index * ((2 * Math.PI) / count);
        this.topicAnchors.set(node.id, {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius
        });
      });
    };

    if (!primary.length || !outer.length) {
      placeRing(topicNodes, base * 0.32, -Math.PI / 2);
      return;
    }
    placeRing(primary, base * 0.22, -Math.PI / 2);
    placeRing(outer, base * 0.39, -Math.PI / 2 + Math.PI / Math.max(outer.length, 3));
  }

  anchorForNode(node) {
    if (node.type === 'topic') return this.topicAnchors.get(node.id) || { x: this.width / 2, y: this.height / 2 };
    return this.topicAnchors.get(node.parentTopicId) || { x: this.width / 2, y: this.height / 2 };
  }

  renderSummary(analysis) {
    const strip = document.getElementById('summary-strip');
    const coverage = analysis.coverage;
    const categorized = analysis.categorizedCoverage || {};
    const switches = analysis.metrics.switchBurden;
    const visibleFlows = this.graphData.transitionLinks || [];
    const contextSwitches = analysis.metrics.transitionMix?.items?.find(item => item.type === 'topic_switch')?.count || switches.switchCount || 0;
    const metric = (value, label, title) => `
      <div class="summary-card" title="${escapeAttribute(title)}">
        <span>${escapeHtml(value)}</span>
        <label>${escapeHtml(label)}</label>
      </div>
    `;
    strip.innerHTML = `
      ${metric(`${this.visibleTopicCount || analysis.topics.length} / ${analysis.topics.length}`, 'topics shown', 'Shown topics are the highest estimated active-time topics selected by the Topics control.')}
      ${metric(coverage.visitsExpanded, 'visits read', 'Individual Chrome visit records expanded from the History API. Repeated visits are counted separately.')}
      ${metric(`${categorized.estimatedActiveMinutes || 0}m`, 'mapped active time', 'Estimated active time represented by the analyzed topic pages. Dwell is estimated from gaps and capped at 30 minutes.')}
      ${metric(visibleFlows.length, 'flow lines shown', 'Each line is an aggregated pair of consecutive topic visits currently visible in the graph.')}
      ${metric(contextSwitches, 'context switches', 'Observed consecutive visits where the next topic looked like a different task or context.')}
      ${metric(`${switches.switchesPerActiveHour}/hr`, 'switch rate', 'Context switches divided by estimated active browsing hours.')}
      <div class="summary-note">Topic coverage: ${formatPercent(categorized.activeTimeCoverage || 0)} of estimated active time, ${formatPercent(categorized.visitCoverage || 0)} of visits.</div>
    `;
  }

  renderLegend() {
    const legend = document.getElementById('legend');
    const visibleTopics = this.graphData.nodes.filter(node => node.type === 'topic');
    const visibleTransitions = (this.graphData.transitionLinks || []).map(link => link.transition);
    const visibleTransitionVisits = visibleTransitions.reduce((sum, transition) => sum + transition.visitCount, 0);
    const bandCounts = visibleTopics.reduce((counts, node) => {
      const band = node.topic.attentionBand || 'long_tail';
      counts[band] = (counts[band] || 0) + 1;
      return counts;
    }, {});
    const topicLegend = Object.entries(AttentionAnalysis.ATTENTION_BANDS).map(([key, item]) => `
      <div class="legend-item" title="${escapeAttribute(item.description)}">
        <div class="legend-dot" style="background:${item.color}"></div>
        <span>${escapeHtml(item.label)}</span>
        <small>${bandCounts[key] || 0} topics</small>
      </div>
    `).join('');
    const flowLegend = Object.entries(FLOW_COLORS)
      .filter(([type]) => type !== 'same_topic_flow')
      .map(([type, item]) => {
        const visits = visibleTransitions
          .filter(transition => transition.type === type)
          .reduce((sum, transition) => sum + transition.visitCount, 0);
        return `
          <div class="legend-item" title="${escapeAttribute(item.description)}">
            <div class="legend-line" style="background:${item.color}"></div>
            <span>${escapeHtml(item.label)}</span>
            <small>${visits} visits (${formatPercent(visibleTransitionVisits ? visits / visibleTransitionVisits : 0)} of shown flow)</small>
          </div>
        `;
      }).join('');
    legend.innerHTML = `
      <div class="legend-group">
        <strong>Topic color</strong>
        ${topicLegend}
      </div>
      <div class="legend-group">
        <strong>Flow color</strong>
        ${flowLegend || '<span class="legend-empty">No cross-topic flows shown</span>'}
      </div>
      <div class="legend-note">Circle area = estimated attention time. Line thickness = observed consecutive visits.</div>
    `;
  }

  renderDefaultEvidence(analysis) {
    const panel = document.getElementById('evidence-panel');
    const queueCount = analysis.validationQueue.length;
    const topTopic = analysis.metrics.topicTimeShare[0];
    panel.innerHTML = `
      <div class="evidence-section">
        <h2>Topic Map Evidence</h2>
        <p>This map groups high-attention history pages into topics and connects topics that appeared in consecutive visits.</p>
        <div class="metric-list">
          <div><strong>Time range</strong><span>${formatDate(analysis.coverage.startTime)} - ${formatDate(analysis.coverage.endTime)}</span></div>
          <div><strong>Graph sectors</strong><span>${this.visibleTopicCount || analysis.topics.length} of ${analysis.topics.length} topics shown</span></div>
          <div><strong>Topic coverage</strong><span>${formatPercent(analysis.categorizedCoverage?.activeTimeCoverage || 1)} active time · ${formatPercent(analysis.categorizedCoverage?.visitCoverage || 1)} visits</span></div>
          <div><strong>Top topic</strong><span>${topTopic ? `${escapeHtml(topTopic.label)} (${topTopic.estimatedDwellMinutes}m est.)` : 'None'}</span></div>
          <div><strong>Needs review</strong><span>${queueCount} low-confidence items</span></div>
          <div><strong>Analyzed</strong><span>${analysis.generatedAt ? `${formatDate(new Date(analysis.generatedAt).getTime())} (${timeAgo(analysis.generatedAt)})` : 'n/a'}</span></div>
          <div><strong>Source</strong><span>${analysis.source}${analysis.fromCache ? ' (stored until re-run)' : ''}</span></div>
        </div>
      </div>
    `;
  }

  selectTopic(topic) {
    this.selected = { kind: 'topic', id: topic.id };
    this.highlightTopic(topic.id);
    const panel = document.getElementById('evidence-panel');
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Topic Cluster</div>
        <h2>${escapeHtml(topic.label)}</h2>
        ${confidenceBar(topic.confidence)}
        <p>${escapeHtml(topic.rationale)}</p>
        <div class="metric-list">
          <div><strong>Attention rank</strong><span>#${topic.attentionRank || 'n/a'} · ${escapeHtml(topic.attentionBandLabel || 'Unranked')}</span></div>
          <div><strong>Attention share</strong><span>${formatPercent(topic.attentionShare || 0)} of estimated active time</span></div>
          <div><strong>Visits</strong><span>${topic.visitCount}</span></div>
          <div><strong>Estimated time</strong><span>${topic.estimatedDwellMinutes}m</span></div>
          <div><strong>Top domains</strong><span>${topic.topDomains.map(d => escapeHtml(d.domain)).join(', ')}</span></div>
        </div>
        <h3>Evidence pages</h3>
        ${pageList(topic.topPages)}
        <form id="topic-correction" class="correction-form">
          <label>Correct topic label</label>
          <input name="label" value="${escapeAttribute(topic.label)}" />
          <button type="submit">Save correction</button>
        </form>
      </div>
    `;
    document.getElementById('topic-correction').addEventListener('submit', async event => {
      event.preventDefault();
      const label = new FormData(event.currentTarget).get('label').toString().trim();
      if (!label) return;
      await AttentionAnalysis.TrustStore.saveCorrection({ kind: 'topic', targetId: topic.id, label });
      topic.label = label;
      this.renderAnalysis(this.analysis);
      this.selectTopic(topic);
    });
  }

  selectTransition(transition) {
    this.selected = { kind: 'transition', id: transition.id };
    this.highlightTransition(transition.id);
    const panel = document.getElementById('evidence-panel');
    panel.innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Topic Flow</div>
        <h2>${escapeHtml(transition.sourceLabel)} -> ${escapeHtml(transition.targetLabel)}</h2>
        <div class="flow-type" style="border-color:${transition.color}">${escapeHtml(transition.label)}</div>
        ${confidenceBar(transition.confidence)}
        <p>${escapeHtml(transition.rationale)}</p>
        <div class="metric-list">
          <div><strong>Observed transitions</strong><span>${transition.visitCount}</span></div>
          <div><strong>Avg gap</strong><span>${transition.estimatedGapMinutes}m estimated</span></div>
          <div><strong>Topic similarity</strong><span>${transition.similarity.toFixed(2)}</span></div>
        </div>
        <h3>Representative visits</h3>
        ${transitionExamples(transition.representativeVisits)}
        <form id="transition-correction" class="correction-form">
          <label>Correct flow label</label>
          <select name="type">
            ${Object.keys(FLOW_COLORS).map(type => `<option value="${type}" ${type === transition.type ? 'selected' : ''}>${FLOW_COLORS[type].label}</option>`).join('')}
          </select>
          <button type="submit">Save correction</button>
        </form>
      </div>
    `;
    document.getElementById('transition-correction').addEventListener('submit', async event => {
      event.preventDefault();
      const type = new FormData(event.currentTarget).get('type').toString();
      await AttentionAnalysis.TrustStore.saveCorrection({ kind: 'transition', targetId: transition.id, type });
      transition.type = type;
      transition.label = FLOW_COLORS[type].label;
      transition.color = FLOW_COLORS[type].color;
      this.renderAnalysis(this.analysis);
      this.selectTransition(transition);
    });
  }

  selectPage(page, topicId) {
    this.selected = { kind: 'page', id: page.id };
    this.highlightTopic(topicId);
    document.getElementById('evidence-panel').innerHTML = `
      <div class="evidence-section">
        <div class="panel-kicker">Page Evidence</div>
        <h2>${escapeHtml(page.title)}</h2>
        <div class="metric-list">
          <div><strong>Domain</strong><span>${escapeHtml(page.domain)}</span></div>
          <div><strong>Visits</strong><span>${page.visitCount}</span></div>
          <div><strong>Estimated time</strong><span>${page.estimatedDwellMinutes}m</span></div>
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
    if (this.linkSelection) this.linkSelection.style('opacity', link => Math.max(0.38, Math.min(0.85, link.transition.confidence)));
    if (this.membershipSelection) this.membershipSelection.style('opacity', 1);
  }

  clearSelection() {
    this.selected = null;
    this.clearHighlight();
    if (this.analysis && this.analysis.ok) this.renderDefaultEvidence(this.analysis);
  }

  updateLevelOfDetail(scale) {
    this.currentScale = scale;
    if (!this.labelSelection) return;
    this.labelSelection.style('display', d => {
      if (d.type === 'topic') return 'block';
      return scale >= 1.1 ? 'block' : 'none';
    });
    if (this.sublabelSelection) {
      this.sublabelSelection.style('display', scale >= 0.7 ? 'block' : 'none');
    }
    if (this.membershipSelection) {
      this.membershipSelection.style('display', scale >= 0.65 ? 'block' : 'none');
    }
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
    const scale = Math.min(1.35, Math.max(0.25, Math.min(this.width / width, this.height / height)));
    const tx = this.width / 2 - ((x[0] + x[1]) / 2) * scale;
    const ty = this.height / 2 - ((y[0] + y[1]) / 2) * scale;
    const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
    if (immediate) this.svg.call(this.zoom.transform, transform);
    else this.svg.transition().duration(350).call(this.zoom.transform, transform);
  }

  dragStarted(event, d) {
    if (!event.active) this.simulation.alphaTarget(0.25).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  dragEnded(event, d) {
    if (!event.active) this.simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
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
    return `<strong>${escapeHtml(topic.label)}</strong><br>#${topic.attentionRank || '?'} ${escapeHtml(topic.attentionBandLabel || 'topic')}<br>${topic.visitCount} visits · ${topic.estimatedDwellMinutes}m estimated<br>${formatPercent(topic.attentionShare || 0)} of mapped active time<br>Confidence ${Math.round(topic.confidence * 100)}%`;
  }

  pageTooltip(page) {
    return `<strong>${escapeHtml(page.domain)}</strong><br>${escapeHtml(page.title)}<br>${page.visitCount} visits`;
  }

  transitionTooltip(transition) {
    return `<strong>${escapeHtml(transition.sourceLabel)} -> ${escapeHtml(transition.targetLabel)}</strong><br>${escapeHtml(transition.label)}<br>${transition.visitCount} consecutive visits<br>Avg gap ${transition.estimatedGapMinutes}m<br>Confidence ${Math.round(transition.confidence * 100)}%`;
  }
}

function shortenLine(source, target, sourcePadding, targetPadding) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    x1: source.x + dx * (sourcePadding / distance),
    y1: source.y + dy * (sourcePadding / distance),
    x2: target.x - dx * (targetPadding / distance),
    y2: target.y - dy * (targetPadding / distance)
  };
}

function confidenceBar(confidence) {
  const pct = Math.round((confidence || 0) * 100);
  return `
    <div class="confidence">
      <div class="confidence-meta"><span>Confidence</span><strong>${pct}%</strong></div>
      <div class="confidence-track"><div style="width:${pct}%"></div></div>
    </div>
  `;
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
      <span>to ${escapeHtml(item.to.title)} · ${item.estimatedGapMinutes}m gap</span>
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

document.addEventListener('DOMContentLoaded', () => {
  if (typeof d3 === 'undefined') {
    document.getElementById('loading').textContent = 'D3.js library not loaded. Reload the extension.';
    return;
  }
  new TopicMapVisualizer();
});
