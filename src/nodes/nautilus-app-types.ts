/**
 * Nautilus App Types — shared type definitions for all Nautilus Node App servers.
 *
 * Each entity type (member, prescriber, pharmacy, insurer) gets a Nautilus App
 * that serves REST endpoints for its frontend. These types are shared across
 * all entity-specific route handlers and the core app server.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { EntityRole } from './entity-node-types.js';

// ─── Onboarding State Machine ─────────────────────────────────

/** Onboarding phases for all entity types */
export type OnboardingPhase =
  | 'awaiting_token'     // Waiting for GroupEnrollmentToken
  | 'token_received'     // Token validated, ready for wallet creation
  | 'key_generated'      // Enrollment key generated on device
  | 'wallet_derived'     // Wallet ID computed from local data + enrollment key
  | 'enrolled'           // Enrollment complete, wallet active on sequencer
  | 'compiling'          // Compiling ZkPrograms (member/prescriber/pharmacy)
  | 'ready';             // Node fully operational

/** Onboarding state tracked in local storage */
export interface OnboardingState {
  phase: OnboardingPhase;
  tokenId?: string;
  tokenData?: {
    groupId: string;
    planId: string;
    validUntil: string;
  };
  enrollmentTimestamp?: number;
  compilationStatus?: {
    program: string;
    timeMs: number;
  }[];
}

// ─── Nautilus App Server Config ────────────────────────────────

/** Configuration for any Nautilus App server */
export interface NautilusAppConfig {
  /** Entity type */
  role: EntityRole;
  /** HTTP/HTTPS server port */
  port: number;
  /** Server bind host */
  host: string;
  /** Sequencer URL to connect to */
  sequencerUrl: string;
  /** Local state directory for encrypted persistence */
  stateDir: string;
  /** Path to PEM certificate file for TLS (optional — HTTP if not set) */
  tlsCert?: string;
  /** Path to PEM private key file for TLS (optional — HTTP if not set) */
  tlsKey?: string;
  /** Enable SSE event streaming from the entity node */
  enableSSE: boolean;
  /** Max SSE connections */
  maxSseConnections: number;
  /** Optional prover URL for proof delegation */
  proverUrl?: string;
  /** Optional prover API key */
  proverApiKey?: string;
  /** Allowed CORS origins */
  allowedOrigins: string[];
  /** Insurer Nautilus URL for enrollment notification (optional) */
  insurerUrl?: string;
  /** Employer Nautilus URL for enrollment confirmation (optional) */
  employerUrl?: string;
  /** Admin token for admin methods (unsecure mode / backward compat) */
  adminToken?: string;
  /** Authorized client Ed25519 public keys: Map<clientId, publicKeyHex>. When set, admin routes require Ed25519 signature. */
  authorizedClientKeys?: Map<string, string>;
  /** Display name for logging */
  displayName?: string;
  /** Directory containing static dashboard files (index.html, etc.) */
  dashboardDir?: string;
  /** Directory containing marketplace dashboard (served at /marketplace/) */
  marketplaceDashboardDir?: string;
}

// ─── Route Registration ────────────────────────────────────────

/** HTTP method for route registration */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Route handler function */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
) => Promise<void>;

/** A single route registration */
export interface RouteRegistration {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  /** If true, requires Bearer token authentication */
  adminOnly?: boolean;
}

// ─── API Response Types ────────────────────────────────────────

/** Standard Nautilus API response envelope */
export interface NautilusApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

/** Health check response */
export interface NautilusHealthResponse {
  role: EntityRole;
  phase: OnboardingPhase;
  sequencerConnected: boolean;
  walletId?: string;
  displayName?: string;
  uptime: number;
  tls: boolean;
  sequencerUrl?: string;
}
