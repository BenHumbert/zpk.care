#!/usr/bin/env npx tsx
/**
 * HR Tool CLI — Employer admin workstation tool for PII-safe enrollment.
 *
 * Runs on the employer's HR admin machine ONLY. Holds the plaintext
 * correlation table that maps Poseidon hashes back to employee identities.
 * The employer node server NEVER sees plaintext PII.
 *
 * Commands:
 *   init        — Initialize a new group with a random groupSeed
 *   import      — Read CSV roster, hash PII, generate tokens via employer node
 *   lookup      — Look up an employee by ID or hash in the correlation table
 *   reconcile   — Hash-set reconciliation between local table and node roster
 *   export      — Export token distribution file (for QR codes / portal)
 *   status      — Show group status summary
 *
 * Usage:
 *   npx tsx src/tools/hr-tool.ts init --group GROUP-001 --plan PLAN-A
 *   npx tsx src/tools/hr-tool.ts import --group GROUP-001 --csv roster.csv --valid-until 2026-12-31
 *   npx tsx src/tools/hr-tool.ts lookup --group GROUP-001 --employee EMP-001
 *   npx tsx src/tools/hr-tool.ts reconcile --group GROUP-001
 *   npx tsx src/tools/hr-tool.ts export --group GROUP-001
 *   npx tsx src/tools/hr-tool.ts status --group GROUP-001
 *
 * Environment:
 *   HR_TOOL_DATA_DIR    — Data directory (default: ./hr-tool-data)
 *   HR_TOOL_PASSPHRASE  — Encryption passphrase (prompted if not set)
 *   EMPLOYER_NODE_URL   — Employer node URL (default: http://localhost:4005)
 *   EMPLOYER_ADMIN_TOKEN — Admin token for employer node API (if using Bearer auth)
 *
 * Security:
 *   - All local files (groupSeed, correlation table, token export) are AES-256-GCM encrypted
 *   - GroupSeed is 32 random bytes — ensures cross-group hash unlinkability
 *   - Token secrets are NEVER emailed — output to encrypted file only
 *   - Reconciliation uses hash-set comparison (not count-only)
 *   - PII strings are overwritten after hashing where feasible
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';
import {
  generateGroupSeed,
  saveGroupSeed,
  loadGroupSeed,
  parseCsv,
  hashEmployeeRecords,
  saveCorrelationTable,
  loadCorrelationTable,
  reconcile,
  encryptWithPassphrase,
  decryptWithPassphrase,
  ensureDataDir,
  groupPaths,
  hashWithSeed,
} from './hr-tool-core.js';
import type {
  CorrelationTable,
  CorrelationEntry,
  TokenDistributionRecord,
  ReconciliationResult,
} from './hr-tool-core.js';

// ─── Helpers ────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`[hr-tool] ERROR: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`[hr-tool] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[hr-tool] WARN: ${msg}`);
}

/** Prompt for passphrase from stdin (no echo) */
async function promptPassphrase(prompt: string = 'Passphrase: '): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(prompt);
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Get passphrase from env or prompt */
async function getPassphrase(): Promise<string> {
  const fromEnv = process.env.HR_TOOL_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const pass = await promptPassphrase('Enter encryption passphrase: ');
  if (!pass) die('Passphrase is required');
  return pass;
}

/** Parse CLI args into a simple key-value map */
function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[0] || '';
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = val;
    }
  }
  return { command, flags };
}

