/**
 * EventBus — Connects to L2RpcServer SSE streams and dispatches events.
 *
 * Connects to:
 *   GET /viz/events  — visualization events (enrollment, claims, messages)
 *   GET /events      — L2 chain events (proofs, batches)
 */

const RECONNECT_DELAY_MS = 2000;
const REPLAY_STAGGER_MS = 30;  // 30ms per replayed event (~33/sec visual catch-up)

export class EventBus {
  constructor(baseUrl = 'http://127.0.0.1:3030') {
    this.baseUrl = baseUrl;
    this.subscribers = [];
    this.history = [];
    this.vizSource = null;
    this.chainSource = null;
    this.connected = false;
    /** Replay queue for staggered catch-up */
    this.replayQueue = [];
    this.replayPending = 0;
    this.replayDone = true;
  }

  /** Subscribe to all events */
  subscribe(callback) {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== callback);
    };
  }

  /** Get full event history */
  getHistory() {
    return [...this.history];
  }

  /** Connect to both SSE streams */
  connect() {
    this.connectViz();
    this.connectChain();
  }

  /** Disconnect from all streams */
  disconnect() {
    if (this.vizSource) {
      this.vizSource.close();
      this.vizSource = null;
    }
    if (this.chainSource) {
      this.chainSource.close();
      this.chainSource = null;
    }
    this.connected = false;
  }

  /** Connect to the viz events SSE stream */
  connectViz() {
    if (this.vizSource) this.vizSource.close();

    const source = new EventSource(`${this.baseUrl}/viz/events`);
    this.vizSource = source;

    // Listen for all viz event types
    const vizTypes = [
      'viz:token:generated', 'viz:token:consumed',
      'viz:enrollment:started', 'viz:enrollment:complete',
      'viz:eligibility:check', 'viz:eligibility:verified',
      'viz:formulary:check', 'viz:formulary:verified',
      'viz:prescription:written', 'viz:prescription:sent',
      'viz:prescription:received', 'viz:prescription:status',
      'viz:fulfillment:started', 'viz:fulfillment:settled',
      'viz:accumulator:updated', 'viz:reversal:processed',
      'viz:message:sent', 'viz:message:received',
      'viz:delegation:created',
      'viz:batch:submitted', 'viz:batch:settled',
    ];

    for (const type of vizTypes) {
      source.addEventListener(type, (e) => {
        try {
          const event = JSON.parse(e.data);

          if (!this.replayDone) {
            // Still receiving replayed events — queue them
            this.replayQueue.push(event);
            this.replayPending--;
            if (this.replayPending <= 0) {
              this.replayDone = true;
              this.drainReplayQueue();
            }
          } else {
            // Live event — dispatch immediately
            this.dispatch(event);
          }
        } catch { /* ignore parse errors */ }
      });
    }

    source.onopen = () => {
      this.connected = true;
      this.dispatch({ type: 'bus:connected', timestamp: Date.now(), source: 'viz' });
    };

    source.onerror = () => {
      this.connected = false;
      this.dispatch({ type: 'bus:disconnected', timestamp: Date.now(), source: 'viz' });
      // EventSource auto-reconnects
    };

    // Handle the initial "connected" message (no event type, just data)
    source.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'connected') {
          this.connected = true;
          const buffered = msg.buffered || 0;
          if (buffered > 0) {
            this.replayPending = buffered;
            this.replayDone = false;
            this.replayQueue = [];
          } else {
            this.replayDone = true;
          }
          this.dispatch({ type: 'bus:connected', timestamp: Date.now(), source: 'viz', buffered });
        }
      } catch { /* ignore */ }
    };
  }

  /** Drain the replay queue with staggered timing for visual catch-up */
  drainReplayQueue() {
    const queue = this.replayQueue;
    this.replayQueue = [];

    if (queue.length === 0) return;

    console.log(`[EventBus] Replaying ${queue.length} buffered events (${Math.round(queue.length * REPLAY_STAGGER_MS / 1000)}s catch-up)`);

    queue.forEach((event, i) => {
      setTimeout(() => this.dispatch(event), i * REPLAY_STAGGER_MS);
    });
  }

  /** Connect to the L2 chain events SSE stream */
  connectChain() {
    if (this.chainSource) this.chainSource.close();

    const source = new EventSource(`${this.baseUrl}/events`);
    this.chainSource = source;

    const chainTypes = [
      'node:started', 'node:stopped', 'node:tick',
      'proof:accepted', 'proof:rejected',
      'batch:building', 'batch:built', 'batch:empty',
      'batch:settling', 'batch:settled', 'batch:failed',
      'audit:event',
    ];

    for (const type of chainTypes) {
      source.addEventListener(type, (e) => {
        try {
          const event = JSON.parse(e.data);
          this.dispatch({ ...event, source: 'chain' });
        } catch { /* ignore */ }
      });
    }

    source.onerror = () => {
      // EventSource auto-reconnects
    };
  }

  /** Dispatch event to all subscribers */
  dispatch(event) {
    this.history.push(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        console.error('[EventBus] Subscriber error:', err);
      }
    }
  }
}
