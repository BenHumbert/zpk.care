// L2 — Batch Settlement (zkpCare Chain)

export {
  BatchOutput,
  BatchProgram,
  BatchProof,
} from './batch-program.js';

// L2 Global State Commitment + ChainOutput
export {
  GLOBAL_STATE_FIELD_COUNT,
  computeGlobalStateRoot,
  GlobalState,
  ChainOutput,
} from './global-state.js';

// L2 Chain Program — recursive "picture of a picture"
export {
  ChainProgram,
  ChainProof,
} from './chain-program.js';

export type {
  L1Status,
  L2Receipt,
  L2Block,
  L2Batch,
  L2ChainState,
  L2ChainProofResponse,
  L2EntityType,
  L2NodeConfig,
  AdminOperationType,
  AdminOpStatus,
  AdminStateDelta,
  ClaimSubmissionMetadata,
  BenefitPlanConfig,
} from './l2-types.js';

export {
  DEFAULT_BATCH_INTERVAL_MS,
  MAX_TRANSITIONS_PER_BATCH,
  L2SequencerService,
} from './l2-sequencer-service.js';
export type { AdminStateConfig } from './l2-sequencer-service.js';

export { L2Node, DEFAULT_L2_NODE_OPTIONS } from './l2-node.js';
export type {
  SettlementStrategy,
  L2NodeOptions,
  L2EventType,
  L2ChainEvent,
  L2EventHandler,
  L2NodeStatus,
} from './l2-node.js';

export { L2BlockWatcher } from './l2-block-watcher.js';
export type { L2WatcherStats } from './l2-block-watcher.js';

// L2 JSON utilities
export {
  bigintReplacer,
  bigintReviver,
  l2Stringify,
  l2Parse,
  BIGINT_PREFIX,
} from './l2-json.js';

// L2 RPC Server
export {
  L2RpcServer,
  DEFAULT_RPC_SERVER_OPTIONS,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_PROOF_REJECTED,
  RPC_NODE_NOT_RUNNING,
} from './l2-rpc-server.js';
export type {
  L2RpcServerOptions,
  RpcRequest,
  RpcResponse,
  VizEventType,
  VizLane,
  VizActorType,
  VizEvent,
  VizEntity,
} from './l2-rpc-server.js';

// L2 Client SDK
export { L2Client, DEFAULT_L2_CLIENT_OPTIONS } from './l2-client.js';
export type { L2ClientOptions } from './l2-client.js';

// Claim Accumulator Tree — drug history tracking
export {
  CLAIM_TREE_HEIGHT,
  ClaimAccumulatorWitness,
  computeClaimLeafHash,
} from './claim-accumulator-types.js';
export type {
  ClaimLeaf,
  ClaimMetadata,
  ClaimAccumulatorEntry,
  ClaimAccumulatorState,
} from './claim-accumulator-types.js';
export { ClaimAccumulatorService } from './claim-accumulator-service.js';

// Message Store — encrypted message history
export {
  MESSAGE_STORE_HEIGHT,
  MessageStoreWitness,
  computeMessageLeafHash,
} from './message-store-types.js';
export type {
  StoredMessage,
  MessagePayload,
  MessageStoreEntry,
  MessageStoreState,
} from './message-store-types.js';
export { MessageStoreService } from './message-store-service.js';

// Provider Registry — credentialing pipeline
export {
  PROVIDER_TREE_HEIGHT,
  ProviderLifecycle,
  PROVIDER_LIFECYCLE_NAMES,
  PROVIDER_TYPE_TAG,
  computeProviderLeafHash,
} from './provider-registry-types.js';
export type {
  ProviderType,
  ProviderLeaf,
  ProviderMetadata,
  ProviderRegistryEntry,
  ProviderRegistryState,
  CredentialingApplication,
} from './provider-registry-types.js';
export { ProviderRegistryService, ProviderRegistryWitness } from './provider-registry-service.js';

