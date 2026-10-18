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
 * HR Tool Core — PII hashing, encrypted storage, and correlation table management.
 *
 * Runs on the employer's admin workstation ONLY. Never deployed to the employer node server.
 *
 * Security properties:
 *   - GroupSeed: 32 random bytes, encrypted at rest with passphrase (scrypt + AES-256-GCM)
 *   - Correlation table: encrypted JSON (AES-256-GCM), maps hash → plaintext for HR lookup
 *   - Atomic file writes (temp → fsync → rename) prevent corruption on crash
 *   - Hash-set reconciliation (not count-only) prevents substitution attacks
 *   - Domain-separated Poseidon hashing prevents cross-type collisions
 *   - Token secrets output to encrypted file only — never emailed
 */
import {
  createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv,
  generateKeyPairSync, createPrivateKey, sign as ed25519Sign,
} from 'crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync } from 'fs';
import { join } from 'path';
import { Poseidon, Encoding, Field } from 'o1js';

// ─── Constants ──────────────────────────────────────────────

const SCRYPT_N = 2 ** 17; // 128K — OWASP minimum
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 512 * 1024 * 1024; // 512 MB (needed for N=2^17)
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 32;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

/** Regex for valid groupId values — prevents path traversal */
const GROUP_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

/** Domain tags for Poseidon hashing — prevents cross-type collisions */
const DOMAIN_TAG_EMPLOYEE = Field(1);
const DOMAIN_TAG_FAMILY = Field(2);
const DOMAIN_TAG_SEED = Field(3);

// ─── Types ──────────────────────────────────────────────────

/** A single employee record parsed from CSV */
export interface EmployeeRecord {
  employeeId: string;
  familyId: string;
  firstName: string;
  lastName: string;
  dob: string;
  email?: string;
  /** Additional CSV columns preserved as-is */
  extra: Record<string, string>;
}

/** Correlation table entry — maps hashes back to plaintext for HR use */
export interface CorrelationEntry {
  employeeIdHash: string;
  familyIdHash: string;
  employeeId: string;
  familyId: string;
  firstName: string;
  lastName: string;
  dob: string;
  email?: string;
  tokenId?: string;
  tokenIdHash?: string;
  /** 8-digit enrollment PIN — second factor, delivered via SMS */
  tokenPIN?: string;
  /** Poseidon(tokenId || PIN) — sent to employer node, never the PIN itself */
  tokenPinHash?: string;
  status: 'pending' | 'token_generated' | 'enrolled' | 'terminated';
  createdAt: string;
}

/** Full correlation table (encrypted at rest) */
export interface CorrelationTable {
  groupId: string;
  planId: string;
  createdAt: string;
  entries: CorrelationEntry[];
}

/** Phase F3: Workspace metadata — a small JSON record stored encrypted at
 *  {wsDir}/workspace.meta.enc. Tracks which employer node this workspace
 *  belongs to and when it was created. */
export interface WorkspaceMeta {
  version: 1;
  employerNodeUrl: string;
  createdAt: string;
  /** Display label for the workspace (defaults to employer node URL) */
  label?: string;
}

/** Token distribution record (for secure output file) */
export interface TokenDistributionRecord {
  employeeIdHash: string;
  tokenId: string;
  tokenIdHash: string;
  /** A7: never populated by the server's export. PINs are returned once, at import. */
  tokenPIN?: string;
  validUntil: string;
  /** First name + last initial for distribution (e.g. "Jane D.") */
  displayName: string;
}

/** Reconciliation result */
export interface ReconciliationResult {
  /** Hashes in local table but not on employer node roster */
  missingFromNode: string[];
  /** Hashes on employer node roster but not in local table */
  unknownOnNode: string[];
  /** Status mismatches between local table and node roster */
  statusMismatches: Array<{
    employeeIdHash: string;
    localStatus: string;
    nodeStatus: string;
  }>;
  /** Summary */
  totalLocal: number;
  totalNode: number;
  matched: number;
}

// ─── Encryption Helpers ─────────────────────────────────────

/** Derive an AES-256 key from a passphrase using scrypt */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

