#!/usr/bin/env node
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
 * bootstrap-system.ts — Full System Bootstrap (Pre-Member Setup)
 *
 * ===========================================================================
 * DEPRECATED as of Phase A. This script assumes a boot-time employer node at
 * port 4005 with a hardcoded ACME-001 identity. After Phase A, employer nodes
 * are only spawned on-demand by the marketplace activation handler, with a
 * real employerId + Ed25519 public key pin. Running this script will fail at
 * Step 4 (createGroup) because there is no employer node at 4005 to talk to.
 *
 * This script is kept for reference only. To bootstrap a production system,
 * use the marketplace flow at http://localhost:4004/marketplace/ instead.
 * ===========================================================================
 *
 * Starts the entire zkpCare network and performs all operational setup
 * so that a member can walk up and enroll immediately.
 *
 * Order of Operations:
 *   1. Kill any existing processes on zkpCare ports
 *   2. Start Leviathan (sequencer + replicas + all entity nodes)
 *   3. Wait for all nodes to become healthy
 *   4. Employer: create benefit group (ACME-CORP / PLAN-GOLD-2026)
 *   5. Employer: generate enrollment token for first member slot
 *   6. Print token ID — member is ready to enroll
 *
 * Usage:
 *   npx tsx scripts/bootstrap-system.ts
 *   npx tsx scripts/bootstrap-system.ts --tokens 5    # generate 5 tokens
 *   npx tsx scripts/bootstrap-system.ts --skip-kill    # don't kill existing ports
 *
 * After this script completes:
 *   → Open http://localhost:4001 (Member Dashboard)
 *   → Paste the token ID → complete onboarding
 *   → Member is live on the network
 */
import { execSync, spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDir, '..');

// ── CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const skipKill = args.includes('--skip-kill');
const tokenCountArg = args.find(a => a.startsWith('--tokens'));
const tokenCount = tokenCountArg
  ? parseInt(args[args.indexOf(tokenCountArg) + 1] || '1', 10)
  : 1;

// ── Config ────────────────────────────────────────────────────

const PORTS = {
  sequencer: 3030,
  replica1: 3031,
  replica2: 3032,
  member: 4001,
  prescriber: 4002,
  pharmacy: 4003,
  insurer: 4004,
  employer: 4005,
  prover: 4040,
  explorer: 8000,
};

const ADMIN_TOKEN = 'admin123';

const GROUP_CONFIG = {
  groupId: 'ACME-CORP',
  planId: 'PLAN-GOLD-2026',
  effectiveDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  enrollmentCap: 100,
};

// ── Helpers ───────────────────────────────────────────────────

function log(phase: string, msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`  [${ts}] [${phase}] ${msg}`);
}

function banner(text: string): void {
  console.log('');
  console.log(`  ── ${text} ${'─'.repeat(Math.max(0, 52 - text.length))}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(
  url: string,
  label: string,
  maxAttempts: number = 120,
  requiredPhase?: string,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) {
        const json = (await resp.json()) as any;
        const phase = json?.data?.phase ?? json?.phase;
        if (!requiredPhase || phase === requiredPhase) {
          log('health', `${label} ready (phase: ${phase || 'ok'})`);
          return true;
        }
      }
    } catch {
      // not ready yet
    }
    if (i > 0 && i % 15 === 0) {
      log('health', `Still waiting for ${label}... (${i}s)`);
    }
    await sleep(1000);
  }
  log('health', `TIMEOUT waiting for ${label} after ${maxAttempts}s`);
  return false;
}

async function apiCall(
  baseUrl: string,
  method: string,
  pathStr: string,
  body?: Record<string, unknown>,
  admin: boolean = false,
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (admin) headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
  const opts: RequestInit = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const resp = await fetch(`${baseUrl}${pathStr}`, opts);
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    throw new Error(`${method} ${pathStr} → ${resp.status}: ${data?.error || data?.message || text}`);
  }
  // Unwrap Nautilus envelope
  if (data && data.ok !== undefined && data.data !== undefined) return data.data;
  return data;
}

// ── Step 1: Kill existing processes ───────────────────────────

async function killPorts(): Promise<void> {
  banner('Step 1: Clean up existing processes');
  const allPorts = Object.values(PORTS);
  for (const port of allPorts) {
    try {
      const output = execSync('netstat -ano', { encoding: 'utf8' });
      const line = output.split('\n').find(
        (l) => l.includes(`:${port} `) && l.includes('LISTEN'),
      );
      if (line) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') {
          execSync(`taskkill /F /PID ${pid}`);
          log('kill', `Killed PID ${pid} on port ${port}`);
        }
      }
    } catch {
      // Port not in use — fine
    }
  }
  log('kill', 'Ports cleared');
  await sleep(1000); // Give OS time to release ports
}

// ── Step 2: Start Leviathan ───────────────────────────────────

function startLeviathan(): ChildProcess {
  banner('Step 2: Start Leviathan (sequencer + all entities)');
  const child = spawn('npx', ['tsx', 'src/nodes/start-leviathan.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ZKTRIDENT_ADMIN_TOKEN: ADMIN_TOKEN,
      ZKTRIDENT_EMPLOYER_ID: GROUP_CONFIG.groupId.replace('-CORP', '-001'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n  [FATAL] Leviathan exited with code ${code}`);
      process.exit(1);
    }
  });
  log('start', 'Leviathan process spawned');
  return child;
}

