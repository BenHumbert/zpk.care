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
 * Signed HTTP requests between nodes — phase A item A6, and the mechanism A9's remainder builds on.
 *
 * Wire format, unchanged from what the HR Tool already sends and `checkNautilusAdminAuth` already
 * reads, so one format serves the whole network:
 *
 *     X-Admin-Signature: <signerId>:<timestamp ms>:<ed25519 signature hex>
 *     X-Content-Hash:    <sha256 hex of the request body>          (omitted when there is no body)
 *     message          = `${METHOD}:${path}|${timestamp}|${contentHash}`
 *
 * What is different from the admin path, and why this module exists rather than a call into it:
 *
 *   - **The content hash is recomputed from the body the server actually received** and must
 *     equal the header. The admin path signs over whatever hash the caller claims (AUTH-14), which
 *     binds the signature to nothing. Here a signature covers the bytes that arrived.
 *   - **The verifier names the signer it expects** and the key it trusts for that signer. There is
 *     no registry lookup by the caller's own claimed ID; the caller must be who the route is for.
 *   - **A replay cache**, keyed by the signature, refuses the same signature twice inside the
 *     window. The window itself is 30 s, as the admin path's is.
 *
 * Only `node:crypto` is imported, so both ends of an exchange can depend on this.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
  timingSafeEqual,
  type KeyObject,
} from 'crypto';

export const SIGNATURE_HEADER = 'x-admin-signature';
export const CONTENT_HASH_HEADER = 'x-content-hash';
/** How far a request's timestamp may sit from the verifier's clock, either way. */
export const DEFAULT_WINDOW_MS = 30_000;

const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';

/** SHA-256 of a body as hex, or the empty string for no body. */
export function contentHashOf(body: string | Buffer | undefined | null): string {
  if (body === undefined || body === null || body.length === 0) return '';
  return createHash('sha256').update(body).digest('hex');
}

/** The exact bytes that are signed. */
export function signedMessage(method: string, path: string, timestamp: string, contentHash: string): Buffer {
  return Buffer.from(`${method.toUpperCase()}:${path}|${timestamp}|${contentHash}`, 'utf8');
}

/** An Ed25519 private key from its 32-byte seed, for callers that hold one as hex. */
export function privateKeyFromSeedHex(seedHex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('privateKeyFromSeedHex: expected 32 bytes of hex');
  return createPrivateKey({
    key: Buffer.from(ED25519_PKCS8_PREFIX + seedHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Headers to attach to a request so a verifier holding `signerId`'s public key accepts it. */
export function signRequest(opts: {
  signerId: string;
  privateKey: KeyObject;
  method: string;
  path: string;
  body?: string | Buffer;
  now?: number;
}): Record<string, string> {
  if (!opts.signerId || opts.signerId.includes(':')) {
    throw new Error('signRequest: signerId is required and may not contain ":"');
  }
  const timestamp = String(opts.now ?? Date.now());
  const contentHash = contentHashOf(opts.body);
  const signature = ed25519Sign(null, signedMessage(opts.method, opts.path, timestamp, contentHash), opts.privateKey);
  const headers: Record<string, string> = {
    'X-Admin-Signature': `${opts.signerId}:${timestamp}:${signature.toString('hex')}`,
  };
  if (contentHash) headers['X-Content-Hash'] = contentHash;
  return headers;
}

/**
 * Remembers signatures it has accepted for a while, so a captured request cannot be presented
 * again inside the timestamp window. Memory is bounded by sweeping expired entries.
 */
export class ReplayCache {
  private readonly expiry = new Map<string, number>();

  constructor(private readonly ttlMs: number = DEFAULT_WINDOW_MS * 2) {}

  /** Record `key`; returns true if it had already been recorded and has not expired. */
  seen(key: string, now: number = Date.now()): boolean {
    const until = this.expiry.get(key);
    if (until !== undefined && until > now) return true;
    if (this.expiry.size >= 4096) this.sweep(now);
    this.expiry.set(key, now + this.ttlMs);
    return false;
  }

  get size(): number { return this.expiry.size; }

  private sweep(now: number): void {
    for (const [k, until] of this.expiry) if (until <= now) this.expiry.delete(k);
  }
}

export type VerifyOutcome =
  | { ok: true; signerId: string; timestamp: number }
  | { ok: false; reason: string };

/** Header names are case-insensitive; Node lower-cases them on the wire, a client-built map may not. */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a signed request against the one signer a route expects.
 *
 * `body` is the body as the server received it. When given (even as `''`), the content-hash
 * header must equal its SHA-256; a signer that sent no body sends no header, and `''` hashes to
 * `''`, so the two agree. Pass `undefined` only for a route that deliberately does not bind its
 * body, which none of the current callers do.
 */
export function verifySignedRequest(opts: {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  expectedSignerId: string;
  publicKeyHex: string;
  body?: string | Buffer;
  now?: number;
  windowMs?: number;
  replayCache?: ReplayCache;
}): VerifyOutcome {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  const sigHeader = headerValue(opts.headers, SIGNATURE_HEADER);
  if (!sigHeader) return { ok: false, reason: 'the request is not signed' };
  const parts = sigHeader.split(':');
  if (parts.length < 3) return { ok: false, reason: 'the signature header is malformed' };
  const signerId = parts[0];
  const timestampStr = parts[1];
  const signatureHex = parts.slice(2).join(':');

  // The trusted key is checked before anything that depends on it, and an unusable key refuses
  // rather than falling back to anything: fail closed, as every verifier in this codebase does.
  if (typeof opts.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(opts.publicKeyHex)) {
    return { ok: false, reason: 'no trusted key is configured for this signer' };
  }
  if (!constantTimeEqual(signerId, opts.expectedSignerId)) {
    return { ok: false, reason: 'the request was signed by a party this route does not accept' };
  }

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > windowMs) {
    return { ok: false, reason: 'the signature has expired' };
  }

  const claimedHash = headerValue(opts.headers, CONTENT_HASH_HEADER) ?? '';
  if (opts.body !== undefined) {
    const actualHash = contentHashOf(opts.body);
    if (!constantTimeEqual(claimedHash, actualHash)) {
      return { ok: false, reason: 'the signed content hash does not match the body received' };
    }
  }
  if (!/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length !== 128) {
    return { ok: false, reason: 'the signature is malformed' };
  }

  let valid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(ED25519_SPKI_PREFIX + opts.publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    valid = ed25519Verify(
      null,
      signedMessage(opts.method, opts.path, timestampStr, claimedHash),
      publicKey,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'the signature does not verify' };

  if (opts.replayCache && opts.replayCache.seen(signatureHex, now)) {
    return { ok: false, reason: 'this signature has already been presented' };
  }
  return { ok: true, signerId, timestamp };
}
