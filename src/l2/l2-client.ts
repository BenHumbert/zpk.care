/**
 * L2Client — Client SDK for connecting to a zkpCare L2 sequencer.
 *
 * Provides a typed API for submitting proofs, querying state, and
 * receiving real-time chain events via Server-Sent Events (SSE).
 *
 * Zero external dependencies — uses Node.js built-in http module.
 *
 * Usage:
 *   const client = new L2Client({ sequencerUrl: 'http://localhost:3030' });
 *   const receipt = await client.submitProof(stateTransitionProof);
 *   const status = await client.getStatus();
 *   const disconnect = client.connectEvents((event) => console.log(event));
 */
import http from 'http';
import https from 'https';
import type { StateTransitionProof } from '../engine/state-transition.js';
import type { L2ChainEvent, L2EventHandler, L2NodeStatus } from './l2-node.js';
import type { L2Receipt, L2Block, L2Batch, L2ChainState, L2ChainProofResponse, ClaimSubmissionMetadata } from './l2-types.js';
import type { ClaimAccumulatorEntry } from './claim-accumulator-types.js';
import type { StoredMessage, MessagePayload, MessageStoreEntry } from './message-store-types.js';
import type { AuditLog } from '../audit/audit-types.js';
import type { RpcRequest, RpcResponse } from './l2-rpc-server.js';
import type { GossipMessage, PeerInfo, StateDigest } from './l2-peer-types.js';
import type { L2SequencerState } from './l2-checkpoint.js';
import { l2Stringify, l2Parse } from './l2-json.js';

// ─── Configuration ──────────────────────────────────────

/** Configuration for the L2 client */
export interface L2ClientOptions {
  /** Sequencer URL (e.g., 'http://localhost:3030') */
  sequencerUrl: string;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs: number;
  /** Number of retries for transient failures. Default 3. */
  maxRetries: number;
  /** Base delay for exponential backoff in ms. Default 1000. */
  retryBaseDelayMs: number;
  /** Bearer token for admin RPC methods. When set, sent as Authorization header on all requests. */
  adminToken?: string;
}

/** Default client options (sequencerUrl must be provided) */
export const DEFAULT_L2_CLIENT_OPTIONS: Omit<L2ClientOptions, 'sequencerUrl'> = {
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 1_000,
};

// ─── L2Client ───────────────────────────────────────────

export class L2Client {
  private options: L2ClientOptions;

  constructor(options: L2ClientOptions | { sequencerUrl: string }) {
    this.options = { ...DEFAULT_L2_CLIENT_OPTIONS, ...options } as L2ClientOptions;
  }

  // ─── Core API ─────────────────────────────────────────

  /**
   * Submit a StateTransitionProof to the remote sequencer.
   * Serializes the proof via proof.toJSON() and sends it.
   *
   * @returns L2Receipt — instant confirmation from the sequencer
   */
  async submitProof(proof: StateTransitionProof): Promise<L2Receipt> {
    const proofJson = proof.toJSON();
    return this.rpcCall<L2Receipt>('l2_submitProof', { proofJson });
  }

  /** Query the sequencer's current chain status */
  async getStatus(): Promise<L2NodeStatus> {
    return this.rpcCall<L2NodeStatus>('l2_getStatus');
  }

  /** Look up a receipt by ID */
  async getReceipt(receiptId: string): Promise<L2Receipt | null> {
    return this.rpcCall<L2Receipt | null>('l2_getReceipt', { receiptId });
  }

  /** Look up a block by number */
  async getBlock(blockNumber: bigint): Promise<L2Block | null> {
    return this.rpcCall<L2Block | null>('l2_getBlock', {
      blockNumber: blockNumber.toString(),
    });
  }

  /** Look up a batch by number */
  async getBatch(batchNumber: bigint): Promise<L2Batch | null> {
    return this.rpcCall<L2Batch | null>('l2_getBatch', {
      batchNumber: batchNumber.toString(),
    });
  }

  /** Get the sequencer's audit log */
  async getAuditLog(): Promise<AuditLog> {
    return this.rpcCall<AuditLog>('l2_getAuditLog');
  }

  /** Trigger a manual batch build on the sequencer */
  async forceBatch(): Promise<L2Batch | null> {
    return this.rpcCall<L2Batch | null>('l2_forceBatch');
  }

  // ─── State Queries ──────────────────────────────────────

  /** Get compact chain state (roots, counts, batch info) for proof building */
  async getChainState(): Promise<L2ChainState> {
    return this.rpcCall<L2ChainState>('l2_getChainState');
  }

  /** Get all receipts for a specific wallet */
  async getReceiptsByWallet(walletId: string): Promise<L2Receipt[]> {
    return this.rpcCall<L2Receipt[]>('l2_getReceiptsByWallet', { walletId });
  }

