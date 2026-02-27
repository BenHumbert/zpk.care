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
};

const NODE_RADIUS = {
  member: 18,
  prescriber: 20,
  pharmacy: 22,
  insurer: 24,
  leviathan: 28,
  employer: 20,
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

  /** Install SVG <defs> for glow filters. Call once on svg element. */
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
  }

  /**
   * Update leviathan role/partition display on data refresh.
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
    // Dim stopped nodes
    const outerRing = g.select('.leviathan-outer-ring');
    if (!outerRing.empty()) {
      if (d.status === 'stopped') {
        outerRing.attr('opacity', 0.15).attr('stroke', '#555');
        g.select('.leviathan-inner-ring').attr('stroke', '#555').attr('opacity', 0.4);
        roleEl.attr('fill', '#555');
        partEl.attr('fill', '#555');
      } else {
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
   * Heartbeat pulse on leviathan outer ring.
   */
  static pulseHeartbeat(g) {
    const outer = g.select('.leviathan-outer-ring');
    if (outer.empty()) return;
    const origR = parseFloat(outer.attr('r'));
    outer.transition().duration(300)
      .attr('r', origR + 4)
      .attr('opacity', 0.9)
      .attr('stroke', '#fff')
      .transition().duration(700)
      .attr('r', origR)
      .attr('opacity', 0.5)
      .attr('stroke', NODE_COLORS_HEX.leviathan);
  }
}