// Formulary Service — Option C: canonical 32K drug store with plan overlays
export {
  FormularyService,
  FormularyWitness,
  FORMULARY_TREE_HEIGHT,
  computeFormularyLeafHash,
} from './formulary-service.js';
export type {
  FormularyDrug,
  FormularyDrugWithPlan,
  PlanOverlay,
  DrugOverride,
  PlanDefaults,
  FormularyCategory,
  FormularyPage,
  FormularyFilter,
  CoverageResult,
  FormularyServiceState,
} from './formulary-service.js';

// L2 Checkpoint / Crash Recovery
export {
  L2CheckpointStore,
  CHECKPOINT_VERSION,
} from './l2-checkpoint.js';
export type {
  L2SequencerState,
  L2NodeStats,
  L2CheckpointTrigger,
  L2Checkpoint,
  LeviathanCheckpoint,
} from './l2-checkpoint.js';

// L2 Peer Network — distributed replication
export { L2PeerNetwork, generateMessageId } from './l2-peer-network.js';
export type { GossipHandler } from './l2-peer-network.js';
export {
  DEFAULT_MAX_PEERS,
  DEFAULT_ANNOUNCE_INTERVAL_MS,
  MAX_SEEN_MESSAGES,
  DEFAULT_PEER_NETWORK_CONFIG,
} from './l2-peer-types.js';
export type {
  L2NodeRole,
  PeerStatus,
  PeerInfo,
  GossipMessageType,
  GossipMessage,
  GossipPayload,
  ProofAcceptedPayload,
  BatchBuiltPayload,
  BatchSettledPayload,
  BatchFailedPayload,
  MessageStoredPayload,
  PlanUpdatedPayload,
  PlanDeletedPayload,
  FormularyUpdatedPayload,
  PeerAnnouncePayload,
  StateDigest,
  PeerNetworkConfig,
} from './l2-peer-types.js';

// L2 Partition — multi-sequencer wallet partitioning
export { getPartition, isMyPartition, PartitionRouter } from './l2-partition.js';
export type { PartitionConfig } from './l2-partition.js';

// L2 Leviathan — Multi-leader partitioned architecture
export { L2Leviathan } from './l2-leviathan.js';
export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from './l2-leviathan-types.js';
export type {
  LeviathanConfig,
  PartitionLeaderEntry,
  LeaderHeartbeatPayload,
  LeaderPromotionPayload,
  PartitionStats,
  LeviathanStatus,
} from './l2-leviathan-types.js';

// Epoch-based Accumulator (production-scale monthly rotation)
export { EpochAccumulatorService } from './epoch-accumulator-service.js';
export type {
  EpochInfo,
  EpochAccumulatorServiceState,
} from './epoch-accumulator-service.js';

// Write-Ahead Log — crash-safe proof durability
export {
  InMemoryWalProvider,
  FileWalProvider,
  computeWalIntegrityHash,
} from './l2-wal.js';
export type {
  WalEntry,
  WalEntryType,
  WalConfig,
  IWalProvider,
} from './l2-wal.js';
export { DEFAULT_WAL_CONFIG } from './l2-wal.js';

// Quorum Protocol — Ed25519-based consensus
export {
  L2QuorumService,
  QuorumKeyAuthority,
  computeStateDigestHash,
  computePartitionDigestHash,
  computeQuorumThreshold,
} from './l2-quorum-service.js';
export type {
  QuorumConfig,
  QuorumProposal,
  QuorumVote,
  QuorumCertificate,
  StateCertificate,
  StateCertSignature,
  PartitionDigest,
  ReconciliationConfig,
  ReconciliationResult,
} from './l2-quorum-types.js';
export {
  DEFAULT_QUORUM_TIMEOUT_MS,
  DEFAULT_RECONCILIATION_CONFIG,
  buildQuorumVoteMessage,
  buildStateCertMessage,
} from './l2-quorum-types.js';

// Proving Pool — parallel batch proving via child process workers
export { ProvingPool } from './l2-proving-pool.js';
export type {
  ProvingJobRequest,
  ProvingJobResult,
  ProvingPoolOptions,
  ProvingPoolStatus,
  CoordinatorMessage,
  WorkerMessage,
  PoolEvent,
  PoolEventType,
  PoolEventHandler,
  WorkerStatus,
  WorkerState,
} from './l2-proving-pool-types.js';
