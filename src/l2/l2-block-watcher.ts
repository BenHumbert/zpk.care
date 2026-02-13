/**
 * L2BlockWatcher — Chain observer for the zkpCare L2 node.
 *
 * Subscribes to L2Node events and provides:
 *   - Formatted console output (timestamped, color-coded by event type)
 *   - Event log for replay and analysis
 *   - Chain statistics (throughput, batch times, settlement rate)
 *
 * Usage:
 *   const watcher = new L2BlockWatcher(node);
 *   // ... events are automatically logged as the node runs ...
 *   const stats = watcher.getStats();
 */
import type { L2Node, L2ChainEvent } from './l2-node.js';

// ─── Stats ───────────────────────────────────────────────

/** Chain statistics tracked by the block watcher */
export interface L2WatcherStats {
  /** Total proofs accepted by the node */
  totalProofs: number;
  /** Total batches built */
  totalBatches: number;
  /** Total batches settled to L1 */
  totalSettled: number;
  /** Total batches that failed settlement */
  totalFailed: number;
  /** Total registrations (new wallets) */
  totalRegistrations: number;
  /** Total state transitions */
  totalTransitions: number;
  /** Average batch build time in ms */
  avgBatchBuildTimeMs: number;
  /** Total events observed */
  totalEvents: number;
}

// ─── L2BlockWatcher ──────────────────────────────────────

export class L2BlockWatcher {
  private node: L2Node;
  private eventLog: L2ChainEvent[] = [];
  private startedAt: number;

  // Stats accumulators
  private proofCount = 0;
  private batchCount = 0;
  private settledCount = 0;
  private failedCount = 0;
  private registrationCount = 0;
  private transitionCount = 0;
  private batchBuildTimes: number[] = [];

  /** If true, prints formatted output to console */
  public verbose: boolean;

  constructor(node: L2Node, verbose = true) {
    this.node = node;
    this.verbose = verbose;
    this.startedAt = Date.now();

    // Subscribe to all node events
    this.node.on((event) => this.handleEvent(event));
  }

  // ─── Event Handler ──────────────────────────────────────

  private handleEvent(event: L2ChainEvent): void {
    this.eventLog.push(event);

    switch (event.type) {
      case 'node:started':
        if (this.verbose) {
          this.log(
            `Node started (batch interval: ${Number(event.data.batchIntervalMs) / 1000}s, ` +
            `auto-settle: ${event.data.autoSettle ? 'ON' : 'OFF'})`,
          );
        }
        break;

      case 'node:stopped':
        if (this.verbose) {
          const uptime = (Number(event.data.uptimeMs) / 1000).toFixed(1);
          this.log(
            `Node stopped after ${uptime}s ` +
            `(${event.data.totalProofs} proofs, ${event.data.totalBatches} batches)`,
          );
        }
        break;

      case 'node:tick':
        // Only log ticks when there are pending proofs
        if (this.verbose && Number(event.data.pendingCount) > 0) {
          this.log(`Batch timer fired (${event.data.pendingCount} pending)`);
        }
        break;

      case 'proof:accepted':
        this.proofCount++;
        if (this.verbose) {
          const walletShort = this.truncate(String(event.data.walletId));
          const reg = event.data.isRegistration ? 'registration=YES' : 'registration=NO';
          this.log(
            `Proof accepted: ${event.data.receiptId} ` +
            `wallet=${walletShort} ${reg} ` +
            `(pending: ${event.data.pendingCount})`,
          );
        }
        break;

      case 'proof:rejected':
        if (this.verbose) {
          this.log(`Proof REJECTED: ${event.data.reason}`);
        }
        break;

      case 'batch:building':
        if (this.verbose) {
          this.log(`Building batch (${event.data.pendingCount} proofs)...`);
        }
        break;

      case 'batch:built': {
        this.batchCount++;
        const regs = Number(event.data.registrationCount);
        const txns = Number(event.data.transitionCount);
        this.registrationCount += regs;
        this.transitionCount += txns;
        const buildTimeMs = Number(event.data.buildTimeMs);
        this.batchBuildTimes.push(buildTimeMs);

        if (this.verbose) {
          const buildSec = (buildTimeMs / 1000).toFixed(1);
          this.log(
            `Batch #${event.data.batchNumber} built: ` +
            `${regs} registrations, ${txns} transitions ` +
            `(${buildSec}s)`,
          );
        }
        break;
      }

      case 'batch:empty':
        // Silent — no pending proofs
        break;

      case 'batch:settling':
        if (this.verbose) {
          this.log(`Settling batch #${event.data.batchNumber} to L1...`);
        }
        break;

      case 'batch:settled':
        this.settledCount++;
        if (this.verbose) {
          this.log(
            `Batch #${event.data.batchNumber} SETTLED ` +
            `(tx: ${event.data.l1TxHash})`,
          );
        }
        break;

      case 'batch:failed':
        this.failedCount++;
        if (this.verbose) {
          this.log(`Batch FAILED: ${event.data.reason}`);
        }
        break;
    }
  }

  // ─── Queries ────────────────────────────────────────────

  /** Get accumulated chain statistics */
  getStats(): L2WatcherStats {
    const totalBuildTime = this.batchBuildTimes.reduce((s, t) => s + t, 0);
    const avgBuildTime = this.batchBuildTimes.length > 0
      ? totalBuildTime / this.batchBuildTimes.length
      : 0;

    return {
      totalProofs: this.proofCount,
      totalBatches: this.batchCount,
      totalSettled: this.settledCount,
      totalFailed: this.failedCount,
      totalRegistrations: this.registrationCount,
      totalTransitions: this.transitionCount,
      avgBatchBuildTimeMs: avgBuildTime,
      totalEvents: this.eventLog.length,
    };
  }

  /** Get the full event log */
  getEventLog(): L2ChainEvent[] {
    return [...this.eventLog];
  }

  /** Get events of a specific type */
  getEventsByType(type: string): L2ChainEvent[] {
    return this.eventLog.filter((e) => e.type === type);
  }

  // ─── Formatting ─────────────────────────────────────────

  private log(message: string): void {
    const elapsed = Date.now() - this.startedAt;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    console.log(`  [L2 ${ts}] ${message}`);
  }

  private truncate(s: string, len = 8): string {
    if (s.length <= len * 2) return s;
    return s.slice(0, len) + '...' + s.slice(-len);
  }
}
