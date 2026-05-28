/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
  worker:     -Math.PI / 2 + 0.4, // near leviathan, slightly offset
  member:     Math.PI,            // left
  prescriber: 0,                  // right
  pharmacy:   Math.PI / 2,        // bottom
};
const CLUSTER_RADIUS = {
  insurer: 0,
  employer: 60,
  leviathan: 180,
  worker: 130,
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

    // Animation frame loop ID (runs independently of simulation)
    this._animFrameId = null;

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

    // Note: animated connections are driven by _ensureAnimationLoop / rAF,
    // not by the simulation tick, so they keep running after simulation cools.
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

    // Create weak spring links between workers and their parent leviathan
    const workerLinks = this.nodes
      .filter(n => n.entityType === 'worker')
      .map(n => ({
        source: n.id,
        target: n.parentLeviathanId || 'lev-alpha',
        distance: 55,
        strength: 0.12,
      }));
    if (workerLinks.length > 0) {
      this.simulation.force('workerLinks', d3.forceLink(workerLinks)
        .id(d => d.id)
        .distance(d => d.distance)
        .strength(d => d.strength)
      );
    } else {
      this.simulation.force('workerLinks', null);
    }

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

    // Update leviathan + member + worker info for existing nodes
    this.nodeSelection.each(function(d) {
      if (d.entityType === 'leviathan') {
        NodeRenderer.updateLeviathanInfo(d3.select(this), d);
      }
      if (d.entityType === 'member') {
        NodeRenderer.updateMemberState(d3.select(this), d);
      }
      if (d.entityType === 'worker') {
        NodeRenderer.updateWorkerState(d3.select(this), d);
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

    // Update visual state for leviathans + members + workers
    this.nodeSelection.each(function(d) {
      if (d.entityType === 'leviathan') {
        NodeRenderer.updateLeviathanInfo(d3.select(this), d);
      }
      if (d.entityType === 'member') {
        NodeRenderer.updateMemberState(d3.select(this), d);
      }
      if (d.entityType === 'worker') {
        NodeRenderer.updateWorkerState(d3.select(this), d);
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
   *
   * Animation phases (tick-driven, not CSS transitions):
   *   Phase 1 (0–45%):  Leading edge extends from A toward B (trailing edge at A)
   *   Phase 2 (45–90%): Trailing edge retracts from A toward B (leading edge at B)
   *   Phase 3 (90–100%): Opacity fades to 0
   *
   * No particles — all animation is line-based to avoid lingering dots.
   */
  /**
   * Get or create an SVG arrow marker for a given color.
   * Markers are cached in <defs> so each color only creates one marker.
   */
  _getArrowMarkerId(color) {
    const safeColor = color.replace(/[^a-zA-Z0-9]/g, '');
    const markerId = `arrow-${safeColor}`;
    if (!this.svg.select(`#${markerId}`).empty()) return markerId;

    const defs = this.svg.select('defs');
    const marker = defs.append('marker')
      .attr('id', markerId)
      .attr('viewBox', '0 0 10 6')
      .attr('refX', 10)
      .attr('refY', 3)
      .attr('markerWidth', 8)
      .attr('markerHeight', 6)
      .attr('orient', 'auto');
    marker.append('path')
      .attr('d', 'M0,0 L10,3 L0,6 Z')
      .attr('fill', color);

    return markerId;
  }

  animateEvent(fromId, toId, eventType) {
    const config = EVENT_CONFIG[eventType];
    if (!config) return;

    const fromNode = this.findNode(fromId);
    const toNode = this.findNode(toId);
    if (!fromNode || !toNode) return;

    const markerId = this._getArrowMarkerId(config.color);

    // Create curved path starting at fromNode — extends toward toNode via tick.
    // Uses a quadratic Bezier with a perpendicular control-point offset for a slight arc.
    const path = this.connectionLayer.append('path')
      .attr('class', 'connection-line')
      .attr('d', `M${fromNode.x},${fromNode.y} L${fromNode.x},${fromNode.y}`)
      .attr('fill', 'none')
      .attr('stroke', config.color)
      .attr('stroke-width', config.width)
      .attr('stroke-linecap', 'round')
      .attr('stroke-dasharray', config.dash || 'none')
      .attr('opacity', 0.55)
      .attr('marker-end', `url(#${markerId})`);

    // Register for tick-based extend/retract animation
    this.activeConnections.push({
      fromId, toId,
      el: path.node(),
      startTime: Date.now(),
      duration: config.duration,
      color: config.color,
      pulsed: false, // track whether we've pulsed the target node
    });

    // Ensure the rAF loop is running (survives simulation cooldown)
    this._ensureAnimationLoop();
  }

  /**
   * Start the rAF animation loop if not already running.
   * This loop drives connection animations independently of the D3 simulation,
   * so animations complete even after the simulation cools down and stops ticking.
   */
  _ensureAnimationLoop() {
    if (this._animFrameId != null) return;
    const loop = () => {
      this.tickActiveConnections();
      if (this.activeConnections.length > 0) {
        this._animFrameId = requestAnimationFrame(loop);
      } else {
        this._animFrameId = null;
      }
    };
    this._animFrameId = requestAnimationFrame(loop);
  }

  /**
   * Update active animated connections to follow node positions.
   * Driven by rAF loop (_ensureAnimationLoop), independent of D3 simulation.
   *
   * The arrow travels along a FIXED curved arc from A to B.
   * The arc shape is defined by the full A→B distance (not the visible segment),
   * so it stays consistent as the arrow slides along the path.
   *
   * Sub-curve extraction uses quadratic Bezier math:
   *   B(t) = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2
   *   Sub-curve control point derived from 3 sampled points via midpoint inversion.
   *
   *   Phase 1 (0–45%):  Arrow head extends from A toward B along the arc
   *   Phase 2 (45–90%): Arrow tail retracts from A toward B along the arc
   *   Phase 3 (90–100%): Opacity fades to 0
   */
  tickActiveConnections() {
    const now = Date.now();
    const alive = [];

    // Smooth ease-in-out
    const ease = (v) => v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2;

    // Evaluate quadratic Bezier at parameter t
    const qB = (t, p0, p1, p2) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

    for (const conn of this.activeConnections) {
      const elapsed = now - conn.startTime;

      // Expired — clean up
      if (elapsed > conn.duration) {
        if (conn.el && conn.el.parentNode) conn.el.remove();
        continue;
      }

      const fromNode = this.findNode(conn.fromId);
      const toNode = this.findNode(conn.toId);
      if (!fromNode || !toNode) {
        if (conn.el && conn.el.parentNode) conn.el.remove();
        continue;
      }

      const t = elapsed / conn.duration;

      let headT, tailT, opacity;
      if (t <= 0.45) {
        headT = ease(t / 0.45);
        tailT = 0;
        opacity = 0.55;
      } else if (t <= 0.9) {
        headT = 1;
        tailT = ease((t - 0.45) / 0.45);
        opacity = 0.55;

        // Pulse the target node when the arrow first arrives
        if (!conn.pulsed) {
          conn.pulsed = true;
          this._pulseTargetNode(conn.toId, conn.color);
        }
      } else {
        headT = 1;
        tailT = 1;
        opacity = 0.55 * (1 - (t - 0.9) / 0.1);
      }

      // Full A→B arc — control point is FIXED relative to the full path, not the visible segment
      const ax = fromNode.x, ay = fromNode.y;
      const bx = toNode.x, by = toNode.y;
      const fullDx = bx - ax, fullDy = by - ay;
      const fullLen = Math.sqrt(fullDx * fullDx + fullDy * fullDy) || 1;
      const curvature = 0.18;
      // Perpendicular offset for the fixed arc control point
      const cpx = (ax + bx) / 2 + (-fullDy / fullLen) * fullLen * curvature;
      const cpy = (ay + by) / 2 + (fullDx / fullLen) * fullLen * curvature;

      // Sample 3 points on the full Bezier at tailT, midT, headT
      const sx = qB(tailT, ax, cpx, bx);
      const sy = qB(tailT, ay, cpy, by);
      const ex = qB(headT, ax, cpx, bx);
      const ey = qB(headT, ay, cpy, by);
      const midT = (tailT + headT) / 2;
      const mx = qB(midT, ax, cpx, bx);
      const my = qB(midT, ay, cpy, by);

      // Derive sub-curve control point from the midpoint:
      // For a quadratic Bezier, B(0.5) = P0/4 + P1/2 + P2/4
      // So P1 = 2*B(0.5) - P0/2 - P2/2
      const scx = 2 * mx - sx / 2 - ex / 2;
      const scy = 2 * my - sy / 2 - ey / 2;

      if (conn.el && conn.el.parentNode) {
        const sel = d3.select(conn.el);
        sel.attr('d', `M${sx},${sy} Q${scx},${scy} ${ex},${ey}`)
           .attr('opacity', opacity);

        // Remove arrowhead once the leading edge arrives at destination (Phase 2+)
        // to prevent the marker spinning on near-zero-length path segments.
        if (headT >= 1 && !conn.markerRemoved) {
          conn.markerRemoved = true;
          sel.attr('marker-end', null);
        }
      }

      alive.push(conn);
    }

    this.activeConnections = alive;
  }

  /**
   * Pulse a target node when an arrow arrives — quick scale-up then ease back.
   * Scales the .node-shape element (not the group) to avoid conflict with
   * the simulation tick's translate transform on the parent group.
   */
  _pulseTargetNode(nodeId, color) {
    const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
    if (g.empty()) return;

    const shape = g.select('.node-shape');
    if (shape.empty()) return;

    // Cancel any in-progress pulse so they don't stack
    shape.interrupt('arrival-pulse');

    shape.transition('arrival-pulse')
      .duration(100)
      .attr('transform', 'scale(1.2)')
      .transition()
      .duration(400)
      .ease(d3.easeCubicOut)
      .attr('transform', 'scale(1)');
  }

  /**
   * Animate gossip relay between two leviathans.
   * Emits sonar ripple from sender, runs connection animation, and
   * triggers absorb glow on the receiver when the arrow arrives.
   */
  animateGossipRelay(fromId, toId) {
    // Sonar ripple from sender
    const fromG = this.nodeLayer.select(`[data-id="${fromId}"]`);
    if (!fromG.empty()) {
      NodeRenderer.emitSonarRipple(fromG);
    }

    // Standard connection animation (arrow A→B)
    this.animateEvent(fromId, toId, 'viz:leviathan:gossip');

    // Absorb glow on receiver when arrow arrives (~45% of 2500ms = 1125ms)
    setTimeout(() => {
      const toG = this.nodeLayer.select(`[data-id="${toId}"]`);
      if (!toG.empty()) {
        NodeRenderer.absorbGlow(toG);
      }
    }, 1100);
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

  // ─── Worker helpers ─────────────────────────────────────

  /**
   * Trigger spawn animation on a worker node (called when viz:worker:spawned arrives).
   */
  spawnWorkerNode(nodeId) {
    const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
    if (!g.empty()) {
      NodeRenderer.spawnWorkerAnimation(g);
    }
  }

  /**
   * Toggle a worker between idle and proving state.
   */
  setWorkerProving(nodeId, proving) {
    const node = this.findNode(nodeId);
    if (node) {
      node.workerStatus = proving ? 'proving' : 'idle';
      const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
      if (!g.empty()) {
        NodeRenderer.updateWorkerState(g, node);
      }
    }
  }

  /**
   * Set worker to compiling state (visible but still starting up).
   */
  setWorkerCompiling(nodeId) {
    const node = this.findNode(nodeId);
    if (node) {
      node.workerStatus = 'compiling';
      const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
      if (!g.empty()) {
        NodeRenderer.updateWorkerState(g, node);
      }
    }
  }

  /**
   * Set worker to ready (idle) state after compilation completes.
   */
  setWorkerReady(nodeId) {
    const node = this.findNode(nodeId);
    if (node) {
      node.workerStatus = 'idle';
      const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
      if (!g.empty()) {
        NodeRenderer.updateWorkerState(g, node);
        // Brief green pulse to signal compilation success
        this.pulseNode(nodeId, '#66bb6a', 2);
      }
    }
  }

  /**
   * Set worker to timeout state (compilation failed to complete in time).
   */
  setWorkerTimeout(nodeId) {
    const node = this.findNode(nodeId);
    if (node) {
      node.workerStatus = 'timeout';
      const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
      if (!g.empty()) {
        NodeRenderer.updateWorkerState(g, node);
      }
    }
  }

  /**
   * Crash animation on a worker node — red flash + collapse.
   */
  crashWorkerNode(nodeId) {
    const node = this.findNode(nodeId);
    if (node) {
      node.workerStatus = 'dead';
    }
    const g = this.nodeLayer.select(`[data-id="${nodeId}"]`);
    if (!g.empty()) {
      NodeRenderer.crashWorkerAnimation(g);
    }
  }
}