/** HTTP helper — call employer node REST API */
async function callEmployerNode(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const baseUrl = process.env.EMPLOYER_NODE_URL || 'http://localhost:4005';
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const adminToken = process.env.EMPLOYER_ADMIN_TOKEN;
  if (adminToken) {
    headers['Authorization'] = `Bearer ${adminToken}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await resp.json();
  return { status: resp.status, data: json };
}

// ─── Commands ───────────────────────────────────────────────

/** init — Create a new group with a random groupSeed */
async function cmdInit(flags: Record<string, string>): Promise<void> {
  const groupId = flags['group'];
  const planId = flags['plan'];
  if (!groupId || !planId) die('Usage: init --group GROUP_ID --plan PLAN_ID');

  const dataDir = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
  ensureDataDir(dataDir);
  const paths = groupPaths(dataDir, groupId);

  if (existsSync(paths.seedFile)) {
    die(`Group ${groupId} already initialized. Seed file exists: ${paths.seedFile}`);
  }

  mkdirSync(paths.groupDir, { recursive: true });

  const passphrase = await getPassphrase();
  const seed = generateGroupSeed();

  saveGroupSeed(paths.seedFile, seed, passphrase);

  // Initialize empty correlation table
  const table: CorrelationTable = {
    groupId,
    planId,
    createdAt: new Date().toISOString(),
    entries: [],
  };
  saveCorrelationTable(paths.tableFile, table, passphrase);

  info(`Group ${groupId} initialized`);
  info(`  Plan: ${planId}`);
  info(`  Seed: ${paths.seedFile} (encrypted)`);
  info(`  Table: ${paths.tableFile} (encrypted)`);
  info('');
  info('IMPORTANT: Back up the passphrase securely. If lost, the correlation');
  info('table and groupSeed CANNOT be recovered. Employee identity mapping');
  info('will be permanently lost.');
}

/** import — Read CSV roster, hash PII, generate tokens via employer node */
async function cmdImport(flags: Record<string, string>): Promise<void> {
  const groupId = flags['group'];
  const csvPath = flags['csv'];
  const validUntil = flags['valid-until'];
  const dryRun = flags['dry-run'] === 'true';

  if (!groupId || !csvPath || !validUntil) {
    die('Usage: import --group GROUP_ID --csv ROSTER.csv --valid-until YYYY-MM-DD [--dry-run]');
  }

  if (!existsSync(csvPath)) die(`CSV file not found: ${csvPath}`);

  const dataDir = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
  const paths = groupPaths(dataDir, groupId);
  if (!existsSync(paths.seedFile)) die(`Group ${groupId} not initialized. Run 'init' first.`);

  const passphrase = await getPassphrase();
  const seed = loadGroupSeed(paths.seedFile, passphrase);
  const table = loadCorrelationTable(paths.tableFile, passphrase);

  // Parse CSV
  const csvContent = readFileSync(resolve(csvPath), 'utf8');
  const records = parseCsv(csvContent);
  info(`Parsed ${records.length} employee records from CSV`);

  // Check for duplicates against existing table
  const existingHashes = new Set(table.entries.map(e => e.employeeIdHash));
  const { entries: newEntries } = hashEmployeeRecords(records, seed, groupId, table.planId);

  const toProcess: CorrelationEntry[] = [];
  let skipped = 0;
  for (const entry of newEntries) {
    if (existingHashes.has(entry.employeeIdHash)) {
      warn(`Skipping duplicate: ${entry.employeeId} (hash already in table)`);
      skipped++;
    } else {
      toProcess.push(entry);
    }
  }

  info(`${toProcess.length} new entries to process (${skipped} duplicates skipped)`);

  if (dryRun) {
    info('DRY RUN — no tokens generated, no API calls made');
    for (const entry of toProcess) {
      info(`  ${entry.employeeId} → ${entry.employeeIdHash.slice(0, 16)}...`);
    }
    return;
  }

  // Generate tokens via employer node API
  const tokenRecords: TokenDistributionRecord[] = [];
  let success = 0;
  let failed = 0;

  for (const entry of toProcess) {
    try {
      const resp = await callEmployerNode('POST', '/tokens/generate', {
        groupId,
        employeeIdHash: entry.employeeIdHash,
        familyIdHash: entry.familyIdHash,
        validUntil,
      });

      if (resp.status === 201 && resp.data.ok) {
        entry.tokenId = resp.data.data.tokenId;
        entry.tokenIdHash = resp.data.data.tokenIdHash;
        entry.status = 'token_generated';

        tokenRecords.push({
          employeeIdHash: entry.employeeIdHash,
          tokenId: resp.data.data.tokenId,
          tokenIdHash: resp.data.data.tokenIdHash,
          validUntil,
          displayName: `${entry.firstName} ${entry.lastName.charAt(0)}.`,
        });

        success++;
      } else {
        warn(`Token generation failed for ${entry.employeeId}: ${resp.data.error || 'Unknown error'}`);
        failed++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`API error for ${entry.employeeId}: ${msg}`);
      failed++;
    }

    // Add to table regardless (pending if failed)
    table.entries.push(entry);
  }

  // Save updated correlation table
  saveCorrelationTable(paths.tableFile, table, passphrase);

  // Save token distribution file (encrypted)
  if (tokenRecords.length > 0) {
    const distJson = JSON.stringify(tokenRecords, null, 2);
    const encrypted = encryptWithPassphrase(distJson, passphrase);
    writeFileSync(paths.tokensFile, encrypted);
    info(`Token distribution file: ${paths.tokensFile} (encrypted)`);
  }

  info('');
  info(`Import complete: ${success} tokens generated, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    info('Re-run import with the same CSV to retry failed entries (duplicates auto-skipped)');
  }
  info('');
  info('NEXT STEPS:');
  info('  1. Use "export" command to create token distribution file');
  info('  2. Distribute tokens to employees via secure channel (portal, sealed envelope)');
  info('  3. NEVER email token IDs — use the export file for distribution');
}