/** Encrypt data with AES-256-GCM using a passphrase */
export function encryptWithPassphrase(plaintext: string, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: salt(32) || iv(12) || tag(16) || ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]);
}

/** Encrypt data with AES-256-GCM using a pre-derived key */
export function encryptWithKey(plaintext: string, key: Buffer): Buffer {
  const salt = randomBytes(SALT_LEN); // placeholder — not used for key derivation
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]);
}

/** Decrypt data encrypted with encryptWithPassphrase */
export function decryptWithPassphrase(data: Buffer, passphrase: string): string {
  const salt = data.subarray(0, SALT_LEN);
  const iv = data.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = data.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const ciphertext = data.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Decrypt data encrypted with encryptWithKey */
export function decryptWithKey(data: Buffer, key: Buffer): string {
  const iv = data.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = data.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const ciphertext = data.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ─── Atomic File Write ──────────────────────────────────────

/** Write to a file atomically: write temp → fsync → rename */
function atomicWriteFileSync(filePath: string, data: Buffer): void {
  const tmpPath = filePath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, data);
  const fd = openSync(tmpPath, 'r+');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmpPath, filePath);
}

// ─── GroupSeed Management ───────────────────────────────────

/** Generate a new random groupSeed (32 bytes) */
export function generateGroupSeed(): Buffer {
  return randomBytes(32);
}

/** Save groupSeed encrypted with passphrase */
export function saveGroupSeed(seedPath: string, seed: Buffer, passphrase: string): void {
  const encrypted = encryptWithPassphrase(seed.toString('hex'), passphrase);
  atomicWriteFileSync(seedPath, encrypted);
}

/** Load and decrypt groupSeed */
export function loadGroupSeed(seedPath: string, passphrase: string): Buffer {
  const data = readFileSync(seedPath);
  const hex = decryptWithPassphrase(data, passphrase);
  return Buffer.from(hex, 'hex');
}

/** Validate a groupId for filesystem safety */
export function validateGroupId(groupId: string): boolean {
  return GROUP_ID_REGEX.test(groupId) && groupId.length > 0 && groupId.length <= 64;
}

// ─── Workspace Metadata (Phase F3) ──────────────────────────

/** Save workspace metadata (small encrypted JSON). */
export function saveWorkspaceMeta(metaPath: string, meta: WorkspaceMeta, passphrase: string): void {
  const encrypted = encryptWithPassphrase(JSON.stringify(meta), passphrase);
  atomicWriteFileSync(metaPath, encrypted);
}

/** Load and decrypt workspace metadata. */
export function loadWorkspaceMeta(metaPath: string, passphrase: string): WorkspaceMeta {
  const data = readFileSync(metaPath);
  const json = decryptWithPassphrase(data, passphrase);
  return JSON.parse(json) as WorkspaceMeta;
}

// ─── PII Hashing ────────────────────────────────────────────

/**
 * Hash an identifier with groupSeed and domain tag using Poseidon.
 *
 * Formula: Poseidon.hash([domainTag, Poseidon.hash([DOMAIN_TAG_SEED, ...stringToFields(groupSeed_hex)]), Poseidon.hash([domainTag, ...stringToFields(identifier)])])
 *
 * Domain separation prevents a groupId hash from colliding with an employeeId hash.
 * The groupSeed ensures the same employeeId produces different hashes
 * across different employer groups, preventing cross-group linkability.
 */
export function hashWithSeed(identifier: string, groupSeed: Buffer, domainTag: Field = DOMAIN_TAG_EMPLOYEE): string {
  const seedField = Poseidon.hash([DOMAIN_TAG_SEED, ...Encoding.stringToFields(groupSeed.toString('hex'))]);
  const idField = Poseidon.hash([domainTag, ...Encoding.stringToFields(identifier)]);
  return Poseidon.hash([domainTag, seedField, idField]).toString();
}

/**
 * Hash an employee ID with groupSeed (domain tag = EMPLOYEE).
 */
export function hashEmployeeId(identifier: string, groupSeed: Buffer): string {
  return hashWithSeed(identifier, groupSeed, DOMAIN_TAG_EMPLOYEE);
}

/**
 * Hash a family ID with groupSeed (domain tag = FAMILY).
 */
