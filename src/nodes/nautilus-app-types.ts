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
 * Nautilus App Types — shared type definitions for all Nautilus Node App servers.
 *
 * Each entity type (member, prescriber, pharmacy, insurer) gets a Nautilus App
 * that serves REST endpoints for its frontend. These types are shared across
 * all entity-specific route handlers and the core app server.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { EntityRole } from './entity-node-types.js';
import type { RpcProxyPolicy } from '../security/network-policy.js';

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
  /** A2: whether and how POST /rpc forwards to the sequencer. Off unless explicitly set. */
  rpcProxy?: RpcProxyPolicy;
  /** Insurer Nautilus URL for enrollment notification (optional) */
  insurerUrl?: string;
  /** Employer Nautilus URL for enrollment confirmation (optional) */
  employerUrl?: string;
  /** Admin token for admin methods (unsecure mode / backward compat) */
  adminToken?: string;
  /**
   * The insurer's dedicated Ed25519 attestation signing seed — phase A item A9, finding A-14.
   *
   * Employer attestations used to be counter-signed with `adminToken`. A bearer token reused as a
   * signing seed is worse than one that is merely shared: a bearer token is something you present,
   * a signing key is what makes statements attributable to you. That token is handed to every
   * child node at boot and is the literal string `admin123` in unsecure mode, so anyone holding it
   * could counter-sign as the insurer.
   */
  insurerSigningSeed?: string;
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
  /**
   * If true, requires a device session — phase A item A5, findings A-7 and MEM-H1.
   *
   * The member node had 31 routes and **none** of them authenticated anything. The session is
   * issued by `/onboarding/unlock`, which since item A4 actually verifies the PIN, so holding one
   * means "someone proved this device's PIN in this process's lifetime". That is the strongest
   * claim a device can make about its own user without asking for the PIN on every request, which
   * would mean the browser keeping the PIN — a worse answer.
   */
  deviceOnly?: boolean;
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
