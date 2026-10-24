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
  | 'code_redeemed'      // C2: the insurer redeemed the code and answered the real group and plan
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
  /**
   * The Host names this node answers to beyond loopback and its bind address (A-82): a reverse proxy's public name.
   * Default: `ZKTRIDENT_PUBLIC_HOSTS`.
   */
  publicHosts?: string[];
  /**
   * The reverse proxies in front of this node, each by its exact IP address, whose X-Forwarded-For names the client a
   * per-caller limit counts (callerKey). Default: `ZKTRIDENT_TRUSTED_PROXIES`, none unless set. An entry that is not an
   * IP address stops the node at boot.
   */
  trustedProxies?: string[];
  /** The budget for a request before the server answers 504 (default 30 s). A route may declare a longer `timeoutMs`. */
  requestTimeoutMs?: number;
  /** A2: whether and how POST /rpc forwards to the sequencer. Off unless explicitly set. */
  rpcProxy?: RpcProxyPolicy;
  /** Insurer Nautilus URL for enrollment notification (optional) */
  insurerUrl?: string;
  /** Employer Nautilus URL for enrollment confirmation (optional) */
  employerUrl?: string;
  /** This node's own admin token, for this node's own admin routes (A9). Never a sequencer credential. */
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
  /** Client keys this node accepts for its admin routes beside its own bearer (A9): Map<clientId, publicKeyHex>, registered through `/admin/client-keys`. */
  authorizedClientKeys?: Map<string, string>;
  /**
   * This node's own Ed25519 key — plan item A9, finding A-14. Generated by the launcher for this
   * process and handed over as `ZKTRIDENT_NODE_ID` + `ZKTRIDENT_NODE_KEY_SEED`; its public half is
   * registered on the sequencer with this node's role. It signs every privileged call this node
   * makes to the sequencer. `adminToken` above is for this node's own routes and is never sent on.
   */
  nodeKey?: { nodeId: string; seedHex: string };
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
/**
 * How long a route that proves in-request may run before the server answers 504. A device's
 * registration proof takes 25 s on a workstation and a credential proof 25-31 s, behind a default
 * budget of 30 s: a slow proof must not read as a dead request.
 */
export const PROVING_BUDGET_MS = 180_000;

export interface RouteRegistration {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  /** This route's own budget before a 504, replacing the server's default; a route that proves declares `PROVING_BUDGET_MS`. */
  timeoutMs?: number;
  /** If true, requires this node's admin credential: its own bearer token, or a signature from a client key it registered (A9). */
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
  /**
   * The body types this route reads itself, instead of the JSON the server parses for it (A-82): the CP 575 upload's
   * `application/pdf`. A request must declare one of them; a route without the field takes `application/json` only.
   */
  bodyTypes?: readonly string[];
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