export function hashFamilyId(identifier: string, groupSeed: Buffer): string {
  return hashWithSeed(identifier, groupSeed, DOMAIN_TAG_FAMILY);
}

// ─── Token PIN ──────────────────────────────────────────────

/**
 * Generate a cryptographically random 8-digit PIN.
 * Uses rejection sampling to eliminate modulo bias.
 */
export function generateTokenPIN(): string {
  const MAX_UNBIASED = 4_200_000_000; // largest multiple of 10^8 below 2^32
  let num: number;
  do {
    const buf = randomBytes(4);
    num = buf.readUInt32BE(0);
  } while (num >= MAX_UNBIASED);
  return String(num % 100_000_000).padStart(8, '0');
}

/**
 * Compute the PIN binding hash: Poseidon([...stringToFields(tokenId), ...stringToFields(pin)]).
 *
 * Uses structured hashing (separate field arrays) instead of string concatenation
 * to prevent crafted tokenId collisions.
 *
 * This hash is stored on the employer node alongside the token record.
 * At enrollment, the member provides tokenId + PIN, and the insurer
 * verifies the hash matches.
 *
 * The PIN itself never touches the employer node or insurer — only the hash.
 */
export function hashTokenPIN(tokenId: string, pin: string): string {
  return Poseidon.hash([
    ...Encoding.stringToFields(tokenId),
    Field(0), // separator field — prevents field-boundary ambiguity
    ...Encoding.stringToFields(pin),
  ]).toString();
}

// ─── CSV Parsing ────────────────────────────────────────────

/**
 * Parse a CSV file into EmployeeRecord[].
 *
 * Expected columns (case-insensitive, order-independent):
 *   employee_id, family_id, first_name, last_name, dob, email (optional)
 *
 * Any additional columns are preserved in the `extra` field.
 */
export function parseCsv(csvContent: string): EmployeeRecord[] {
  const lines = csvContent.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));

  const requiredCols = ['employee_id', 'family_id', 'first_name', 'last_name', 'dob'];
  for (const col of requiredCols) {
    if (!headers.includes(col)) {
      throw new Error(`Missing required CSV column: ${col}`);
    }
  }

  const records: EmployeeRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length !== headers.length) {
      throw new Error(`Row ${i + 1}: expected ${headers.length} columns, got ${values.length}`);
    }

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j].trim();
    }

    // Validate required fields are non-empty (prevents hash collisions on empty strings)
    for (const col of requiredCols) {
      if (!row[col]?.trim()) {
        throw new Error(`Row ${i + 1}: ${col} is empty`);
      }
    }

    const extra: Record<string, string> = {};
    for (const key of Object.keys(row)) {
      if (!requiredCols.includes(key) && key !== 'email') {
        extra[key] = row[key];
      }
    }

    records.push({
      employeeId: row['employee_id'],
      familyId: row['family_id'],
      firstName: row['first_name'],
      lastName: row['last_name'],
      dob: row['dob'],
      email: row['email'] || undefined,
      extra,
    });
  }

  return records;
}

/** Parse a single CSV line respecting quoted fields */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Correlation Table ──────────────────────────────────────

/** Save correlation table encrypted with passphrase (atomic write) */
export function saveCorrelationTable(
  tablePath: string,
  table: CorrelationTable,
  passphrase: string,
): void {
  const json = JSON.stringify(table, null, 2);
  const encrypted = encryptWithPassphrase(json, passphrase);
  atomicWriteFileSync(tablePath, encrypted);
}

/** Save correlation table encrypted with a pre-derived key (atomic write) */
export function saveCorrelationTableWithKey(
  tablePath: string,
  table: CorrelationTable,
  key: Buffer,
): void {
  const json = JSON.stringify(table, null, 2);
  const encrypted = encryptWithKey(json, key);
  atomicWriteFileSync(tablePath, encrypted);
}

/** Load and decrypt correlation table */
export function loadCorrelationTable(
  tablePath: string,
  passphrase: string,
): CorrelationTable {
  const data = readFileSync(tablePath);
  const json = decryptWithPassphrase(data, passphrase);
  return JSON.parse(json) as CorrelationTable;
}