/** lookup — Find an employee by ID or hash */
async function cmdLookup(flags: Record<string, string>): Promise<void> {
  const groupId = flags['group'];
  const employeeId = flags['employee'];
  const hash = flags['hash'];

  if (!groupId || (!employeeId && !hash)) {
    die('Usage: lookup --group GROUP_ID --employee EMP_ID | --hash HASH_VALUE');
  }

  const dataDir = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
  const paths = groupPaths(dataDir, groupId);
  if (!existsSync(paths.tableFile)) die(`Group ${groupId} not found`);

  const passphrase = await getPassphrase();
  const table = loadCorrelationTable(paths.tableFile, passphrase);

  let found: CorrelationEntry | undefined;

  if (hash) {
    found = table.entries.find(e => e.employeeIdHash === hash);
  } else if (employeeId) {
    // Hash the employeeId with groupSeed to find the entry
    const seed = loadGroupSeed(paths.seedFile, passphrase);
    const computedHash = hashWithSeed(employeeId, seed);
    found = table.entries.find(e => e.employeeIdHash === computedHash);
  }

  if (!found) {
    die('Employee not found in correlation table');
  }

  console.log(JSON.stringify({
    employeeId: found.employeeId,
    familyId: found.familyId,
    name: `${found.firstName} ${found.lastName}`,
    dob: found.dob,
    email: found.email ?? null,
    employeeIdHash: found.employeeIdHash,
    familyIdHash: found.familyIdHash,
    tokenId: found.tokenId ?? null,
    tokenIdHash: found.tokenIdHash ?? null,
    status: found.status,
    createdAt: found.createdAt,
  }, null, 2));
}