// ── Step 3: Wait for all nodes ────────────────────────────────

async function waitForAllNodes(): Promise<void> {
  banner('Step 3: Wait for all nodes to become healthy');

  // Sequencer must come up first
  const seqReady = await waitForHealth(
    `http://localhost:${PORTS.sequencer}`, 'Sequencer', 60,
  );
  if (!seqReady) {
    console.error('  [FATAL] Sequencer did not start');
    process.exit(1);
  }

  // Wait for all entity nodes in parallel
  const results = await Promise.all([
    waitForHealth(`http://localhost:${PORTS.insurer}`, 'Insurer', 120, 'ready'),
    waitForHealth(`http://localhost:${PORTS.prescriber}`, 'Prescriber', 120, 'ready'),
    waitForHealth(`http://localhost:${PORTS.pharmacy}`, 'Pharmacy', 120, 'ready'),
    waitForHealth(`http://localhost:${PORTS.employer}`, 'Employer', 120, 'ready'),
    waitForHealth(`http://localhost:${PORTS.member}`, 'Member', 60),
    waitForHealth(`http://localhost:${PORTS.explorer}`, 'Explorer', 30),
  ]);

  const allReady = results.every(Boolean);
  if (!allReady) {
    log('health', 'WARNING: Some nodes did not reach ready state — continuing anyway');
  }

  // Open all dashboards in the browser
  openAllDashboards();
}

// ── Step 3a: Open all dashboards in browser ───────────────────

function openAllDashboards(): void {
  banner('Step 3a: Open all dashboards in browser');
  const dashboards = [
    { label: 'Leviathan Sequencer', port: PORTS.sequencer },
    { label: 'Member',              port: PORTS.member },
    { label: 'Prescriber',          port: PORTS.prescriber },
    { label: 'Pharmacy',            port: PORTS.pharmacy },
    { label: 'Insurer',             port: PORTS.insurer },
    { label: 'Employer',            port: PORTS.employer },
    { label: 'Explorer',            port: PORTS.explorer },
  ];
  for (const d of dashboards) {
    const url = `http://localhost:${d.port}`;
    try {
      execSync(`start "" "${url}"`, { shell: true, stdio: 'ignore' });
      log('browser', `Opened ${d.label} → ${url}`);
    } catch {
      log('browser', `Failed to open ${d.label} — open manually: ${url}`);
    }
  }
}

// ── Step 4: Create employer group ─────────────────────────────

async function createGroup(): Promise<void> {
  banner('Step 4: Create employer benefit group');
  const employerUrl = `http://localhost:${PORTS.employer}`;

  try {
    // Check if group already exists
    const groups = await apiCall(employerUrl, 'GET', '/groups');
    const existing = Array.isArray(groups)
      ? groups.find((g: any) => g.groupId === GROUP_CONFIG.groupId)
      : null;

    if (existing) {
      log('group', `Group "${GROUP_CONFIG.groupId}" already exists — skipping`);
      return;
    }
  } catch {
    // No groups yet — create one
  }

  try {
    const result = await apiCall(employerUrl, 'POST', '/groups', {
      groupId: GROUP_CONFIG.groupId,
      planId: GROUP_CONFIG.planId,
      effectiveDate: GROUP_CONFIG.effectiveDate,
      enrollmentCap: GROUP_CONFIG.enrollmentCap,
    }, true);
    log('group', `Created group "${GROUP_CONFIG.groupId}" (plan: ${GROUP_CONFIG.planId}, cap: ${GROUP_CONFIG.enrollmentCap})`);
  } catch (e: any) {
    log('group', `Group creation: ${e.message}`);
    // May already exist from a previous run — not fatal
  }
}