// ─── Batch Processing ───────────────────────────────────────

/**
 * Process employee records: hash PII with groupSeed, build correlation entries.
 * Uses domain-separated hashing: EMPLOYEE tag for employeeId, FAMILY tag for familyId.
 * Does NOT call the employer node — that's done in the CLI/server layer.
 */
export function hashEmployeeRecords(
  records: EmployeeRecord[],
  groupSeed: Buffer,
  groupId: string,
  planId: string,
): { entries: CorrelationEntry[]; table: CorrelationTable } {
  const entries: CorrelationEntry[] = [];

  for (const rec of records) {
    const employeeIdHash = hashEmployeeId(rec.employeeId, groupSeed);
    const familyIdHash = hashFamilyId(rec.familyId, groupSeed);

    entries.push({
      employeeIdHash,
      familyIdHash,
      employeeId: rec.employeeId,
      familyId: rec.familyId,
      firstName: rec.firstName,
      lastName: rec.lastName,
      dob: rec.dob,
      email: rec.email,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  const table: CorrelationTable = {
    groupId,
    planId,
    createdAt: new Date().toISOString(),
    entries,
  };

  return { entries, table };
}

// ─── Reconciliation ─────────────────────────────────────────

/**
 * Hash-set reconciliation between local correlation table and employer node roster.
 *
 * Uses full hash comparison (not count-only) to detect:
 *   - Entries in local table but missing from node (token generation failed?)
 *   - Entries on node but not in local table (unauthorized enrollment?)
 *   - Status mismatches (local says pending, node says enrolled)
 */
export function reconcile(
  localEntries: CorrelationEntry[],
  nodeRoster: Array<{ employeeIdHash: string; status: string }>,
): ReconciliationResult {
  const localHashSet = new Set(localEntries.map(e => e.employeeIdHash));
  const nodeHashMap = new Map(nodeRoster.map(e => [e.employeeIdHash, e.status]));
  const nodeHashSet = new Set(nodeRoster.map(e => e.employeeIdHash));

  const missingFromNode: string[] = [];
  const statusMismatches: ReconciliationResult['statusMismatches'] = [];
  let matched = 0;

  for (const entry of localEntries) {
    if (!nodeHashSet.has(entry.employeeIdHash)) {
      missingFromNode.push(entry.employeeIdHash);
    } else {
      matched++;
      const nodeStatus = nodeHashMap.get(entry.employeeIdHash)!;
      if (entry.status !== nodeStatus) {
        statusMismatches.push({
          employeeIdHash: entry.employeeIdHash,
          localStatus: entry.status,
          nodeStatus,
        });
      }
    }
  }

  const unknownOnNode: string[] = [];
  for (const hash of nodeHashSet) {
    if (!localHashSet.has(hash)) {
      unknownOnNode.push(hash);
    }
  }

  return {
    missingFromNode,
    unknownOnNode,
    statusMismatches,
    totalLocal: localEntries.length,
    totalNode: nodeRoster.length,
    matched,
  };
}

// ─── Data Directory ─────────────────────────────────────────

/** Ensure the HR Tool data directory exists */
export function ensureDataDir(dataDir: string): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

/** Standard file paths within a group data directory (legacy flat layout).
 *  Retained for backward compatibility with pre-Phase-F state files. */
export function groupPaths(dataDir: string, groupId: string) {
  if (!validateGroupId(groupId)) {
    throw new Error('Invalid group ID: must be alphanumeric, hyphens, or underscores only');
  }
  const groupDir = join(dataDir, groupId);
  return {
    groupDir,
    seedFile: join(groupDir, 'group.seed.enc'),
    tableFile: join(groupDir, 'correlation.table.enc'),
    tokensFile: join(groupDir, 'token-distribution.enc'),
    auditFile: join(groupDir, 'audit.log'),
    keyFile: join(groupDir, 'client.key.enc'),
  };
}

/** Phase F3: derive a stable workspace directory name from an employer node URL.
 *  Uses SHA-256 truncated to 16 hex chars so workspace dirs stay readable and
 *  different employer URLs (http vs https, different ports) never collide. */
export function workspaceDirName(employerNodeUrl: string): string {
  const normalized = employerNodeUrl.replace(/\/+$/, '').toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return 'workspace-' + hash;
}

/** Phase F3: Paths for a workspace. The workspace is the HR admin's session
 *  container — it holds the client key and one subdirectory per group that's
 *  been initialized locally. Groups are pulled from the employer node at
 *  unlock time; seeds are generated lazily on first group selection. */
export function workspacePaths(dataDir: string, employerNodeUrl: string) {
  const wsName = workspaceDirName(employerNodeUrl);
  const wsDir = join(dataDir, wsName);
  return {
    wsDir,
    metaFile: join(wsDir, 'workspace.meta.enc'),
    keyFile: join(wsDir, 'client.key.enc'),
    groupsDir: join(wsDir, 'groups'),
  };
}

/** Phase F3: Paths for a specific group inside a workspace. */
export function workspaceGroupPaths(dataDir: string, employerNodeUrl: string, groupId: string) {
  if (!validateGroupId(groupId)) {
    throw new Error('Invalid group ID: must be alphanumeric, hyphens, or underscores only');
  }
  const ws = workspacePaths(dataDir, employerNodeUrl);
  const groupDir = join(ws.groupsDir, groupId);
  return {
    groupDir,
    seedFile: join(groupDir, 'group.seed.enc'),
    tableFile: join(groupDir, 'correlation.table.enc'),
    tokensFile: join(groupDir, 'token-distribution.enc'),
    auditFile: join(groupDir, 'audit.log'),
  };
}

// ─── Ed25519 Client Identity ────────────────────────────────

/** PKCS8 DER prefix for Ed25519 private keys (RFC 8410) */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** SPKI DER prefix for Ed25519 public keys */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 keypair stored locally */
export interface HrToolClientKey {
  clientId: string;
  privateKeyHex: string;
  publicKeyHex: string;
  createdAt: string;
}

/**
 * Generate a new Ed25519 keypair for authenticating with the employer node.
 * The private key is encrypted at rest with the group passphrase.
 */
export function generateClientKey(clientId: string): HrToolClientKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Extract raw 32-byte keys from DER encoding
  const publicKeyHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString('hex');
  const privateKeyHex = privDer.subarray(ED25519_PKCS8_PREFIX.length).toString('hex');
  return { clientId, privateKeyHex, publicKeyHex, createdAt: new Date().toISOString() };
}

/** Save client key encrypted with passphrase */
export function saveClientKey(keyPath: string, key: HrToolClientKey, passphrase: string): void {
  const json = JSON.stringify(key);
  const encrypted = encryptWithPassphrase(json, passphrase);
  atomicWriteFileSync(keyPath, encrypted);
}

/** Load and decrypt client key */
export function loadClientKey(keyPath: string, passphrase: string): HrToolClientKey {
  const data = readFileSync(keyPath);
  const json = decryptWithPassphrase(data, passphrase);
  return JSON.parse(json) as HrToolClientKey;
}

/**
 * Sign an HTTP request for the employer node's Ed25519 auth.
 *
 * Produces X-Admin-Signature header value: clientId:timestamp:signatureHex
 * Also produces X-Content-Hash header value (SHA-256 of body).
 *
 * The employer node's checkNautilusAdminAuth verifies:
 *   message = `${method}:${path}|${timestamp}|${contentHash}`
 */
export function signEmployerRequest(
  method: string,
  path: string,
  body: string | undefined,
  clientKey: HrToolClientKey,
): { signature: string; contentHash: string; timestamp: string } {
  const timestamp = String(Date.now());
  const contentHash = body ? createHash('sha256').update(body).digest('hex') : '';
  const message = `${method}:${path}|${timestamp}|${contentHash}`;

  const pkDer = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(clientKey.privateKeyHex, 'hex')]);
  const privateKey = createPrivateKey({ key: pkDer, format: 'der', type: 'pkcs8' });
  const sig = ed25519Sign(null, Buffer.from(message), privateKey);

  return {
    signature: `${clientKey.clientId}:${timestamp}:${sig.toString('hex')}`,
    contentHash,
    timestamp,
  };
}
