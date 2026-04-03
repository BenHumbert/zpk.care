/**
 * connection-renderer.js — Animated connection lines between nodes.
 *
 * Defines EVENT_CONFIG for all VizEvent types. Animations are tick-driven
 * extend/retract lines — no particles. All animations follow node positions.
 */

/**
 * Event configuration: color, width, duration.
 *
 * Animation is tick-driven extend/retract (no particles):
 *   Phase 1: leading edge extends A → B
 *   Phase 2: trailing edge retracts A → B
 *   Phase 3: opacity fade out
 */
const EVENT_CONFIG = {
  'viz:enrollment:started':       { color: '#4fc3f7', width: 3,   duration: 3000, dash: '' },
  'viz:enrollment:complete':      { color: '#66bb6a', width: 3,   duration: 2500, dash: '' },
  'viz:enrollment:wallet_derived':{ color: '#4fc3f7', width: 2.5, duration: 2000, dash: '4 3' },
  'viz:enrollment:proof_gate':    { color: '#ab47bc', width: 3,   duration: 2500, dash: '' },
  'viz:enrollment:registration':  { color: '#66bb6a', width: 3,   duration: 2500, dash: '' },
  'viz:enrollment:credential_mint':{ color: '#ffa726', width: 3,  duration: 2500, dash: '' },
  'viz:enrollment:lifecycle':     { color: '#26c6da', width: 2.5, duration: 2000, dash: '' },
  'viz:enrollment:provider_notify':{ color: '#ab47bc', width: 2.5,duration: 2000, dash: '6 3' },
  'viz:enrollment:terminated':    { color: '#ef5350', width: 3,   duration: 2500, dash: '' },
  'viz:eligibility:check':        { color: '#ffa726', width: 2.5, duration: 2000, dash: '' },
  'viz:eligibility:verified':     { color: '#66bb6a', width: 3,   duration: 2000, dash: '' },
  'viz:prescription:written':     { color: '#66bb6a', width: 3,   duration: 2800, dash: '' },
  'viz:prescription:sent':        { color: '#66bb6a', width: 2.5, duration: 2000, dash: '6 3' },
  'viz:prescription:received':    { color: '#66bb6a', width: 3,   duration: 2000, dash: '' },
  'viz:prescription:status':      { color: '#ffa726', width: 2.5, duration: 2000, dash: '' },
  'viz:fulfillment:started':      { color: '#66bb6a', width: 3,   duration: 3000, dash: '' },
  'viz:fulfillment:settled':      { color: '#66bb6a', width: 3.5, duration: 2500, dash: '' },
  'viz:fulfillment:reversed':     { color: '#ef5350', width: 3,   duration: 2500, dash: '' },
  'viz:pharmacy:dispensed':       { color: '#ffa726', width: 3,   duration: 2000, dash: '' },
  'viz:pharmacy:rejected':        { color: '#ef5350', width: 3,   duration: 2000, dash: '' },
  'viz:credential:generated':     { color: '#ab47bc', width: 3,   duration: 2500, dash: '' },
  'viz:pharmacy:credential_scan': { color: '#ffa726', width: 2.5, duration: 2000, dash: '' },
  'viz:accumulator:updated':      { color: '#26c6da', width: 2.5, duration: 2000, dash: '' },
  'viz:reversal:processed':       { color: '#ef5350', width: 3,   duration: 2500, dash: '' },
  'viz:batch:submitted':          { color: '#26c6da', width: 3,   duration: 3000, dash: '' },
  'viz:batch:settled':            { color: '#66bb6a', width: 3.5, duration: 2500, dash: '' },
  'viz:message:sent':             { color: '#ec4899', width: 2.5, duration: 2000, dash: '' },
  'viz:message:received':         { color: '#ec4899', width: 2.5, duration: 2000, dash: '' },
  'viz:delegation:created':       { color: '#ffa726', width: 3,   duration: 2500, dash: '' },
  'viz:token:generated':          { color: '#ffa726', width: 2.5, duration: 2000, dash: '' },
  'viz:token:consumed':           { color: '#66bb6a', width: 2.5, duration: 2000, dash: '' },
  'viz:formulary:check':          { color: '#ffa726', width: 2.5, duration: 2000, dash: '' },
  'viz:formulary:verified':       { color: '#66bb6a', width: 2.5, duration: 1800, dash: '' },
  'viz:leviathan:heartbeat':      { color: '#26c6da', width: 1.5, duration: 1500, dash: '3 3' },
  'viz:leviathan:gossip':         { color: '#26c6da', width: 3,   duration: 2500, dash: '' },
  'viz:leviathan:failover':       { color: '#ef5350', width: 4,   duration: 4000, dash: '' },
  'viz:worker:spawned':           { color: '#ffc107', width: 2,   duration: 1500, dash: '4 3' },
  'viz:worker:compiling':         { color: '#ffc107', width: 1.5, duration: 1500, dash: '4 3' },
  'viz:worker:ready':             { color: '#66bb6a', width: 2.5, duration: 2000, dash: '' },
  'viz:worker:compile_timeout':   { color: '#ef5350', width: 3,   duration: 2500, dash: '' },
  'viz:worker:compile_failed':    { color: '#ef5350', width: 3,   duration: 2000, dash: '' },
  'viz:worker:assigned':          { color: '#ffc107', width: 2.5, duration: 2000, dash: '6 3' },
  'viz:worker:completed':         { color: '#66bb6a', width: 2.5, duration: 2000, dash: '' },
  'viz:worker:crashed':           { color: '#ef5350', width: 3,   duration: 2000, dash: '' },
};

class ConnectionRenderer {
  constructor(svgLayer) {
    this.layer = svgLayer;
  }
}
