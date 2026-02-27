/**
 * connection-renderer.js — Animated connection lines between nodes.
 *
 * Draws temporary animated lines + traveling particles for VizEvents.
 * No persistent gossip lines — all animations are dynamic and follow nodes.
 */

/** Event configuration: color, width, duration, particle settings. */
const EVENT_CONFIG = {
  'viz:enrollment:started':     { color: '#4fc3f7', width: 2, duration: 2000, dash: '', particle: true },
  'viz:enrollment:complete':    { color: '#66bb6a', width: 2, duration: 1500, dash: '', particle: true },
  'viz:enrollment:wallet_derived': { color: '#4fc3f7', width: 1.5, duration: 1200, dash: '4 3', particle: false },
  'viz:enrollment:proof_gate':  { color: '#ab47bc', width: 2, duration: 1500, dash: '', particle: true },
  'viz:enrollment:registration': { color: '#66bb6a', width: 2, duration: 1500, dash: '', particle: true },
  'viz:enrollment:credential_mint': { color: '#ffa726', width: 2, duration: 1500, dash: '', particle: true },
  'viz:enrollment:lifecycle':   { color: '#26c6da', width: 1.5, duration: 1000, dash: '', particle: false },
  'viz:enrollment:provider_notify': { color: '#ab47bc', width: 1.5, duration: 1000, dash: '6 3', particle: true },
  'viz:enrollment:terminated':  { color: '#ef5350', width: 2, duration: 1500, dash: '', particle: true },
  'viz:eligibility:check':      { color: '#ffa726', width: 1.5, duration: 1200, dash: '', particle: true },
  'viz:eligibility:verified':   { color: '#66bb6a', width: 2, duration: 1000, dash: '', particle: false },
  'viz:prescription:written':   { color: '#66bb6a', width: 2, duration: 1800, dash: '', particle: true },
  'viz:prescription:sent':      { color: '#66bb6a', width: 1.5, duration: 1200, dash: '6 3', particle: true },
  'viz:prescription:received':  { color: '#66bb6a', width: 2, duration: 1200, dash: '', particle: true },
  'viz:prescription:status':    { color: '#ffa726', width: 1.5, duration: 1000, dash: '', particle: false },
  'viz:fulfillment:started':    { color: '#66bb6a', width: 2, duration: 2000, dash: '', particle: true },
  'viz:fulfillment:settled':    { color: '#66bb6a', width: 2.5, duration: 1500, dash: '', particle: true },
  'viz:fulfillment:reversed':   { color: '#ef5350', width: 2, duration: 1500, dash: '', particle: true },
  'viz:pharmacy:dispensed':     { color: '#ffa726', width: 2, duration: 1200, dash: '', particle: true },
  'viz:pharmacy:rejected':      { color: '#ef5350', width: 2, duration: 1200, dash: '', particle: true },
  'viz:pharmacy:credential_scan': { color: '#ffa726', width: 1.5, duration: 1000, dash: '', particle: true },
  'viz:accumulator:updated':    { color: '#26c6da', width: 1.5, duration: 1000, dash: '', particle: false },
  'viz:reversal:processed':     { color: '#ef5350', width: 2, duration: 1500, dash: '', particle: true },
  'viz:batch:submitted':        { color: '#26c6da', width: 2, duration: 2000, dash: '', particle: true },
  'viz:batch:settled':          { color: '#66bb6a', width: 2.5, duration: 1500, dash: '', particle: true },
  'viz:message:sent':           { color: '#ec4899', width: 1.5, duration: 1200, dash: '', particle: true },
  'viz:message:received':       { color: '#ec4899', width: 1.5, duration: 1000, dash: '', particle: false },
  'viz:delegation:created':     { color: '#ffa726', width: 2, duration: 1500, dash: '', particle: true },
  'viz:token:generated':        { color: '#ffa726', width: 1.5, duration: 1200, dash: '', particle: true },
  'viz:token:consumed':         { color: '#66bb6a', width: 1.5, duration: 1200, dash: '', particle: true },
  'viz:formulary:check':        { color: '#ffa726', width: 1.5, duration: 1000, dash: '', particle: true },
  'viz:formulary:verified':     { color: '#66bb6a', width: 1.5, duration: 800, dash: '', particle: false },
  'viz:leviathan:heartbeat':    { color: '#26c6da', width: 1, duration: 1000, dash: '3 3', particle: false },
  'viz:leviathan:gossip':       { color: '#26c6da', width: 2, duration: 1500, dash: '', particle: true },
  'viz:leviathan:failover':     { color: '#ef5350', width: 3, duration: 3000, dash: '', particle: true },
};

class ConnectionRenderer {
  constructor(svgLayer) {
    this.layer = svgLayer;
  }
}
