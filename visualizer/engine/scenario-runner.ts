/**
 * Scenario Runner — Standalone scenario client.
 *
 * Connects to an already-running sequencer (start-sequencer.ts)
 * and runs the dynamic simulation against it.
 *
 * Usage:
 *   npx tsx engine/scenario-runner.ts
 *   PORT=3030 MEMBERS=20 SCRIPTS=100 npx tsx engine/scenario-runner.ts
 */
import http from 'http';
import { runScenario } from './scenario.js';

const PORT = parseInt(process.env.PORT || '3030', 10);
const MEMBERS = parseInt(process.env.MEMBERS || '20', 10);
const SCRIPTS = parseInt(process.env.SCRIPTS || '100', 10);
const PA_MEMBERS = parseInt(process.env.PA_MEMBERS || '5', 10);
const PA_DRUGS = parseInt(process.env.PA_DRUGS || '3', 10);
const PACE = parseInt(process.env.PACE || '500', 10);
const MEMBER_INTERVAL = parseInt(process.env.MEMBER_INTERVAL || '60000', 10);

async function waitForSequencer(port: number, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Health check returned ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      if (i < maxRetries - 1) {
        process.stdout.write(`[Runner] Waiting for sequencer on port ${port}... (${i + 1}/${maxRetries})\r`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw new Error(`Sequencer not reachable on port ${port} after ${maxRetries}s`);
}

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║     Adjuda-GATOR — Scenario Runner       ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  // 1. Wait for the sequencer to be healthy
  console.log(`[Runner] Connecting to sequencer at http://127.0.0.1:${PORT}...`);
  await waitForSequencer(PORT);
  console.log(`[Runner] Sequencer is healthy.`);

  // 2. Clear any previous event buffer so browsers see fresh events
  await new Promise<void>((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/viz/clear', method: 'POST' },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', () => resolve());
    req.end();
  });
  console.log(`[Runner] Event buffer cleared — fresh start.\n`);

  // 3. Run the simulation
  await runScenario({
    port: PORT,
    memberCount: MEMBERS,
    totalScripts: SCRIPTS,
    paMembers: PA_MEMBERS,
    paDrugCount: PA_DRUGS,
    paceMs: PACE,
    memberIntervalMs: MEMBER_INTERVAL,
  });

  console.log('\n[Runner] Scenario complete.');
  console.log('[Runner] Open http://localhost:1234 for the visualizer.');
  console.log('[Runner] The sequencer keeps running — rerun this script for another simulation.\n');
}

main().catch((err) => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});
