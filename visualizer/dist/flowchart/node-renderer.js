/**
 * node-renderer.js — D3 node shape rendering for the force graph.
 *
 * Renders different shapes per entity type:
 *   member      → circle (gray=unenrolled, blue=enrolling, green=enrolled)
 *   prescriber  → diamond (blue)
 *   pharmacy    → rounded-rect (orange)
 *   insurer     → hexagon (purple)
 *   leviathan   → double-ring (green)
 *   employer    → briefcase (gold)
 */

const NODE_COLORS = {
  member:     'var(--node-member-gray)',
  prescriber: 'var(--node-prescriber)',
  pharmacy:   'var(--node-pharmacy)',
  insurer:    'var(--node-insurer)',
  leviathan:  'var(--node-leviathan)',
  employer:   'var(--node-employer)',
  worker:     'var(--node-worker)',
};

/** Raw hex values for SVG filter/fill operations that can't use CSS vars */
const NODE_COLORS_HEX = {
  member_gray:     '#546e7a',
  member_enrolling:'#4fc3f7',
  member_enrolled: '#66bb6a',
  prescriber:      '#66bb6a',
  pharmacy:        '#ffa726',
  insurer:         '#ab47bc',
  leviathan:       '#26c6da',
  employer:        '#ffee58',
  worker:          '#ffc107',
};

const NODE_RADIUS = {
  member: 18,
  prescriber: 20,
  pharmacy: 22,
  insurer: 24,
  leviathan: 28,
  employer: 20,
  worker: 17,
};

/** Get the color for a member based on enrollment state. */
function getMemberColor(d) {
  if (d.enrollmentState === 'enrolled') return NODE_COLORS_HEX.member_enrolled;
  if (d.enrollmentState === 'enrolling') return NODE_COLORS_HEX.member_enrolling;
  return NODE_COLORS_HEX.member_gray;
}

/** Get the fill gradient for a node. */
function getNodeFill(type, d) {
  if (type === 'member') {
    const c = getMemberColor(d);
    return hexToFill(c, 0.15);
  }
  const hex = NODE_COLORS_HEX[type] || '#888';
  return hexToFill(hex, 0.12);
}

