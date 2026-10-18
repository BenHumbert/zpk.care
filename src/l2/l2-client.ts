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
import { signRequest, privateKeyFromSeedHex } from '../security/signed-request.js';
import type { RequestSigner } from '../security/wallet-key.js';
import type { NfcCredentialAttestation } from '../credentials/nfc-attestation.js';
import http from 'http';
import https from 'https';
import type { StateTransitionProof } from '../engine/state-transition.js';
import type { L2ChainEvent, L2EventHandler, L2NodeStatus } from './l2-node.js';
import type { L2Receipt, L2Block, L2Batch, L2ChainState, L2ChainProofResponse, ClaimSubmissionMetadata, BenefitPlanConfig } from './l2-types.js';
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
  /** The network operator's bearer token. Only the operator's own tools set this; nodes sign with their key (A9). */
  adminToken?: string;
  /** This node's Ed25519 private seed, 32 bytes of hex (`ZKTRIDENT_NODE_KEY_SEED`). Signs every request. */
  adminPrivateKeyHex?: string;
  /** This node's id as the launcher registered it on the sequencer (`ZKTRIDENT_NODE_ID`). */
  adminNodeId?: string;
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
  async submitProof(proof: StateTransitionProof, opts?: { newCredentialInventoryRoot?: string }): Promise<L2Receipt> {
    const proofJson = proof.toJSON();
    return this.rpcCall<L2Receipt>('l2_submitProof', {
      proofJson,
      ...(opts?.newCredentialInventoryRoot ? { newCredentialInventoryRoot: opts.newCredentialInventoryRoot } : {}),
    });
  }

  /** Query the sequencer's current chain status */
  async getStatus(): Promise<L2NodeStatus> {
    return this.rpcCall<L2NodeStatus>('l2_getStatus');
  }

  /** Look up a receipt by ID */
  async getReceipt(receiptId: string, signer?: RequestSigner): Promise<L2Receipt | null> {
    return this.rpcCall<L2Receipt | null>('l2_getReceipt', { receiptId }, signer);
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
  async getAuditLog(signer?: RequestSigner): Promise<AuditLog> {
    return this.rpcCall<AuditLog>('l2_getAuditLog', undefined, signer);
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
  async getReceiptsByWallet(walletId: string, signer?: RequestSigner): Promise<L2Receipt[]> {
    return this.rpcCall<L2Receipt[]>('l2_getReceiptsByWallet', { walletId }, signer);
  }

  /** Get all receipts (full list for light node sync) */
  async getAllReceipts(signer?: RequestSigner): Promise<L2Receipt[]> {
    return this.rpcCall<L2Receipt[]>('l2_getAllReceipts', undefined, signer);
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

  // ─── Plan Store ────────────────────────────────────────

  /** Store a benefit plan on the sequencer */
  async storePlan(plan: BenefitPlanConfig): Promise<{ success: boolean; planId: string }> {
    return this.rpcCall('l2_storePlan', { plan });
  }

  /** Get a benefit plan by ID */
  async getPlan(planId: string): Promise<BenefitPlanConfig | null> {
    return this.rpcCall('l2_getPlan', { planId });
  }

  /** Get all benefit plans */
  async getPlans(): Promise<BenefitPlanConfig[]> {
    return this.rpcCall<BenefitPlanConfig[]>('l2_getPlans');
  }

  /** Delete a benefit plan */
  async deletePlan(planId: string): Promise<{ success: boolean; planId: string }> {
    return this.rpcCall('l2_deletePlan', { planId });
  }

  /** Get plan limits only (lightweight — no formulary NDCs or network lists) */
  async getPlanLimits(planId: string): Promise<{
    planId: string;
    name: string;
    coverageType: number;
    copayAmountCents: number;
    deductibleAmountCents: number;
    oopMaxCents: number;
    annualBenefitMaxCents: number;
    familyDeductibleAmountCents: number;
    familyOopMaxCents: number;
    familyAnnualBenefitMaxCents: number;
  } | null> {
    return this.rpcCall('l2_getPlanLimits', { planId });
  }

  /** Estimate cost for a drug — returns member pay, employer pay, and full pricing breakdown */
  async estimateCost(params: {
    ndcHash: string;
    planId?: string;
    walletId?: string;
    quantity?: number;
    dispensingFeeCents?: number;
    deductibleAmountCents?: number;
    oopMaxCents?: number;
    annualBenefitMaxCents?: number;
  }, signer?: RequestSigner): Promise<{
    covered: boolean;
    drugName: string;
    ndcHash: string;
    classification?: string;
    tierLevel?: number;
    nadacPerUnit?: number;
    quantity?: number;
    ingredientCostCents?: number;
    dispensingFeeCents?: number;
    totalCostCents?: number;
    copayAmountCents?: number;
    memberPayCents?: number;
    employerPayCents?: number;
    reason?: string;
  }> {
    return this.rpcCall('l2_estimateCost', params as unknown as Record<string, unknown>, signer);
  }

  // ─── Claim Accumulator Queries ──────────────────────────

  /** Get all claims for a member wallet ID */
  async getClaimsByMember(walletId: string, signer?: RequestSigner, memberAttestation?: Record<string, unknown>): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByMember', memberAttestation ? { walletId, memberAttestation } : { walletId }, signer);
  }

  /** Get all claims for a pharmacy wallet ID */
  async getClaimsByPharmacy(walletId: string, signer?: RequestSigner): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByPharmacy', { walletId }, signer);
  }

  /** Get all claims for a prescriber wallet ID */
  async getClaimsByPrescriber(walletId: string, signer?: RequestSigner): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByPrescriber', { walletId }, signer);
  }

  /** Get all claims for an NDC hash */
  async getClaimsByNdc(ndcHash: string, signer?: RequestSigner): Promise<ClaimAccumulatorEntry[]> {
    return this.rpcCall<ClaimAccumulatorEntry[]>('l2_getClaimsByNdc', { ndcHash }, signer);
  }

  /** Get a claim with its Merkle inclusion proof */
  async getClaimWithProof(leafIndex: bigint, signer?: RequestSigner): Promise<{
    entry: ClaimAccumulatorEntry;
    witnessJson: string;
    root: string;
  } | null> {
    return this.rpcCall('l2_getClaimWithProof', { leafIndex: leafIndex.toString() }, signer);
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
  async getWalletWitnesses(walletId: string, signer?: RequestSigner): Promise<{
    registryWitnessJson: string;
    lifecycleWitnessJson: string;
    currentRegistryRoot: string;
    currentLifecycleRoot: string;
    slotIndex: string;
    currentLifecycleState: string;
  }> {
    return this.rpcCall('l2_getWalletWitnesses', { walletId }, signer);
  }

  /** Get the current wallet state (nonce + credentialInventoryRoot) */
  async getWalletState(walletId: string, signer?: RequestSigner): Promise<{
    walletId: string;
    credentialInventoryRoot: string;
    nonce: string;
  }> {
    return this.rpcCall('l2_getWalletState', { walletId }, signer);
  }

  /**
   * Reconstruct a member's accumulator totals from claim history.
   * Used during wallet migration to seed the new wallet's AccumulatorData.
   *
   * @returns Reconstructed totals, or null if no claims found for this wallet
   */
  async reconstructAccumulator(walletId: string, planIdHash?: string, signer?: RequestSigner): Promise<{
    deductiblePaidCents: bigint;
    oopPaidCents: bigint;
    benefitUsedCents: bigint;
    claimCount: number;
    totalClaimCount: number;
  } | null> {
    const rpcParams: Record<string, string> = { walletId };
    if (planIdHash) rpcParams.planIdHash = planIdHash;
    return this.rpcCall('l2_reconstructAccumulator', rpcParams, signer);
  }

  // ─── PCP Assignments ───────────────────────────────────

  /** Register a PCP assignment on the sequencer */
  /** Link a member to a primary-care prescriber. Signed as the member (A10b); unsigned, the sequencer refuses. */
  async registerPcpAssignment(memberWalletId: string, prescriberWalletId: string, effectiveDate: string, signer?: RequestSigner): Promise<unknown> {
    return this.rpcCall('l2_registerPcpAssignment', { memberWalletId, prescriberWalletId, effectiveDate }, signer);
  }

  /** Ask the sequencer for a signed NFC attestation of a wallet. Signed as that wallet (A10b). */
  async requestAttestation(walletId: string, expirySeconds?: number, signer?: RequestSigner): Promise<NfcCredentialAttestation> {
    const params: Record<string, unknown> = { walletId };
    if (expirySeconds !== undefined) params.expirySeconds = expirySeconds;
    return this.rpcCall<NfcCredentialAttestation>('l2_requestAttestation', params, signer);
  }

  /** Get PCP assignments for a prescriber */
  async getPcpAssignments(prescriberWalletId: string, signer?: RequestSigner): Promise<{ memberWalletId: string; effectiveDate: string; timestamp: number }[]> {
    return this.rpcCall('l2_getPcpAssignments', { prescriberWalletId }, signer);
  }

  /** A wallet's X25519 public key, for encrypting to it. Answers any signed caller (D1); null when none is registered. */
  async getEncryptionKey(walletId: string, signer?: RequestSigner): Promise<{ walletId?: string; encryptionPublicKeyHex?: string | null } | null> {
    return this.rpcCall('l2_getEncryptionKey', { walletId }, signer);
  }

  // ─── Message Store Queries ──────────────────────────────

  /** Get all messages involving a wallet (sent or received) */
  async getMessagesByWallet(walletId: string, signer?: RequestSigner): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesByWallet', { walletId }, signer);
  }

  /** Get all messages sent by a wallet */
  async getMessagesBySender(walletId: string, signer?: RequestSigner): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesBySender', { walletId }, signer);
  }

  /** Get all messages received by a wallet */
  async getMessagesByRecipient(walletId: string, signer?: RequestSigner): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesByRecipient', { walletId }, signer);
  }

  /** Get all messages in a thread */
  async getMessagesByThread(threadIdHash: string, signer?: RequestSigner): Promise<MessageStoreEntry[]> {
    return this.rpcCall<MessageStoreEntry[]>('l2_getMessagesByThread', { threadIdHash }, signer);
  }

  /** Get the Message Store root and message count */
  async getMessageStoreRoot(): Promise<{ root: string; messageCount: string }> {
    return this.rpcCall('l2_getMessageStoreRoot');
  }

  /** Store an encrypted message on the sequencer */
  /** Store a message. Signed as its sender (A10b); unsigned, the sequencer refuses. */
  async storeMessage(message: StoredMessage, payload: MessagePayload, signer?: RequestSigner): Promise<MessageStoreEntry> {
    return this.rpcCall<MessageStoreEntry>('l2_storeMessage', {
      message: message as unknown as Record<string, unknown>,
      payload: payload as unknown as Record<string, unknown>,
    }, signer);
  }

  // ─── Provider Registry ──────────────────────────────────

  /** Credential a provider (admin-gated) */
  async credentialProvider(params: {
    walletId: string;
    displayName: string;
    providerType: 'prescriber' | 'pharmacy';
    npi?: string;
    specialty?: string;
    pharmacyType?: string;
    deaNumber?: string;
    stateOfLicense?: string;
    verificationMethod?: string;
    initialState?: number;
  }): Promise<{ ok: boolean; leafIndex: string; walletId: string }> {
    return this.rpcCall('l2_credentialProvider', params as unknown as Record<string, unknown>);
  }

  /** Update a provider's lifecycle state (admin-gated) */
  async updateProviderStatus(walletId: string, newState: number): Promise<{ ok: boolean; walletId: string; credentialState: string }> {
    return this.rpcCall('l2_updateProviderStatus', { walletId, newState });
  }

  /** Get a provider by wallet ID */
  async getProvider(walletId: string): Promise<{
    walletId: string;
    displayName: string;
    providerType: string;
    credentialState: number;
    credentialStateName: string;
    specialty?: string;
    pharmacyType?: string;
  } | null> {
    return this.rpcCall('l2_getProvider', { walletId });
  }

  /** Get provider registry root and count */
  async getProviderRegistryRoot(): Promise<{ root: string; providerCount: string }> {
    return this.rpcCall('l2_getProviderRegistryRoot');
  }

  /** Get a provider with Merkle inclusion proof */
  async getProviderWithProof(walletId: string): Promise<{
    walletId: string;
    displayName: string;
    providerType: string;
    credentialState: number;
    witnessJson: string;
    root: string;
  } | null> {
    return this.rpcCall('l2_getProviderWithProof', { walletId });
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

  // ─── Quorum Protocol ───────────────────────────────────

  /** Get quorum protocol status from a leviathan */
  async getQuorumStatus(): Promise<{
    enabled: boolean;
    publicKeyHex?: string;
    quorumThreshold?: number;
    pendingProposals?: number;
    knownPeerKeys: number;
    stateCertificates?: number;
  }> {
    return this.rpcCall('l2_getQuorumStatus');
  }

  /** Get the latest state certificate for a partition */
  async getStateCertificate(partitionIndex: number): Promise<unknown> {
    return this.rpcCall('l2_getStateCertificate', { partitionIndex });
  }

  /** Verify a state certificate */
  async verifyStateCertificate(certificate: unknown): Promise<{ valid: boolean }> {
    return this.rpcCall('l2_verifyStateCertificate', {
      certificate: certificate as Record<string, unknown>,
    });
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

      // D2: the stream needs a credential — this node's key when it has one, else the admin token.
      const streamHeaders: Record<string, string> = {};
      if (this.options.adminPrivateKeyHex && this.options.adminNodeId) {
        Object.assign(streamHeaders, signRequest({ signerId: this.options.adminNodeId, privateKey: privateKeyFromSeedHex(this.options.adminPrivateKeyHex), method: 'GET', path: '/events' }));
      } else if (this.options.adminToken) {
        streamHeaders['Authorization'] = `Bearer ${this.options.adminToken}`;
      }
      currentReq = transport.get(url, { headers: streamHeaders }, (res) => {
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
    signer?: RequestSigner,
  ): Promise<T> {
    const rpcReq: RpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    };

    const body = l2Stringify(rpcReq);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
      // A10b: a call that speaks for a wallet is signed by that wallet's own key, not the node's.
      Object.assign(headers, signRequest({
        signerId: signer.signerId,
        privateKey: signer.privateKey,
        method: 'POST',
        path: '/rpc',
        body,
      }));
    } else if (this.options.adminPrivateKeyHex && this.options.adminNodeId) {
      // A9: this node's own key signs the exact bytes sent, in the one wire format every server verifies.
      Object.assign(headers, signRequest({
        signerId: this.options.adminNodeId,
        privateKey: privateKeyFromSeedHex(this.options.adminPrivateKeyHex),
        method: 'POST',
        path: '/rpc',
        body,
      }));
    } else if (this.options.adminToken) {
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