// ── Step 5: Generate enrollment tokens ────────────────────────

async function generateTokens(): Promise<string[]> {
  banner(`Step 5: Generate ${tokenCount} enrollment token(s)`);
  const employerUrl = `http://localhost:${PORTS.employer}`;
  const tokens: string[] = [];

  for (let i = 0; i < tokenCount; i++) {
    try {
      const employeeId = `EMP-${String(i + 1).padStart(4, '0')}`;
      const result = await apiCall(employerUrl, 'POST', '/tokens/generate', {
        groupId: GROUP_CONFIG.groupId,
        employeeId,
        familyId: employeeId,
        validUntil: '2026-12-31',
      }, true);
      const tokenId = result?.tokenId || result?.token?.tokenId || result?.id;
      if (tokenId) {
        tokens.push(tokenId);
        log('token', `Token ${i + 1}: ${tokenId}`);
      } else {
        log('token', `Token ${i + 1} generated (response: ${JSON.stringify(result).slice(0, 100)})`);
        // Try to extract any string ID
        if (typeof result === 'string') tokens.push(result);
      }
    } catch (e: any) {
      log('token', `Token generation failed: ${e.message}`);
    }
  }

  return tokens;
}

// ── Final Summary ─────────────────────────────────────────────

function printSummary(tokens: string[]): void {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║     ✓  SYSTEM READY — All Nodes Operational         ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Network Status:');
  console.log('  ───────────────');
  console.log('  Sequencer:     http://localhost:%d/rpc', PORTS.sequencer);
  console.log('  Replicas:      http://localhost:%d, %d', PORTS.replica1, PORTS.replica2);
  console.log('  Insurer:       http://localhost:%d   (providers credentialed, formulary published)', PORTS.insurer);
  console.log('  Prescriber:    http://localhost:%d   (Dr. Sarah Chen, credentialed)', PORTS.prescriber);
  console.log('  Pharmacy:      http://localhost:%d   (Main Street Pharmacy, credentialed)', PORTS.pharmacy);
  console.log('  Employer:      http://localhost:%d   (ACME-001, group + tokens ready)', PORTS.employer);
  console.log('  Member:        http://localhost:%d   (awaiting enrollment)', PORTS.member);
  console.log('  Explorer:      http://localhost:%d', PORTS.explorer);
  console.log('');
  console.log('  Benefit Group:');
  console.log('  ──────────────');
  console.log('  Group:         %s', GROUP_CONFIG.groupId);
  console.log('  Plan:          %s', GROUP_CONFIG.planId);
  console.log('  Effective:     %s', GROUP_CONFIG.effectiveDate);
  console.log('  Cap:           %d members', GROUP_CONFIG.enrollmentCap);
  console.log('');

  if (tokens.length > 0) {
    console.log('  Enrollment Token(s):');
    console.log('  ────────────────────');
    tokens.forEach((t, i) => {
      console.log('  %d. %s', i + 1, t);
    });
    console.log('');
    console.log('  ─────────────────────────────────────────────────────');
    console.log('  Next: Open http://localhost:4001 → paste token → enroll');
    console.log('  ─────────────────────────────────────────────────────');
  } else {
    console.log('  WARNING: No tokens generated — create manually in employer dashboard');
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║     🐚  zkpCare System Bootstrap                    ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  This will start the full network and prepare it for');
  console.log('  member enrollment. Tokens: %d', tokenCount);
  console.log('');

  // Step 1: Kill ports (unless --skip-kill)
  if (!skipKill) {
    await killPorts();
  } else {
    log('kill', 'Skipped (--skip-kill)');
  }

  // Step 2: Start Leviathan (which spawns all child nodes)
  const leviathan = startLeviathan();

  // Step 3: Wait for all nodes to become healthy
  await waitForAllNodes();

  // Step 4: Create employer group
  await createGroup();

  // Step 5: Generate enrollment tokens
  const tokens = await generateTokens();

  // Done
  printSummary(tokens);

  // Keep running — Ctrl+C to stop
  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    leviathan.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000);
  });
  process.on('SIGTERM', () => {
    leviathan.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000);
  });
}

main().catch((err) => {
  console.error('  [FATAL] Bootstrap failed:', err);
  process.exit(1);
});