function hexToFill(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getNodeStroke(type, d) {
  if (type === 'member') return getMemberColor(d);
  return NODE_COLORS_HEX[type] || '#888';
}

class NodeRenderer {

  /** Install SVG <defs> for glow filters and arrow markers. Call once on svg element. */
  static installDefs(svg) {
    const defs = svg.append('defs');

    // Generic glow filter
    const glow = defs.append('filter')
      .attr('id', 'glow')
      .attr('x', '-50%').attr('y', '-50%')
      .attr('width', '200%').attr('height', '200%');
    glow.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', 3)
      .attr('result', 'blur');
    const merge = glow.append('feMerge');
    merge.append('feMergeNode').attr('in', 'blur');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Leviathan-specific teal glow filter (stronger, tinted)
    const levGlow = defs.append('filter')
      .attr('id', 'leviathan-glow')
      .attr('x', '-80%').attr('y', '-80%')
      .attr('width', '260%').attr('height', '260%');
    levGlow.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', 5)
      .attr('result', 'blur');
    // Tint the blur to teal (#26c6da → r=0.15, g=0.78, b=0.85)
    levGlow.append('feColorMatrix')
      .attr('in', 'blur')
      .attr('type', 'matrix')
      .attr('values', '0 0 0 0 0.15  0 0 0 0 0.78  0 0 0 0 0.85  0 0 0 0.6 0');
    const levMerge = levGlow.append('feMerge');
    levMerge.append('feMergeNode'); // tinted blur
    levMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Amber glow filter for worker nodes
    const workerGlow = defs.append('filter')
      .attr('id', 'worker-glow')
      .attr('x', '-60%').attr('y', '-60%')
      .attr('width', '220%').attr('height', '220%');
    workerGlow.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', 4)
      .attr('result', 'blur');
    // Tint to amber (#ffc107 → r=1.0, g=0.76, b=0.03)
    workerGlow.append('feColorMatrix')
      .attr('in', 'blur')
      .attr('type', 'matrix')
      .attr('values', '0 0 0 0 1.0  0 0 0 0 0.76  0 0 0 0 0.03  0 0 0 0.5 0');
    const wm = workerGlow.append('feMerge');
    wm.append('feMergeNode');
    wm.append('feMergeNode').attr('in', 'SourceGraphic');

    // Arrow marker template — one per color so each connection gets a matching arrowhead.
    // New markers are created dynamically by ForceGraph.getArrowMarkerId().
  }

  /**
   * Render entering nodes — called by D3 enter selection.
   */
  static renderNodeEnter(enter) {
    const g = enter.append('g')
      .attr('class', 'node-group')
      .attr('data-id', d => d.id);

    g.each(function(d) {
      const el = d3.select(this);
      const type = d.entityType || 'member';
      const r = NODE_RADIUS[type] || 18;
      const stroke = getNodeStroke(type, d);
      const fill = getNodeFill(type, d);

      if (type === 'leviathan') {
        NodeRenderer.renderDoubleRing(el, d, r, stroke);
      } else if (type === 'prescriber') {
        NodeRenderer.renderDiamond(el, r, stroke, fill);
      } else if (type === 'pharmacy') {
        NodeRenderer.renderRoundedRect(el, r, stroke, fill);
      } else if (type === 'insurer') {
        NodeRenderer.renderHexagon(el, r, stroke, fill);
      } else if (type === 'employer') {
        NodeRenderer.renderBriefcase(el, r, stroke, fill);
      } else if (type === 'worker') {
        NodeRenderer.renderOctagon(el, d, r, stroke, fill);
      } else {
        NodeRenderer.renderCircle(el, r, stroke, fill);
      }

      // Label
      el.append('text')
        .attr('class', 'node-label')
        .attr('y', r + 14)
        .text(d.label || d.id);

      // Sublabel
      if (d.sublabel) {
        el.append('text')
          .attr('class', 'node-sublabel')
          .attr('y', r + 25)
          .text(d.sublabel);
      }

      // Third label line (privacy mode wallet hash)
      if (d.line3) {
        el.append('text')
          .attr('class', 'node-sublabel node-line3')
          .attr('y', r + 36)
          .text(d.line3);
      }
    });

    return g;
  }

  /** Circle node (member). */
  static renderCircle(g, r, stroke, fill) {
    g.append('circle')
      .attr('class', 'node-shape')
      .attr('r', r)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2.5)
      .attr('filter', 'url(#glow)');
  }

  /** Diamond node (prescriber). */
  static renderDiamond(g, r, stroke, fill) {
    const pts = [
      [0, -r], [r, 0], [0, r], [-r, 0]
    ].map(p => p.join(',')).join(' ');
    g.append('polygon')
      .attr('class', 'node-shape')
      .attr('points', pts)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .attr('filter', 'url(#glow)');
  }

  /** Rounded rectangle (pharmacy). */
  static renderRoundedRect(g, r, stroke, fill) {
    g.append('rect')
      .attr('class', 'node-shape')
      .attr('x', -r)
      .attr('y', -r * 0.7)
      .attr('width', r * 2)
      .attr('height', r * 1.4)
      .attr('rx', 6)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .attr('filter', 'url(#glow)');
  }

  /** Hexagon (insurer). */
  static renderHexagon(g, r, stroke, fill) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      pts.push([r * Math.cos(angle), r * Math.sin(angle)]);
    }
    g.append('polygon')
      .attr('class', 'node-shape')
      .attr('points', pts.map(p => p.join(',')).join(' '))
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .attr('filter', 'url(#glow)');
  }

  /** Briefcase shape (employer) — rectangle with handle. */
  static renderBriefcase(g, r, stroke, fill) {
    const w = r * 2;
    const h = r * 1.3;
    // Body
    g.append('rect')
      .attr('class', 'node-shape')
      .attr('x', -w / 2)
      .attr('y', -h / 2 + 3)
      .attr('width', w)
      .attr('height', h)
      .attr('rx', 4)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .attr('filter', 'url(#glow)');
    // Handle
    g.append('path')
      .attr('d', `M${-r*0.35},${-h/2+3} L${-r*0.35},${-h/2-3} Q${-r*0.35},${-h/2-7} ${-r*0.15},${-h/2-7} L${r*0.15},${-h/2-7} Q${r*0.35},${-h/2-7} ${r*0.35},${-h/2-3} L${r*0.35},${-h/2+3}`)
      .attr('fill', 'none')
      .attr('stroke', stroke)
      .attr('stroke-width', 1.5);
    // Latch line
    g.append('line')
      .attr('x1', -r * 0.3).attr('y1', 0)
      .attr('x2', r * 0.3).attr('y2', 0)
      .attr('stroke', stroke)
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.5);
  }

  /** Double-ring for leviathan nodes. */
  static renderDoubleRing(g, d, r, stroke) {
    const fill = hexToFill(NODE_COLORS_HEX.leviathan, 0.12);

    // Leviathan index for phase offsets (0=alpha, 1=beta, 2=gamma)
    const levIndex = typeof d.primaryPartition === 'number' ? d.primaryPartition : 0;

    // Core glow circle — sits behind everything, provides the inner "life force" pulse
    g.append('circle')
      .attr('class', `leviathan-core-glow lev-phase-${levIndex}`)
      .attr('r', 22)
      .attr('fill', 'none')
      .attr('stroke', stroke)
      .attr('stroke-width', 3)
      .attr('opacity', 0.2)
      .attr('filter', 'url(#leviathan-glow)');

    // Outer dashed ring
    g.append('circle')
      .attr('class', 'leviathan-outer-ring')
      .attr('r', r + 6)
      .attr('fill', 'none')
      .attr('stroke', stroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4 3')
      .attr('opacity', 0.5);

    // Inner solid ring
    g.append('circle')
      .attr('class', 'node-shape leviathan-inner-ring')
      .attr('r', r)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2.5)
      .attr('filter', 'url(#glow)');

    // Role badge (S = sequencer, R = replica)
    const roleText = d.role === 'sequencer' ? 'S' : 'R';
    g.append('text')
      .attr('class', 'node-role-badge')
      .attr('y', -2)
      .text(roleText);

    // Partition badge
    const partitionText = 'P' + (d.primaryPartition ?? '?');
    g.append('text')
      .attr('class', 'node-partition-badge')
      .attr('y', 10)
      .attr('fill', stroke)
      .text(partitionText);

    // Note: CSS bobbing (translateY) conflicts with D3 simulation's translate() on the
    // same <g> element. The core glow + heartbeat + sonar provide sufficient "alive" feel.
  }

  /**
   * Update leviathan role/partition display on data refresh.
   * Handles alive → dead and dead → alive transitions with animation class toggling.
   */
  static updateLeviathanInfo(g, d) {
    const roleEl = g.select('.node-role-badge');
    if (!roleEl.empty()) {
      roleEl.text(d.role === 'sequencer' ? 'S' : 'R');
    }
    const partEl = g.select('.node-partition-badge');
    if (!partEl.empty()) {
      const parts = d.activePartitions || [d.primaryPartition];
      partEl.text(parts.map(p => 'P' + p).join(','));
    }
    // Dim stopped nodes — apply .leviathan-dead class which kills all animations
    const outerRing = g.select('.leviathan-outer-ring');
    if (!outerRing.empty()) {
      if (d.status === 'stopped') {
        g.classed('leviathan-dead', true);
        outerRing.attr('opacity', 0.15).attr('stroke', '#555');
        g.select('.leviathan-inner-ring').attr('stroke', '#555').attr('opacity', 0.4);
        roleEl.attr('fill', '#555');
        partEl.attr('fill', '#555');
      } else {
        g.classed('leviathan-dead', false);
        outerRing.attr('opacity', 0.5).attr('stroke', NODE_COLORS_HEX.leviathan);
        g.select('.leviathan-inner-ring').attr('stroke', NODE_COLORS_HEX.leviathan).attr('opacity', 1);
        roleEl.attr('fill', '#fff');
        partEl.attr('fill', NODE_COLORS_HEX.leviathan);
      }
    }
  }

  /**
   * Update member node color based on enrollment state.
   */
  static updateMemberState(g, d) {
    const shape = g.select('.node-shape');
    if (shape.empty()) return;
    const color = getMemberColor(d);
    shape.transition().duration(500)
      .attr('stroke', color)
      .attr('fill', hexToFill(color, 0.15));
  }

  /**
   * Add or remove an enrolling overlay ring on a member node.
   */
  static setEnrollingOverlay(g, enrolling) {
    g.select('.enrolling-ring').remove();
    if (enrolling) {
      const r = NODE_RADIUS.member + 6;
      g.insert('circle', '.node-label')
        .attr('class', 'enrolling-ring')
        .attr('r', r);
    }
  }

  /**
   * Add or remove a proving spinner on a node.
   */
  static setProvingSpinner(g, proving) {
    g.select('.proving-spinner').remove();
    if (proving) {
      const type = g.datum().entityType || 'member';
      const r = (NODE_RADIUS[type] || 18) + 8;
      g.insert('circle', '.node-label')
        .attr('class', 'proving-spinner')
        .attr('r', r);
    }
  }

  /**
   * Pulse a node's shape briefly.
   */
  static pulseNode(g, color, count = 1) {
    const shape = g.select('.node-shape');
    if (shape.empty()) return;
    const origStroke = shape.attr('stroke');
    const origWidth = parseFloat(shape.attr('stroke-width')) || 2;
    let i = 0;
    function flash() {
      if (i >= count) return;
      i++;
      shape.transition().duration(200)
        .attr('stroke', color)
        .attr('stroke-width', origWidth + 2)
        .transition().duration(400)
        .attr('stroke', origStroke)
        .attr('stroke-width', origWidth)
        .on('end', flash);
    }
    flash();
  }

  /**
   * Heartbeat double-pulse (lub-dub) on leviathan.
   * Adds a CSS class that triggers the heartbeat keyframe, plus
   * a core glow intensification for the biological effect.
   */
  static pulseHeartbeat(g) {
    // Skip if this leviathan is dead
    if (g.classed('leviathan-dead')) return;

    // Trigger CSS heartbeat animation via class toggle
    g.classed('leviathan-heartbeat-active', false);
    // Force reflow so re-adding the class restarts the animation
    void g.node().offsetWidth;
    g.classed('leviathan-heartbeat-active', true);

    // Remove the class after animation completes (1.2s)
    setTimeout(() => g.classed('leviathan-heartbeat-active', false), 1300);

    // Also intensify the core glow briefly
    const core = g.select('.leviathan-core-glow');
    if (!core.empty()) {
      core.interrupt('hb-glow');
      core.transition('hb-glow').duration(150)
        .attr('opacity', 0.7)
        .attr('stroke-width', 8)
        .transition().duration(200)
        .attr('opacity', 0.3)
        .attr('stroke-width', 5)
        .transition().duration(150)
        .attr('opacity', 0.55)
        .attr('stroke-width', 6)
        .transition().duration(600)
        .attr('opacity', 0.2)
        .attr('stroke-width', 3);
    }
  }

  /**
   * Emit sonar ripple rings from a leviathan node (used on gossip emit).
   * Creates 2 concentric expanding rings with a staggered delay.
   * Uses D3 transitions for SVG `r` attribute (more reliable than CSS for SVG).
   */
  static emitSonarRipple(g) {
    if (g.classed('leviathan-dead')) return;

    const stroke = NODE_COLORS_HEX.leviathan;
    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        const ripple = g.append('circle')
          .attr('class', 'leviathan-sonar')
          .attr('r', 28)
          .attr('fill', 'none')
          .attr('stroke', stroke)
          .attr('stroke-width', 2.5)
          .attr('opacity', 0.5);

        // Animate expanding ring via D3 transition
        ripple.transition()
          .duration(1400)
          .ease(d3.easeCubicOut)
          .attr('r', 75)
          .attr('stroke-width', 0.5)
          .attr('opacity', 0)
          .on('end', () => ripple.remove());
      }, i * 250); // 250ms stagger between rings
    }
  }

  /**
   * Brief "absorb" glow when a leviathan receives gossip.
   */
  static absorbGlow(g) {
    if (g.classed('leviathan-dead')) return;

    const core = g.select('.leviathan-core-glow');
    if (!core.empty()) {
      core.interrupt('absorb');
      core.transition('absorb').duration(100)
        .attr('opacity', 0.65)
        .attr('stroke-width', 7)
        .transition().duration(500)
        .attr('opacity', 0.2)
        .attr('stroke-width', 3);
    }
  }

  /** Octagon node (worker). Flat edge on top, with "W0"/"W1" badge. */
  static renderOctagon(g, d, r, stroke, fill) {
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI / 4) * i - Math.PI / 8; // flat edge on top
      pts.push([r * Math.cos(angle), r * Math.sin(angle)]);
    }
    g.append('polygon')
      .attr('class', 'node-shape')
      .attr('points', pts.map(p => p.join(',')).join(' '))
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .attr('filter', 'url(#worker-glow)');

    // Worker badge: "W0", "W1", etc.
    g.append('text')
      .attr('class', 'node-worker-badge')
      .attr('y', 3)
      .text('W' + (d.workerIndex ?? '?'));

    // Start with compiling class (workers spawn in compiling state)
    g.classed('worker-compiling', true);
  }

  /**
   * Update worker state — toggle compiling/idle/proving/timeout/dead CSS classes.
   */
  static updateWorkerState(g, d) {
    g.classed('worker-compiling', d.workerStatus === 'compiling');
    g.classed('worker-idle', d.workerStatus === 'idle');
    g.classed('worker-proving', d.workerStatus === 'proving');
    g.classed('worker-timeout', d.workerStatus === 'timeout');
    g.classed('worker-dead', d.workerStatus === 'dead');
  }

  /**
   * Spawn animation — scale from 0 → 1.15 overshoot → 1 with fade-in.
   */
  static spawnWorkerAnimation(g) {
    const shape = g.select('.node-shape');
    if (shape.empty()) return;
    shape
      .attr('transform', 'scale(0)')
      .attr('opacity', 0);
    shape.transition().duration(400).ease(d3.easeCubicOut)
      .attr('transform', 'scale(1.15)')
      .attr('opacity', 1)
      .transition().duration(300).ease(d3.easeElasticOut.amplitude(1).period(0.4))
      .attr('transform', 'scale(1)');

    // Fade in badge too
    const badge = g.select('.node-worker-badge');
    if (!badge.empty()) {
      badge.attr('opacity', 0)
        .transition().delay(300).duration(300)
        .attr('opacity', 1);
    }
  }

  /**
   * Crash animation — red flash + collapse to scale 0.
   */
  static crashWorkerAnimation(g, onComplete) {
    const shape = g.select('.node-shape');
    if (shape.empty()) {
      if (onComplete) onComplete();
      return;
    }
    g.classed('worker-compiling', false);
    g.classed('worker-idle', false);
    g.classed('worker-proving', false);
    g.classed('worker-timeout', false);
    g.classed('worker-dead', true);

    shape.transition().duration(100)
      .attr('stroke', '#ef5350')
      .attr('stroke-width', 4)
      .transition().duration(400).ease(d3.easeCubicIn)
      .attr('transform', 'scale(0)')
      .attr('opacity', 0)
      .on('end', () => { if (onComplete) onComplete(); });
  }
}