/** reconcile — Hash-set comparison between local table and node roster */
async function cmdReconcile(flags: Record<string, string>): Promise<void> {
  const groupId = flags['group'];
  if (!groupId) die('Usage: reconcile --group GROUP_ID');

  const dataDir = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
  const paths = groupPaths(dataDir, groupId);
  if (!existsSync(paths.tableFile)) die(`Group ${groupId} not found`);

  const passphrase = await getPassphrase();
  const table = loadCorrelationTable(paths.tableFile, passphrase);

  // Fetch roster from employer node
  info('Fetching roster from employer node...');
  const resp = await callEmployerNode('GET', '/roster');
  if (resp.status !== 200) {
    die(`Failed to fetch roster: ${resp.data.error || `HTTP ${resp.status}`}`);
  }

  const nodeRoster: Array<{ employeeIdHash: string; status: string }> = resp.data.data.entries || [];
  const result = reconcile(table.entries, nodeRoster);

  info('');
  info('=== RECONCILIATION REPORT ===');
  info(`Local table: ${result.totalLocal} entries`);
  info(`Node roster: ${result.totalNode} entries`);
  info(`Matched:     ${result.matched}`);
  info('');

  if (result.missingFromNode.length > 0) {
    warn(`${result.missingFromNode.length} entries in local table but NOT on node:`);
    for (const hash of result.missingFromNode) {
      const entry = table.entries.find(e => e.employeeIdHash === hash);
      info(`  ${entry?.employeeId ?? 'unknown'} → ${hash.slice(0, 16)}...`);
    }
    info('');
  }

  if (result.unknownOnNode.length > 0) {
    warn(`${result.unknownOnNode.length} entries on node but NOT in local table:`);
    for (const hash of result.unknownOnNode) {
      info(`  UNKNOWN → ${hash.slice(0, 16)}... (possible unauthorized enrollment)`);
    }
    info('');
  }

  if (result.statusMismatches.length > 0) {
    warn(`${result.statusMismatches.length} status mismatches:`);
    for (const m of result.statusMismatches) {
      const entry = table.entries.find(e => e.employeeIdHash === m.employeeIdHash);
      info(`  ${entry?.employeeId ?? m.employeeIdHash.slice(0, 16)}: local=${m.localStatus} node=${m.nodeStatus}`);
    }
    info('');
  }

  if (result.missingFromNode.length === 0 && result.unknownOnNode.length === 0 && result.statusMismatches.length === 0) {
    info('All entries match. No discrepancies found.');
  }

  // Update local table with enrollment status from node
  let synced = 0;
  for (const nodeEntry of nodeRoster) {
    const local = table.entries.find(e => e.employeeIdHash === nodeEntry.employeeIdHash);
    if (local && nodeEntry.status === 'enrolled' && local.status !== 'enrolled') {
      local.status = 'enrolled';
      synced++;
    }
  }

  if (synced > 0) {
    saveCorrelationTable(paths.tableFile, table, passphrase);
    info(`Synced ${synced} enrollment statuses from node to local table`);
  }
}

/** export — Export token distribution file */
async function cmdExport(flags: Record<string, string>): Promise<void> {
  const groupId = flags['group'];
  const output = flags['output'];
  if (!groupId) die('Usage: export --group GROUP_ID [--output FILE]');

  const dataDir = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
  const paths = groupPaths(dataDir, groupId);
  if (!existsSync(paths.tokensFile)) die(`No token distribution file for group ${groupId}. Run 'import' first.`);

  const passphrase = await getPassphrase();
  const data = readFileSync(paths.tokensFile);
  const json = decryptWithPassphrase(data, passphrase);
  const tokens: TokenDistributionRecord[] = JSON.parse(json);

  info(`${tokens.length} tokens for distribution`);
  info('');

  if (output) {
    // Write plaintext token list to specified file
    // WARNING: This file contains token IDs — handle with care
    const lines = tokens.map(t =>
      `${t.displayName}\t${t.tokenId}\t${t.validUntil}`
    );
    const header = 'Name\tTokenID\tValidUntil';
    writeFileSync(output, [header, ...lines].join('\n') + '\n');
    info(`Token list written to: ${output}`);
    warn('This file contains token IDs. Handle securely. Do NOT email.');
  } else {
    // Print to stdout
    console.log('');
    console.log('Name\t\t\tTokenID\t\t\t\t\tValidUntil');
    console.log('─'.repeat(80));
    for (const t of tokens) {
      console.log(`${t.displayName.padEnd(20)}\t${t.tokenId}\t${t.validUntil}`);
    }
    console.log('');
    warn('Token IDs shown above. Do NOT copy/paste into email. Use secure distribution channel.');
  }
}