  /** Get all receipts (full list for light node sync) */
  async getAllReceipts(): Promise<L2Receipt[]> {
    return this.rpcCall<L2Receipt[]>('l2_getAllReceipts');
  }

  /** Get all batches (full list for settlement tracking) */
  async getAllBatches(): Promise<L2Batch[]> {
    return this.rpcCall<L2Batch[]>('l2_getAllBatches');
  }

  /** Get latest chain proof for offline verification */
  async getChainProof(): Promise<L2ChainProofResponse> {
    return this.rpcCall<L2ChainProofResponse>('l2_getChainProof');
  }

  /** Get a published formulary by plan ID hash */
  async getFormulary(planIdHash: string): Promise<{
    formularyRoot: string;
    entriesJson: string;
    publishedAt: number;
    version: number;
  } | null> {
    return this.rpcCall('l2_getFormulary', { planIdHash });
  }

  /** Publish a formulary update for a plan */
  async storeFormulary(
    planIdHash: string,
    formularyRoot: string,
    entriesJson: string,
  ): Promise<{ success: boolean; planIdHash: string; formularyRoot: string }> {
    return this.rpcCall('l2_storeFormulary', { planIdHash, formularyRoot, entriesJson });
  }

  // ─── Claim Accumulator Queries ──────────────────────────

