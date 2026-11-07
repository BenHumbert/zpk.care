/**
 * The key ceremony's two programs, end to end — owner, 2026-11-04.
 *
 * Three holders make their keys with scripts/keys/holder.ts, the ceremony program (scripts/keys/ceremony.ts) splits a
 * master for the plan's node 2 of 3 and writes the unsigned record and one share per holder, two holders sign, and the
 * record verifies. Nothing the programs write or print holds a private key or a share in the clear, and a holder is
 * never signed for without seeing the record hash: without --yes and without a terminal, sign-record signs nothing.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyCeremonyRecord, openHolderShare } from '../src/keys/ceremony.js';
import type { CeremonyRecord, ShareFile } from '../src/keys/ceremony.js';
import { unlockHolderKey } from '../src/keys/holder-key.js';
import type { HolderKeyFile } from '../src/keys/holder-key.js';
import { NodeKeyring } from '../src/keys/node-keyring.js';
import { testOnlyMachineSeal } from '../src/keys/machine-seal.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { buildKeyRoutes, attachNodeKeyring } from '../src/nodes/routes/key-routes.js';

const REPO = path.resolve(__dirname, '..');
const PASS = 'a holder passphrase for tests';
let dir: string;

function runAsync(
  script: 'holder' | 'ceremony',
  args: string[],
  passphrase: string | null = PASS,
): Promise<{ code: number | null; out: string }> {
  const env = { ...process.env };
  if (passphrase) env.ZPK_HOLDER_PASSPHRASE = passphrase;
  else delete env.ZPK_HOLDER_PASSPHRASE;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'scripts', 'keys', `${script}.ts`), ...args], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function run(script: 'holder' | 'ceremony', args: string[], passphrase: string | null = PASS) {
  const env = { ...process.env };
  if (passphrase) env.ZPK_HOLDER_PASSPHRASE = passphrase;
  else delete env.ZPK_HOLDER_PASSPHRASE;
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'scripts', 'keys', `${script}.ts`), ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-cli-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('three holders, a 2-of-3 ceremony, two signatures, a valid record', () => {
  const printed: string[] = [];
  for (const i of [1, 2, 3]) {
    // one holder per team: with 2 of 3 needed, two from one team could rebuild the key alone, which the ceremony refuses
    const group = ['operations', 'compliance', 'leadership'][i - 1];
    const r = run('holder', ['keygen', '--label', `holder-${i}`, '--group', group, '--out', path.join(dir, `h${i}.key.json`)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Fingerprint: [0-9A-F]{4}(-[0-9A-F]{4}){3}/);
    printed.push(r.out);
  }
  // a second keygen onto the same file is refused, so a key is never overwritten
  expect(run('holder', ['keygen', '--label', 'holder-1', '--out', path.join(dir, 'h1.key.json')]).code).not.toBe(0);

  const hash = run('ceremony', ['hash']);
  expect(hash.code).toBe(0);
  expect(hash.out.trim()).toMatch(/^[0-9a-f]{64}$/);

  const cards = [1, 2, 3].map((i) => path.join(dir, `h${i}.key.json.card.json`)).join(',');
  const out = path.join(dir, 'ceremony');
  const ran = run('ceremony', ['run', '--holders', cards, '--threshold', '2', '--out', out]);
  expect(ran.code).toBe(0);
  printed.push(ran.out);
  expect(ran.out).toContain('(unsigned)');
  const shares = fs.readdirSync(path.join(out, 'shares')).sort();
  expect(shares).toEqual(['holder-1.insurer.share.json', 'holder-2.insurer.share.json', 'holder-3.insurer.share.json']);

  const recordFile = path.join(out, 'record.json');
  // without --yes and without a terminal to confirm on, nothing is signed
  const unconfirmed = run('holder', ['sign-record', '--key', path.join(dir, 'h1.key.json'), '--record', recordFile]);
  expect(unconfirmed.code).not.toBe(0);
  expect(JSON.parse(fs.readFileSync(recordFile, 'utf8')).signatures).toEqual([]);
  // a wrong passphrase signs nothing either
  expect(
    run('holder', ['sign-record', '--key', path.join(dir, 'h1.key.json'), '--record', recordFile, '--yes'], 'not the passphrase at all')
      .code,
  ).not.toBe(0);

  expect(run('ceremony', ['verify', '--record', recordFile]).code).not.toBe(0);
  for (const i of [1, 3]) {
    const signed = run('holder', ['sign-record', '--key', path.join(dir, `h${i}.key.json`), '--record', recordFile, '--yes']);
    expect(signed.code).toBe(0);
    printed.push(signed.out);
  }
  const verified = run('ceremony', ['verify', '--record', recordFile]);
  expect(verified.code).toBe(0);
  expect(verified.out).toMatch(/signed by 2 of 3 \(needs 2\)/);

  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as CeremonyRecord;
  expect(verifyCeremonyRecord(record).signedBy).toHaveLength(2);

  // each holder opens their own share; nothing written or printed carries a share or a private key in the clear
  const secrets: string[] = [];
  for (const i of [1, 2, 3]) {
    const holder = unlockHolderKey(JSON.parse(fs.readFileSync(path.join(dir, `h${i}.key.json`), 'utf8')) as HolderKeyFile, PASS);
    const share = JSON.parse(fs.readFileSync(path.join(out, 'shares', `holder-${i}.insurer.share.json`), 'utf8')) as ShareFile;
    secrets.push(openHolderShare(share, holder).value.toString('hex'));
  }
  const everything = [
    ...printed,
    ...fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
    fs.readFileSync(recordFile, 'utf8'),
    ...shares.map((f) => fs.readFileSync(path.join(out, 'shares', f), 'utf8')),
  ].join('\n');
  for (const secret of secrets) expect(everything).not.toContain(secret);
});

test('two holders provision a node with the release program, and a wrong fingerprint releases nothing', async () => {
  // the record and shares the first test made; the node's server runs in this process, its holders' programs outside it
  const out = path.join(dir, 'ceremony');
  const record = JSON.parse(fs.readFileSync(path.join(out, 'record.json'), 'utf8')) as CeremonyRecord;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-cli-node-'));
  const server = new NautilusAppServer({
    role: 'insurer',
    port: 0,
    host: '127.0.0.1',
    sequencerUrl: 'http://127.0.0.1:9',
    stateDir,
    enableSSE: false,
    maxSseConnections: 0,
    allowedOrigins: [],
    adminToken: 'insurer-token',
  } as unknown as NautilusAppConfig);
  server.registerRoutes(buildKeyRoutes(server));
  const keyring = new NodeKeyring({ record, nodeId: 'insurer', stateDir, seal: testOnlyMachineSeal(), log: () => {} });
  attachNodeKeyring(server, keyring);
  await keyring.start();
  await server.start();
  const node = `http://127.0.0.1:${server.getPort()}`;
  try {
    const fingerprint = keyring.status().bootFingerprint!;
    const release = (i: number, fp: string) =>
      runAsync('holder', [
        'release',
        '--key',
        path.join(dir, `h${i}.key.json`),
        '--share',
        path.join(out, 'shares', `holder-${i}.insurer.share.json`),
        '--node',
        node,
        '--boot-fingerprint',
        fp,
      ]);
    const wrong = await release(2, '0000-0000-0000-0000');
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toMatch(/nothing was released/);
    expect(keyring.status().received).toBe(0);

    const first = await release(2, fingerprint);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Released: 1 of 2/);
    const second = await release(3, fingerprint.toLowerCase());
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/is unlocked/);
    expect(keyring.isUnlocked()).toBe(true);
    expect(server.getConfig().insurerSigningSeed).toBeDefined();
  } finally {
    await server.stop();
    keyring.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