/** status — Show group status summary */
async function cmdStatus(flags: Record<string, string>): Promise<void> {
  const groupId = flags['group'];
  if (!groupId) die('Usage: status --group GROUP_ID');

  const dataDir = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
  const paths = groupPaths(dataDir, groupId);
  if (!existsSync(paths.tableFile)) die(`Group ${groupId} not found`);

  const passphrase = await getPassphrase();
  const table = loadCorrelationTable(paths.tableFile, passphrase);

  const pending = table.entries.filter(e => e.status === 'pending').length;
  const tokenGenerated = table.entries.filter(e => e.status === 'token_generated').length;
  const enrolled = table.entries.filter(e => e.status === 'enrolled').length;
  const terminated = table.entries.filter(e => e.status === 'terminated').length;

  info(`Group: ${table.groupId}`);
  info(`Plan:  ${table.planId}`);
  info(`Created: ${table.createdAt}`);
  info('');
  info(`Total entries:    ${table.entries.length}`);
  info(`  Pending:        ${pending}`);
  info(`  Token issued:   ${tokenGenerated}`);
  info(`  Enrolled:       ${enrolled}`);
  info(`  Terminated:     ${terminated}`);

  // Check employer node connectivity
  try {
    const resp = await callEmployerNode('GET', '/health');
    if (resp.status === 200) {
      info('');
      info(`Employer node: ONLINE (${process.env.EMPLOYER_NODE_URL || 'http://localhost:4005'})`);
    }
  } catch {
    info('');
    warn(`Employer node: OFFLINE (${process.env.EMPLOYER_NODE_URL || 'http://localhost:4005'})`);
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
zkpCare HR Tool — PII-safe enrollment token management

Usage: npx tsx src/tools/hr-tool.ts <command> [options]

Commands:
  init        Initialize a new employer group
              --group GROUP_ID --plan PLAN_ID

  import      Import CSV roster and generate enrollment tokens
              --group GROUP_ID --csv FILE --valid-until YYYY-MM-DD [--dry-run]

  lookup      Look up employee by ID or hash
              --group GROUP_ID --employee EMP_ID | --hash HASH

  reconcile   Compare local table with employer node roster
              --group GROUP_ID

  export      Export token distribution file
              --group GROUP_ID [--output FILE]

  status      Show group status summary
              --group GROUP_ID

Environment:
  HR_TOOL_DATA_DIR      Data directory (default: ./hr-tool-data)
  HR_TOOL_PASSPHRASE    Encryption passphrase (prompted if not set)
  EMPLOYER_NODE_URL     Employer node URL (default: http://localhost:4005)
  EMPLOYER_ADMIN_TOKEN  Admin token for employer node API

Security:
  - All local files are AES-256-GCM encrypted with your passphrase
  - GroupSeed ensures cross-group hash unlinkability
  - Token IDs are NEVER emailed — use secure distribution only
  - Reconciliation uses hash-set comparison (not count-only)
`);
    process.exit(0);
  }

  const { command, flags } = parseArgs(args);

  switch (command) {
    case 'init':
      await cmdInit(flags);
      break;
    case 'import':
      await cmdImport(flags);
      break;
    case 'lookup':
      await cmdLookup(flags);
      break;
    case 'reconcile':
      await cmdReconcile(flags);
      break;
    case 'export':
      await cmdExport(flags);
      break;
    case 'status':
      await cmdStatus(flags);
      break;
    default:
      die(`Unknown command: ${command}. Run without arguments for usage.`);
  }
}

main().catch((err) => {
  console.error('[hr-tool] Fatal error:', err.message || err);
  process.exit(1);
});
