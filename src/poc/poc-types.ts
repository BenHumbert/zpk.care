/**
 * PoC Types — Shared type definitions for the proof-of-concept testing suite.
 *
 * Defines port assignments, node info, workflow steps, events, and the
 * unified status object consumed by the monitoring dashboard.
 */

// ─── Port Assignments ─────────────────────────────────────

export const PORT_MAP = {
  leviathans: [3030, 3031, 3032] as const,
  insurer: 4000,
  members: [4001, 4002, 4003, 4004, 4005] as const,
  prescribers: [4010, 4011] as const,
  pharmacies: [4012, 4013] as const,
  dashboard: 8080,
} as const;

// ─── Node Tracking ────────────────────────────────────────

export type PocNodeRole = 'leviathan' | 'member' | 'prescriber' | 'pharmacy' | 'insurer';
export type PocNodeStatus = 'booting' | 'running' | 'error' | 'stopped';

export interface PocNodeInfo {
  id: string;
  role: PocNodeRole;
  displayName: string;
  port: number;
  url: string;
  walletId?: string;
  partitionIndex?: number;
  status: PocNodeStatus;
  error?: string;
}

// ─── Workflow Steps ───────────────────────────────────────

export type WorkflowPhase = 'enrollment' | 'prescribing' | 'filling' | 'batching' | 'verification';
export type StepStatus = 'pending' | 'running' | 'success' | 'error';

export interface WorkflowStep {
  id: string;
  phase: WorkflowPhase;
  description: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

// ─── Events ──────────────────────────────────────────────

export type PocEventLevel = 'info' | 'success' | 'error' | 'warn';

export interface PocEvent {
  timestamp: number;
  source: string;
  level: PocEventLevel;
  message: string;
  phase?: string;
}

// ─── Unified Status ──────────────────────────────────────

export type PocPhase =
  | 'booting'
  | 'enrolling'
  | 'prescribing'
  | 'filling'
  | 'batching'
  | 'verifying'
  | 'complete'
  | 'error';

export interface PocCounters {
  enrollments: { total: number; success: number; failed: number };
  claims: { total: number; success: number; failed: number };
  batches: { total: number; success: number; failed: number };
  verifications: { total: number; passed: number; failed: number };
}

export interface PocStatus {
  nodes: PocNodeInfo[];
  workflow: WorkflowStep[];
  events: PocEvent[];
  counters: PocCounters;
  phase: PocPhase;
  startedAt: number;
  elapsedMs: number;
}

// ─── Prescription Tracking ───────────────────────────────

export interface PrescriptionInfo {
  prescriptionId: string;
  memberWalletId: string;
  prescriberWalletId: string;
  pharmacyWalletId: string;
  ndcHash: string;
  filled: boolean;
}

// ─── Event Emitter Interface ─────────────────────────────

export interface PocEventEmitter {
  emit(event: PocEvent): void;
  onEvent(handler: (event: PocEvent) => void): () => void;
}
