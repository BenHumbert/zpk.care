// Entity Node SDK — production-mode entity nodes for Adjuda-GATOR

// Base class
export { EntityNodeBase } from './entity-node-base.js';

// Entity nodes
export { MemberNode } from './member-node.js';
export { PrescriberNode } from './prescriber-node.js';
export { PharmacyNode } from './pharmacy-node.js';
export { InsurerNode } from './insurer-node.js';
export { EmployerNode } from './employer-node.js';
export type { EmployerGroupRecord, EmployerRosterEntry } from './employer-node.js';

// Proof delegation
export { ProofDelegateClient, ProofDelegateServer } from './proof-delegate.js';

// Nautilus App Server
export { NautilusAppServer } from './nautilus-app-server.js';
export { NautilusLocalState } from './nautilus-local-state.js';

// NFC Identity
export {
  buildNfcIdentityRecord,
  parseNfcIdentityPayload,
  parseNfcIdentityBase64,
  isValidWalletId,
  fitsOnTag,
  NDEF_DOMAIN,
  NDEF_TYPE_MEMBER_ID,
  NFC_TAG_CAPACITY,
} from './nfc-identity.js';

// Route builders
export { buildMemberRoutes } from './routes/member-routes.js';
export { buildPrescriberRoutes } from './routes/prescriber-routes.js';
export { buildPharmacyRoutes } from './routes/pharmacy-routes.js';
export { buildInsurerRoutes } from './routes/insurer-routes.js';
export { buildEmployerRoutes } from './routes/employer-routes.js';

// Types
export type {
  EntityRole,
  EntityNodeConfig,
  MemberNodeConfig,
  PrescriberNodeConfig,
  PharmacyNodeConfig,
  InsurerNodeConfig,
  EmployerNodeConfig,
  EntityClaimView,
  EntityActivitySummary,
  PrescriberActivitySummary,
  PharmacyActivitySummary,
  MedicationBreakdownEntry,
  PrescriberBreakdownEntry,
  ProofTimingEstimate,
} from './entity-node-types.js';

export type {
  OnboardingPhase,
  OnboardingState,
  NautilusAppConfig,
  NautilusApiResponse,
  NautilusHealthResponse,
  HttpMethod,
  RouteHandler,
  RouteRegistration,
} from './nautilus-app-types.js';

export type { NautilusStateData } from './nautilus-local-state.js';

export type {
  NfcIdentityPayload,
  NfcIdentityRecord,
} from './nfc-identity.js';
