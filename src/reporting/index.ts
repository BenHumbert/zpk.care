// Reporting — On-Chain Reporting (L10)

export { ReportingService } from './reporting-service.js';

export type {
  DateRange,
  CostBreakdown,
  VerifiedClaim,
  ClaimContext,
  PriorAuthContext,
  ClaimsRegisterReport,
  PharmacyActivityEntry,
  PharmacyActivityReport,
  PrescriberActivityEntry,
  PrescriberActivityReport,
  MemberActivityEntry,
  MemberActivityReport,
  MedicationUtilizationEntry,
  MedicationUtilizationReport,
  FinancialSummaryReport,
  PriorAuthUtilizationEntry,
  PriorAuthReport,
  ReversalReport,
  // GAP 4 — Multi-dimensional reporting
  ReportFilter,
  TierAnalysisEntry,
  TierAnalysisReport,
  TherapeuticClassEntry,
  TherapeuticClassReport,
  TimeBucket,
  TimeSeriesEntry,
  TimeSeriesReport,
  CrossTabDimension,
  CrossTabMeasure,
  CrossTabRow,
  CrossTabReport,
} from './report-types.js';
