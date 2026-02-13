// L2 — Batch Settlement (zkpCare Chain)

export {
  BatchOutput,
  BatchProgram,
  BatchProof,
} from './batch-program.js';

export type {
  L1Status,
  L2Receipt,
  L2Block,
  L2Batch,
  L2EntityType,
  L2NodeConfig,
  AdminOperationType,
  AdminOpStatus,
  AdminStateDelta,
} from './l2-types.js';

export {
  DEFAULT_BATCH_INTERVAL_MS,
  MAX_TRANSITIONS_PER_BATCH,
  L2SequencerService,
} from './l2-sequencer-service.js';

export { L2Node, DEFAULT_L2_NODE_OPTIONS } from './l2-node.js';
export type {
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
} from './l2-rpc-server.js';

// L2 Client SDK
export { L2Client, DEFAULT_L2_CLIENT_OPTIONS } from './l2-client.js';
export type { L2ClientOptions } from './l2-client.js';

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
} from './l2-checkpoint.js';
