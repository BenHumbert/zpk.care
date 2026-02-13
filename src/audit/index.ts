// Audit — Data Availability & Audit Trail

export { AuditService, DEFAULT_ORPHAN_THRESHOLD_MS } from './audit-service.js';

export type {
  AuditEvent,
  AuditLog,
  OnChainState,
  ChainIntegrityResult,
  FinancialBalanceResult,
  DuplicateDetectionResult,
  SequenceGapResult,
  OrphanedReceiptResult,
  SettlementResult,
  EnrollmentConsistencyResult,
  FullAuditReport,
} from './audit-types.js';