  /** Get all claims for a member wallet ID */
  async getClaimsByMember(walletId: string): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByMember', { walletId });
  }

  /** Get all claims for a pharmacy wallet ID */
  async getClaimsByPharmacy(walletId: string): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByPharmacy', { walletId });
  }

  /** Get all claims for a prescriber wallet ID */
  async getClaimsByPrescriber(walletId: string): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByPrescriber', { walletId });
  }

  /** Get all claims for an NDC hash */
  async getClaimsByNdc(ndcHash: string): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByNdc', { ndcHash });
  }

  /** Get a claim with its Merkle inclusion proof */
  async getClaimWithProof(leafIndex: bigint): Promise<{
    entry: ClaimAccumulatorEntry;
    witnessJson: string;
    root: string;
  } | null> {
    return this.rpcCall('l2_getClaimWithProof', { leafIndex: leafIndex.toString() });
  }

  /** Get the Claim Accumulator Tree root and leaf count */
  async getClaimAccumulatorRoot(): Promise<{ root: string; leafCount: string }> {
    return this.rpcCall('l2_getClaimAccumulatorRoot');
  }

  /** Get MerkleWitnesses for the next registration slot (used by entity nodes to generate proofs) */
  async getRegistrationWitnesses(): Promise<{
    registryWitnessJson: string;
    lifecycleWitnessJson: string;
    currentRegistryRoot: string;
    currentLifecycleRoot: string;
    nextSlotIndex: string;
  }> {
    return this.rpcCall('l2_getRegistrationWitnesses');
  }

  /** Get Merkle witnesses for an existing registered wallet (for wallet update proofs) */
  async getWalletWitnesses(walletId: string): Promise<{
    registryWitnessJson: string;
    lifecycleWitnessJson: string;
    currentRegistryRoot: string;
    currentLifecycleRoot: string;
    slotIndex: string;
    currentLifecycleState: string;
  }> {
    return this.rpcCall('l2_getWalletWitnesses', { walletId });
  }

  /**
   * Reconstruct a member's accumulator totals from claim history.
   * Used during wallet migration to seed the new wallet's AccumulatorData.
   *
   * @returns Reconstructed totals, or null if no claims found for this wallet
   */
  async reconstructAccumulator(walletId: string): Promise<{
    deductiblePaidCents: bigint;
    oopPaidCents: bigint;
    benefitUsedCents: bigint;
    claimCount: number;
  } | null> {
    return this.rpcCall('l2_reconstructAccumulator', { walletId });
  }

  // ─── Message Store Queries ──────────────────────────────

  /** Get all messages involving a wallet (sent or received) */
  async getMessagesByWallet(walletId: string): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesByWallet', { walletId });
  }

  /** Get all messages sent by a wallet */
  async getMessagesBySender(walletId: string): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesBySender', { walletId });
  }

  /** Get all messages received by a wallet */
  async getMessagesByRecipient(walletId: string): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesByRecipient', { walletId });
  }

  /** Get all messages in a thread */
  async getMessagesByThread(threadIdHash: string): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesByThread', { threadIdHash });
  }

  /** Get the Message Store root and message count */
  async getMessageStoreRoot(): Promise<{ root: string; messageCount: string }> {
    return this.rpcCall('l2_getMessageStoreRoot');
  }

  /** Store an encrypted message on the sequencer */
  async storeMessage(message: StoredMessage, payload: MessagePayload): Promise<MessageStoreEntry> {
    return this.rpcCall<MessageStoreEntry>('l2_storeMessage', {
      message: message as unknown as Record<string, unknown>,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  // ─── Peer Network / Gossip ────────────────────────────

  /** Relay a gossip message to a remote peer */
  async gossipRelay(
    message: GossipMessage,
    fromPeerId?: string,
  ): Promise<{ accepted: boolean }> {
    return this.rpcCall('l2_gossipRelay', {
      message: message as unknown as Record<string, unknown>,
      ...(fromPeerId ? { fromPeerId } : {}),
    });
  }

  /** Get a remote peer's identity information */
  async getPeerInfo(): Promise<PeerInfo> {
    return this.rpcCall<PeerInfo>('l2_getPeerInfo');
  }

  /** Get a remote peer's list of known peer URLs */
  async getPeerList(): Promise<string[]> {
    return this.rpcCall<string[]>('l2_getPeerList');
  }

  /** Request a full state snapshot from a peer (for IBD recovery) */
  async requestSnapshot(): Promise<L2SequencerState> {
    return this.rpcCall<L2SequencerState>('l2_requestSnapshot');
  }

  /** Get a compact state digest from a peer for quick sync check */
  async getStateDigest(): Promise<StateDigest> {
    return this.rpcCall<StateDigest>('l2_getStateDigest');
  }

  /** Get partition info for multi-sequencer routing */
  async getPartitionInfo(): Promise<{
    partitioned: boolean;
    partitionConfig: { partitionCount: number; partitionIndex: number } | null;
    allPartitions: { partitionIndex: number; url: string }[];
    l2Only: boolean;
  }> {
    return this.rpcCall('l2_getPartitionInfo');
  }

  /** Health check — returns true if sequencer is reachable and running */
  async isHealthy(): Promise<boolean> {
    try {
      const body = await this.httpRequest('/health', { method: 'GET' });
      const data = JSON.parse(body);
      return data.ok === true && data.running === true;
    } catch {
      return false;
    }
  }

  // ─── Event Streaming (SSE) ────────────────────────────

  /**
   * Connect to the SSE event stream.
   * Returns a disconnect function.
   *
   * Automatically reconnects on disconnect with exponential backoff.
   */
  connectEvents(handler: L2EventHandler): () => void {
    let aborted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentReq: http.ClientRequest | null = null;
    let retryCount = 0;

    const connect = () => {
      if (aborted) return;

      const url = new URL('/events', this.options.sequencerUrl);
      const transport = url.protocol === 'https:' ? https : http;

      currentReq = transport.get(url, (res) => {
        if (res.statusCode !== 200) {
          scheduleReconnect();
          return;
        }

        retryCount = 0; // Reset on successful connect
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // Parse SSE frames (split on double newline)
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? ''; // Keep incomplete frame

          for (const frame of frames) {
            const lines = frame.split('\n');
            const dataLine = lines.find((l) => l.startsWith('data:'));
            if (dataLine) {
              try {
                const event = l2Parse<L2ChainEvent>(dataLine.slice(5).trim());
                handler(event);
              } catch {
                // Ignore parse errors
              }
            }
          }
        });

        res.on('end', () => {
          scheduleReconnect();
        });

        res.on('error', () => {
          scheduleReconnect();
        });
      });

      currentReq.on('error', () => {
        scheduleReconnect();
      });
    };

    const scheduleReconnect = () => {
      if (aborted) return;
      const delay = Math.min(
        this.options.retryBaseDelayMs * Math.pow(2, retryCount),
        30_000,
      );
      retryCount++;
      reconnectTimer = setTimeout(connect, delay);
    };

    connect(); // Initial connection

    // Return disconnect function
    return () => {
      aborted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (currentReq) currentReq.destroy();
    };
  }

  // ─── Internal ─────────────────────────────────────────

  private async rpcCall<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const rpcReq: RpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    };

    const body = l2Stringify(rpcReq);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.adminToken) {
      headers['Authorization'] = `Bearer ${this.options.adminToken}`;
    }
    const resBody = await this.httpRequest('/rpc', {
      method: 'POST',
      headers,
      body,
    });

    const rpcRes = l2Parse<RpcResponse>(resBody);

    if (rpcRes.error) {
      throw new Error(`RPC error ${rpcRes.error.code}: ${rpcRes.error.message}`);
    }

    return rpcRes.result as T;
  }

  private httpRequest(
    path: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.options.sequencerUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const req = transport.request(
        url,
        {
          method: options.method,
          headers: options.headers,
          timeout: this.options.timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.body) req.write(options.body);
      req.end();
    });
  }
}
