/**
 * force-graph.js — D3 force simulation for the network topology graph.
 *
 * Manages entity nodes, relationship links, and the force simulation.
 * Delegates rendering to NodeRenderer and ConnectionRenderer.
 *
 * KEY BEHAVIORS:
 *   - Cluster forces group nodes by entity type around the insurer center.
 *   - Nodes are draggable — drag pins a node; double-click unpins it.
 *   - Only reheats simulation when the node set actually changes.
 *   - Data-only updates (leviathan status, member enrollment) update
 *     in place with zero simulation reheat.
 *   - Animated connections dynamically track moving node positions.
 */

/** Cluster target positions relative to center (angle in radians). */
const CLUSTER_ANGLES = {
  insurer:    null, // dead center
  employer:   null, // near center
  leviathan:  -Math.PI / 2,      // top
  member:     Math.PI,            // left
  prescriber: 0,                  // right
  pharmacy:   Math.PI / 2,        // bottom
};
const CLUSTER_RADIUS = {
  insurer: 0,
  employer: 60,
  leviathan: 180,
  member: 220,
  prescriber: 220,
  pharmacy: 220,
};

class ForceGraph {
  constructor(svgElement) {
    this.svg = d3.select(svgElement);
    this.width = 0;
    this.height = 0;

    // Install SVG defs (glow filter etc)
    NodeRenderer.installDefs(this.svg);

    // Container <g> for zoom/pan transform — wraps all layers
    this.container = this.svg.append('g').attr('class', 'zoom-container');

    // Create SVG layers inside the zoom container
    this.linkLayer = this.container.append('g').attr('class', 'link-layer');
    this.connectionLayer = this.container.append('g').attr('class', 'connection-layer');
    this.nodeLayer = this.container.append('g').attr('class', 'node-layer');

    /** @type {Array} */
    this.nodes = [];
    /** @type {d3.Selection} */
    this.nodeSelection = this.nodeLayer.selectAll('.node-group');

    /** @type {ConnectionRenderer} */
    this.connectionRenderer = new ConnectionRenderer(this.connectionLayer);

    /** @type {d3.Simulation} */
    this.simulation = null;

    // Node click handler
    this.onNodeClick = null;

    // Track current node IDs to detect changes
    this.currentNodeIds = '';

    // Active animated connections (for dynamic position tracking)
    this.activeConnections = [];

    // Relationship tracker for PCP/pharmacy links
    this.relationshipTracker = new RelationshipTracker();

    // Current zoom transform (for coordinate mapping)
    this.currentTransform = d3.zoomIdentity;

    this.initZoom();
    this.initSimulation();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Set up D3 zoom/pan behavior on the SVG. */
  initZoom() {
    this.zoom = d3.zoom()
      .scaleExtent([0.2, 4])      // zoom range: 20% to 400%
      .on('zoom', (event) => {
        this.currentTransform = event.transform;
        this.container.attr('transform', event.transform);
      });

    this.svg
      .call(this.zoom)
      .on('dblclick.zoom', null);   // disable double-click zoom (used for unpin)
  }

  resize() {
    const rect = this.svg.node().parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.svg
      .attr('width', this.width)
      .attr('height', this.height);
    if (this.simulation) {
      this.updateClusterForces();
      this.simulation.alpha(0.1).restart();
    }
  }

  /** Compute cluster target x/y for a node based on entity type. */
  clusterTarget(type) {
    const angle = CLUSTER_ANGLES[type];
    const r = CLUSTER_RADIUS[type] || 200;
    const cx = this.width / 2;
    const cy = this.height / 2;
    if (angle == null) {
      // Center entities (insurer/employer) — slight offset for employer
      return { x: cx + (type === 'employer' ? 55 : 0), y: cy + (type === 'employer' ? -40 : 0) };
    }
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  }

  /** Update the cluster-aware position forces. */
  updateClusterForces() {
    this.simulation
      .force('center', null) // remove center — we use per-node x/y forces
      .force('clusterX', d3.forceX(d => this.clusterTarget(d.entityType).x).strength(0.08))
      .force('clusterY', d3.forceY(d => this.clusterTarget(d.entityType).y).strength(0.08));
  }

  initSimulation() {
    this.simulation = d3.forceSimulation(this.nodes)
      .force('charge', d3.forceManyBody().strength(-120))
      .force('collision', d3.forceCollide().radius(42))
      .alphaDecay(0.02)
      .on('tick', () => this.tick());

    this.updateClusterForces();
  }

  /** D3 drag behavior — drag pins a node, double-click unpins. */
  makeDrag() {
    const sim = this.simulation;
    const self = this;
    return d3.drag()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.1).restart();
        // Transform event coords to simulation space
        const [sx, sy] = self.screenToSim(event.sourceEvent);
        d.fx = sx;
        d.fy = sy;
      })
      .on('drag', (event, d) => {
        const [sx, sy] = self.screenToSim(event.sourceEvent);
        d.fx = sx;
        d.fy = sy;
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        // Keep node pinned where user dropped it
      });
  }

  /** Convert a mouse/touch event to simulation coordinates (accounting for zoom). */
  screenToSim(sourceEvent) {
    if (!sourceEvent) return [0, 0];
    const svgNode = this.svg.node();
    const pt = svgNode.createSVGPoint();
    pt.x = sourceEvent.clientX;
    pt.y = sourceEvent.clientY;
    const svgPt = pt.matrixTransform(svgNode.getScreenCTM().inverse());
    // Invert the zoom transform
    const t = this.currentTransform;
    return [(svgPt.x - t.x) / t.k, (svgPt.y - t.y) / t.k];
  }

  tick() {
    // Update node positions
    this.nodeSelection.each(function(d) {
      d3.select(this).attr('transform', `translate(${d.x},${d.y})`);
    });

    // Update relationship link positions
    this.linkLayer.selectAll('.relationship-link')
      .attr('x1', d => { const n = this.findNode(d.source); return n ? n.x : 0; })
      .attr('y1', d => { const n = this.findNode(d.source); return n ? n.y : 0; })
      .attr('x2', d => { const n = this.findNode(d.target); return n ? n.x : 0; })
      .attr('y2', d => { const n = this.findNode(d.target); return n ? n.y : 0; });

    // Update active animated connections to follow nodes
    this.tickActiveConnections();
  }

  findNode(id) {
    return this.nodes.find(n => n.id === id);
  }

  /**
   * Set the full set of entity nodes for the graph.
   * Only performs a full data join + simulation reheat if the node set changed.
   * If only data changed (same IDs), updates data in place with no reheat.
   */
  setEntities(entities) {
    // Check if the node set actually changed
    const newIds = entities.map(e => e.id).sort().join(',');
    const setChanged = newIds !== this.currentNodeIds;

    if (!setChanged) {
      // Same nodes — just update data properties in place (no reheat)
      this.updateNodeData(entities);
      return;
    }

    this.currentNodeIds = newIds;

    // Preserve existing positions for nodes that already exist
    const posMap = new Map(this.nodes.map(n => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy }]));

    this.nodes = entities.map(e => {
      const existing = posMap.get(e.id);
      if (existing) {
        return { ...e, x: existing.x, y: existing.y, vx: existing.vx, vy: existing.vy, fx: existing.fx, fy: existing.fy };
      }
      // New node — place near its cluster target
      const target = this.clusterTarget(e.entityType);
      return {
        ...e,
        x: target.x + (Math.random() - 0.5) * 80,
        y: target.y + (Math.random() - 0.5) * 80,
        vx: 0, vy: 0,
      };
    });

    // Rebind to simulation
    this.simulation.nodes(this.nodes);

    // Update D3 selection
    this.nodeSelection = this.nodeLayer.selectAll('.node-group')
      .data(this.nodes, d => d.id);

    // Remove exiting nodes
    this.nodeSelection.exit().remove();

    // Enter new nodes
    const entered = NodeRenderer.renderNodeEnter(this.nodeSelection.enter());

    // Set up click + drag handlers
    const drag = this.makeDrag();
    entered.call(drag);
    entered.on('click', (event, d) => {
      if (event.defaultPrevented) return; // ignore drag clicks
      if (this.onNodeClick) this.onNodeClick(d, event);
    });
    // Double-click unpins
    entered.on('dblclick', (event, d) => {
      d.fx = null;
      d.fy = null;
      this.simulation.alpha(0.1).restart();
    });

    // Merge
    this.nodeSelection = entered.merge(this.nodeSelection);

    // Update leviathan + member info for existing nodes
    this.nodeSelection.each(function(d) {
      if (d.entityType === 'leviathan') {
        NodeRenderer.updateLeviathanInfo(d3.select(this), d);
      }
      if (d.entityType === 'member') {
        NodeRenderer.updateMemberState(d3.select(this), d);
      }
    });

    // Gently reheat only for structural changes
    this.simulation.alpha(0.15).restart();
  }

  /**
   * Update node data properties in place without recreating DOM or reheating simulation.
   * This prevents nodes from moving on every poll.
   */
  updateNodeData(entities) {
    const entityMap = new Map(entities.map(e => [e.id, e]));

    // Update data on existing nodes
    for (const node of this.nodes) {
      const updated = entityMap.get(node.id);
      if (!updated) continue;
      // Copy data properties (but NOT position/velocity/pin)
      const { x, y, vx, vy, fx, fy } = node;
      Object.assign(node, updated);
      node.x = x; node.y = y; node.vx = vx; node.vy = vy;
      node.fx = fx; node.fy = fy;
    }

    // Update visual state for leviathans + members
    this.nodeSelection.each(function(d) {
      if (d.entityType === 'leviathan') {
        NodeRenderer.updateLeviathanInfo(d3.select(this), d);
      }
      if (d.entityType === 'member') {
        NodeRenderer.updateMemberState(d3.select(this), d);
      }
    });
  }

  /**
   * Update relationship links from the tracker.
   */
  updateRelationships(stateData) {
    this.relationshipTracker.update(stateData);
    const links = this.relationshipTracker.getLinks();

    // Update force link
    this.simulation.force('links', d3.forceLink(links)
      .id(d => d.id)
      .distance(d => d.distance || 150)
      .strength(d => d.strength || 0.03)
    );

    // Draw relationship lines
    const linkSel = this.linkLayer.selectAll('.relationship-link')
      .data(links, d => `${d.source}::${d.target}`);

    linkSel.exit().remove();

    linkSel.enter().append('line')
      .attr('class', 'relationship-link')
      .attr('stroke', d => {
        if (d.type === 'member-prescriber') return 'rgba(102,187,106,0.12)';
        if (d.type === 'member-pharmacy') return 'rgba(255,167,38,0.12)';
        return 'rgba(255,255,255,0.05)';
      })
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2 4');

    // No reheat — relationships update silently
  }

  /**
   * Animate a viz event connection between two entities.
   * The connection dynamically follows the source/target nodes.
   */
  animateEvent(fromId, toId, eventType) {
    const config = EVENT_CONFIG[eventType];
    if (!config) return;

    const fromNode = this.findNode(fromId);
    const toNode = this.findNode(toId);
    if (!fromNode || !toNode) return;

    // Create line that will track nodes
    const line = this.connectionLayer.append('line')
      .attr('class', 'connection-line')
      .attr('x1', fromNode.x).attr('y1', fromNode.y)
      .attr('x2', toNode.x).attr('y2', toNode.y)
      .attr('stroke', config.color)
      .attr('stroke-width', config.width)
      .attr('stroke-dasharray', config.dash || 'none')
      .attr('opacity', 0);

    // Fade in then out
    line.transition().duration(200)
      .attr('opacity', 0.7)
      .transition().duration(config.duration)
      .attr('opacity', 0)
      .remove();

    // Register for dynamic tracking
    const conn = { fromId, toId, line: line.node(), startTime: Date.now(), duration: config.duration + 200 };
    this.activeConnections.push(conn);

    // Traveling particle
    if (config.particle) {
      const particle = this.connectionLayer.append('circle')
        .attr('class', 'connection-particle')
        .attr('r', 4)
        .attr('cx', fromNode.x).attr('cy', fromNode.y)
        .attr('fill', config.color)
        .attr('opacity', 0.9);

      conn.particle = particle.node();
      conn.particleDuration = config.duration * 0.8;
      conn.particleStart = Date.now();
    }
  }

  /**
   * Update active animated connections to follow node positions.
   * Called on every simulation tick.
   */
  tickActiveConnections() {
    const now = Date.now();
    const alive = [];

    for (const conn of this.activeConnections) {
      const elapsed = now - conn.startTime;
      if (elapsed > conn.duration) {
        // Cleanup
        if (conn.particle && conn.particle.parentNode) conn.particle.remove();
        continue;
      }

      const fromNode = this.findNode(conn.fromId);
      const toNode = this.findNode(conn.toId);
      if (!fromNode || !toNode) continue;

      // Update line endpoints to follow nodes
      if (conn.line && conn.line.parentNode) {
        d3.select(conn.line)
          .attr('x1', fromNode.x).attr('y1', fromNode.y)
          .attr('x2', toNode.x).attr('y2', toNode.y);
      }

      // Update particle position — interpolate along the line
      if (conn.particle && conn.particle.parentNode) {
        const pElapsed = now - conn.particleStart;
        const t = Math.min(1, pElapsed / conn.particleDuration);
        const px = fromNode.x + (toNode.x - fromNode.x) * t;
        const py = fromNode.y + (toNode.y - fromNode.y) * t;
        d3.select(conn.particle)
          .attr('cx', px).attr('cy', py)
          .attr('opacity', 0.9 - t * 0.6);
        if (t >= 1 && conn.particle.parentNode) {
          conn.particle.remove();
        }
      }

      alive.push(conn);
    }

    this.activeConnections = alive;
  }

  /**
   * Animate gossip relay between two leviathans (particle only, no persistent line).
   */
  animateGossipRelay(fromId, toId) {
    this.animateEvent(fromId, toId, 'viz:leviathan:gossip');
  }

  /**
   * Handle heartbeat pulse on a leviathan node.
   */
  handleHeartbeat(leviathanId) {
    const g = this.nodeLayer.select(`[data-id="${leviathanId}"]`);
    if (!g.empty()) {
      NodeRenderer.pulseHeartbeat(g);
    }
  }

  /**
   * Pulse a node by ID.
   */
  pulseNode(nodeId, color, count = 1) {
    const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
    if (!g.empty()) {
      NodeRenderer.pulseNode(g, color, count);
    }
  }

  /**
   * Set enrolling overlay on a member node.
   */
  setEnrollingOverlay(nodeId, enrolling) {
    const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
    if (!g.empty()) {
      NodeRenderer.setEnrollingOverlay(g, enrolling);
    }
  }

  /**
   * Set proving spinner on a node.
   */
  setProvingSpinner(nodeId, proving) {
    const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
    if (!g.empty()) {
      NodeRenderer.setProvingSpinner(g, proving);
    }
  }

  /**
   * Update a member's enrollment state and recolor the node.
   */
  setMemberState(nodeId, enrollmentState) {
    const node = this.findNode(nodeId);
    if (node) {
      node.enrollmentState = enrollmentState;
      const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
      if (!g.empty()) {
        NodeRenderer.updateMemberState(g, node);
      }
    }
  }
}
