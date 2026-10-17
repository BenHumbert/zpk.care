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
 * PHI containment check.
 *
 * Takes the personal details each test member typed on their device in an earlier run, computes
 * the hashes and keys the device derives from them, and searches everything outside the device
 * for all of it: the sequencer's disk and every API an unauthenticated caller can reach (RPC,
 * /interactive/state, the SSE stream, the viz endpoints, the node proxies), the network log, the
 * insurer's files, and every employer node and HR Tool the sequencer will name. The device's own
 * encrypted state is decrypted with its PIN and searched too, to show what it keeps.
 *
 * Every probe is unauthenticated on purpose: this measures what an outsider can collect.
 *
 * Checks the owner's rules:
 *   I1  raw PHI/PII never leaves the device (or the HR workstation) and is never written down
 *   I2  only the wallet ID and proofs leave the device — no per-field hashes, no hash(key)
 *   I3  the enrollment key itself never appears off the device
 *   I6  no store outside the device links a wallet ID to an employee identity
 *
 * Usage:
 *   npx tsx scripts/e2e-verify/check-phi-containment.ts <run-dir> <network-log> [--strict]
 *
 *   --strict          exit 1 if any rule is broken (for use as an acceptance test)
 *   E2E_SEQ           sequencer base URL (default http://localhost:3030)
 *   E2E_REPLICA       replica base URL to probe as well (default http://localhost:3031)
 *   E2E_MEMBER_PORTS  member node ports whose public endpoints to probe (default 4001,4011,4012,4013)
 *   E2E_SSE_MS        how long to sample the SSE stream, ms (default 6000)
 */
import fs from 'fs';
import path from 'path';
import { hashString, hashDate } from '../../src/zkp/hash-utils.js';
import { NautilusLocalState } from '../../src/nodes/nautilus-local-state.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const [runDir, networkLog] = args.filter(a => !a.startsWith('--'));
const SEQ = process.env.E2E_SEQ ?? 'http://localhost:3030';
const REPLICA = process.env.E2E_REPLICA ?? 'http://localhost:3031';
const MEMBER_PORTS = (process.env.E2E_MEMBER_PORTS ?? '4001,4011,4012,4013').split(',').map(s => s.trim()).filter(Boolean);
const SSE_MS = Number(process.env.E2E_SSE_MS ?? 6000);
const DEVICES = path.join(path.dirname(runDir), 'devices');
const PINS: Record<string, string> = { A1: '864209', A2: '531907', B1: '702318', B2: '416685' };

/** 'plaintext' and 'secret' breaks are the worst; 'hash' breaks I2; 'linkage' breaks I6. */
type Kind = 'plaintext' | 'hash' | 'secret';
type Needle = { member: string; field: string; kind: Kind; value: string };

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (fs.statSync(p).size < 200 * 1024 * 1024) out.push(p);
  }
  return out;
}
const count = (hay: string, v: string) => {
  // Match whole tokens only, so a short value never matches inside a longer number or word.
  const re = new RegExp(`(?<![0-9A-Za-z])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`, 'g');
  return (hay.match(re) ?? []).length;
};

// ── Unauthenticated probes. Every one fails soft: a dead port must not stop the scan. ──

async function get(url: string): Promise<string> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return `[GET ${url} -> ${r.status}]\n` + (await r.text());
  } catch (e: any) {
    return `[GET ${url} -> unreachable: ${e?.message ?? e}]\n`;
  }
}

async function post(url: string, body: unknown): Promise<string> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return `[POST ${url} -> ${r.status}]
` + (await r.text());
  } catch (e: any) {
    return `[POST ${url} -> unreachable: ${e?.message ?? e}]
`;
  }
}

async function rpc(base: string, method: string, params: Record<string, unknown>): Promise<string> {
  try {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    return `[${method} @ ${base} -> ${r.status}]\n` + (await r.text());
  } catch (e: any) {
    return `[${method} @ ${base} -> unreachable: ${e?.message ?? e}]\n`;
  }
}

/** Read an SSE stream for a fixed window, then give up whatever arrived. */
async function sseSample(url: string, ms: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const chunks: string[] = [];
  try {
    const r = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
    const reader = r.body?.getReader();
    if (!reader) return '';
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value, { stream: true }));
    }
  } catch {
    /* aborted on purpose, or unreachable */
  } finally {
    clearTimeout(timer);
  }
  return `[SSE ${url} sampled ${ms}ms]\n` + chunks.join('');
}

/** The per-wallet readers that take a wallet ID and need no credentials. */
const WALLET_READERS: Array<[string, (w: string) => Record<string, unknown>]> = [
  ['l2_getClaimsByMember', w => ({ memberWalletId: w })],
  ['l2_getReceiptsByWallet', w => ({ walletId: w })],
  ['l2_getMessagesByWallet', w => ({ walletId: w })],
  ['l2_reconstructAccumulator', w => ({ walletId: w })],
  ['l2_getPcpAssignments', w => ({ memberWalletId: w })],
  ['l2_getEntity', w => ({ walletId: w })],
  ['l2_getEncryptionKey', w => ({ walletId: w })],
  ['l2_getWalletState', w => ({ walletId: w })],
  ['l2_getAttestation', w => ({ walletId: w })],
];

async function main() {
  if (!runDir) {
    console.error('usage: check-phi-containment.ts <run-dir> <network-log> [--strict]');
    process.exit(2);
  }

  // 1. What each member typed, from the run's own trace of /onboarding/derive-wallet.
  const needles: Needle[] = [];
  const devices: Record<string, { dir: string; walletId: string; employeeId: string }> = {};
  for (const key of ['A1', 'A2', 'B1', 'B2']) {
    const tracePath = path.join(runDir, `member-${key}`, 'trace.json');
    if (!fs.existsSync(tracePath)) { console.log(`!! ${key}: no trace at ${tracePath}, skipping`); continue; }
    const tr = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const ex = tr.steps.flatMap((s: any) => s.exchanges).find((x: any) => /derive-wallet/.test(x.url));
    if (!ex) { console.log(`!! ${key}: no derive-wallet exchange in trace, skipping`); continue; }
    const b = ex.body, walletId = (ex.response?.data ?? ex.response).walletId;
    const port = Number(new URL(ex.url).port);
    // The member's cardholder ID *is* their employer-issued employee ID in these runs.
    devices[key] = {
      dir: port === 4001 ? path.join(REPO, 'nautilus-data') : path.join(DEVICES, `member-${port}`),
      walletId,
      employeeId: b.cardholderId,
    };
    needles.push(
      { member: key, field: 'first name', kind: 'plaintext', value: b.firstName },
      { member: key, field: 'last name', kind: 'plaintext', value: b.lastName },
      { member: key, field: 'date of birth', kind: 'plaintext', value: b.dateOfBirth },
      { member: key, field: 'cardholder/employee ID', kind: 'plaintext', value: b.cardholderId },
      { member: key, field: 'first name', kind: 'hash', value: hashString(b.firstName).toString() },
      { member: key, field: 'last name', kind: 'hash', value: hashString(b.lastName).toString() },
      { member: key, field: 'date of birth', kind: 'hash', value: hashDate(b.dateOfBirth).toString() },
      { member: key, field: 'cardholder/employee ID', kind: 'hash', value: hashString(b.cardholderId).toString() },
    );
  }
  const keys = Object.keys(devices);
  if (!keys.length) { console.error('no member traces found in ' + runDir); process.exit(2); }

  // 2. The device's own state, decrypted with its PIN. Adds the enrollment key and its hash.
  const deviceText: Record<string, string> = {};
  for (const [key, d] of Object.entries(devices)) {
    const ls = new NautilusLocalState(d.dir);
    try {
      await ls.unlock(PINS[key]);
      const st = await ls.load();
      if (st?.walletId !== d.walletId) console.log(`!! ${key}: device holds ${st?.walletId?.slice(0, 12)}…, run used ${d.walletId.slice(0, 12)}…`);
      const ekHash = st?.preimageFields?.[4];
      if (ekHash) needles.push({ member: key, field: 'enrollment key', kind: 'hash', value: ekHash });
      const rawKey = ls.hasEnrollmentKey() ? ls.useEnrollmentKey(k => k) : '';
      if (rawKey) needles.push({ member: key, field: 'enrollment key', kind: 'secret', value: rawKey });
      deviceText[key] = JSON.stringify(st) + (rawKey ? ' ' + rawKey : '');
    } catch (e: any) {
      console.log(`!! ${key}: could not open device state at ${d.dir}: ${e?.message ?? e}`);
      deviceText[key] = '';
    }
  }

  // 3. Discover the employer tenants the way an unauthenticated caller can.
  let tenants: Array<{ employerId: string; employerNodeUrl: string; hrToolUrl: string }> = [];
  try {
    const listed = JSON.parse((await rpc(SEQ, 'l2_listEmployerNodes', {})).split('\n').slice(1).join('\n'));
    tenants = (listed?.result ?? []).filter((t: any) => t?.employerNodeUrl);
  } catch { /* leave empty */ }

  // 4. Everything outside the device, grouped by what an attacker would have to reach.
  const places: Array<{ name: string; text: () => Promise<string> }> = [];
  const filesIn = (name: string, dir: string) => places.push({
    name,
    text: async () => walk(dir).filter(f => !f.endsWith('.enc') && !f.endsWith('.pdf')).map(f => fs.readFileSync(f, 'utf8')).join('\n'),
  });

  filesIn('Sequencer disk (l2-data: engine state, checkpoints)', path.join(REPO, 'l2-data'));
  places.push({ name: 'Sequencer live API (GET /interactive/state)', text: async () => get(`${SEQ}/interactive/state`) });
  places.push({
    name: 'Sequencer viz API (/viz/state, /viz/entities, /viz/history)',
    text: async () => (await Promise.all([`${SEQ}/viz/state`, `${SEQ}/viz/entities`, `${SEQ}/viz/history`].map(get))).join('\n'),
  });
  places.push({ name: `Sequencer SSE stream (GET /events, ${SSE_MS}ms sample)`, text: async () => sseSample(`${SEQ}/events`, SSE_MS) });
  places.push({
    name: 'Sequencer per-wallet RPCs, no credentials (claims, receipts, messages, accumulator, PCP, entity, key, state, attestation)',
    text: async () => (await Promise.all(
      Object.values(devices).flatMap(d => WALLET_READERS.map(([m, mk]) => rpc(SEQ, m, mk(d.walletId)))),
    )).join('\n'),
  });
  places.push({
    name: 'Replica, no credentials (same per-wallet RPCs)',
    text: async () => (await Promise.all(
      Object.values(devices).flatMap(d => WALLET_READERS.map(([m, mk]) => rpc(REPLICA, m, mk(d.walletId)))),
    )).join('\n'),
  });
  places.push({
    name: 'Member node public endpoints (/health, /onboarding/status)',
    text: async () => (await Promise.all(MEMBER_PORTS.flatMap(p => [get(`http://localhost:${p}/health`), get(`http://localhost:${p}/onboarding/status`)]))).join('\n'),
  });
  /*
   * The routes A3 deleted. Probed on purpose, and on every node type, because this scan is the
   * one that looks for the raw enrollment key off the device: if a key-export route is ever put
   * back, the response body lands in this scan and the `secret` needle catches it. A 404 here is
   * the expected result and contributes nothing; a 200 with a blob is the whole point.
   */
  places.push({
    name: 'Key-custody routes removed by A3 (backup-key, restore-key, generate-key with a key)',
    text: async () => {
      const ports = [...MEMBER_PORTS, '4002', '4003'];
      const probes: Array<Promise<string>> = [];
      for (const port of ports) {
        const base = `http://localhost:${port}`;
        probes.push(post(`${base}/onboarding/backup-key`, { pin: '000000' }));
        probes.push(post(`${base}/onboarding/backup-key`, {}));
        probes.push(post(`${base}/onboarding/restore-key`, { backup: { version: 1 }, pin: '000000' }));
        // An injected key must not be stored; if it is, the derived wallet is the attacker's.
        probes.push(post(`${base}/onboarding/generate-key`, { enrollmentKey: 'Aa1!'.repeat(16) }));
      }
      return (await Promise.all(probes)).join('
');
    },
  });
  places.push({
    name: 'Member node /rpc proxy, no credentials (sequencer data through the phone)',
    text: async () => (await Promise.all(
      Object.values(devices).flatMap(d => WALLET_READERS.map(([m, mk]) => rpc(`http://localhost:${MEMBER_PORTS[0]}`, m, mk(d.walletId)))),
    )).join('\n'),
  });
  places.push({
    name: 'Explorer /rpc proxy, no credentials',
    text: async () => (await Promise.all(
      Object.values(devices).map(d => rpc('http://localhost:8000', 'l2_getClaimsByMember', { memberWalletId: d.walletId })),
    )).join('\n'),
  });
  places.push({
    name: 'Employer nodes, no credentials (/health, /roster, /groups, /tokens)',
    text: async () => (await Promise.all(
      tenants.flatMap(t => ['/health', '/roster', '/groups', '/tokens'].map(r => get(t.employerNodeUrl + r))),
    )).join('\n'),
  });
  places.push({
    name: 'HR Tools, no credentials (/api/status, /api/employees, /api/export/tokens)',
    text: async () => (await Promise.all(
      tenants.filter(t => t.hrToolUrl).flatMap(t => ['/api/status', '/api/employees', '/api/export/tokens'].map(r => get(t.hrToolUrl + r))),
    )).join('\n'),
  });
  if (networkLog) places.push({ name: 'Sequencer + node log (stdout of the network run)', text: async () => fs.readFileSync(networkLog, 'utf8') });
  filesIn('Insurer disk (marketplace + documents)', path.join(REPO, 'nautilus-data'));
  filesIn('Employer HR Tool disk (unencrypted files)', path.join(REPO, 'hr-tool-data'));

  // 5. Scan. Keep each place's text for the linkage pass.
  type Row = { place: string; member: string; field: string; kind: Kind; hits: number };
  const rows: Row[] = [];
  const linkage: Array<{ place: string; member: string; wallet: number; employee: number }> = [];
  for (const pl of places) {
    let text = '';
    try { text = await pl.text(); } catch (e: any) { console.log(`!! could not read ${pl.name}: ${e.message}`); }
    for (const n of needles) rows.push({ place: pl.name, member: n.member, field: n.field, kind: n.kind, hits: count(text, n.value) });
    for (const [key, d] of Object.entries(devices)) {
      linkage.push({ place: pl.name, member: key, wallet: count(text, d.walletId), employee: count(text, d.employeeId) });
    }
  }
  for (const [key, text] of Object.entries(deviceText)) {
    for (const n of needles.filter(x => x.member === key)) {
      rows.push({ place: `Member ${key}'s own device (decrypted state)`, member: key, field: n.field, kind: n.kind, hits: count(text, n.value) });
    }
  }

  // 6. Report: per place, which fields of which members turn up.
  const byPlace = new Map<string, Row[]>();
  for (const r of rows) byPlace.set(r.place, [...(byPlace.get(r.place) ?? []), r]);
  for (const [place, rs] of byPlace) {
    console.log(`\n${place}`);
    for (const kind of ['plaintext', 'hash', 'secret'] as Kind[]) {
      const of = rs.filter(r => r.kind === kind);
      if (!of.length) continue;
      const found = of.filter(r => r.hits > 0);
      const fields = [...new Set(of.map(r => r.field))];
      const line = fields.map(f => {
        const ms = found.filter(r => r.field === f);
        return `${f}: ${ms.length ? ms.map(r => `${r.member}×${r.hits}`).join(' ') : '—'}`;
      }).join(' | ');
      console.log(`  ${kind.padEnd(9)} ${line}`);
    }
  }

  // 7. I6: a store that holds a wallet ID *and* the matching employee ID links the two.
  console.log('\n\nWallet-to-employee linkage (I6 — only the member may connect these)');
  const breaks = linkage.filter(l => l.wallet > 0 && l.employee > 0);
  if (!breaks.length) console.log('  none: no store outside the device holds both a wallet ID and its employee ID');
  for (const [place, ls] of new Map(breaks.map(b => [b.place, breaks.filter(x => x.place === b.place)]))) {
    console.log(`  LINKED  ${place}: ${ls.map(l => `${l.member} (wallet×${l.wallet}, employee×${l.employee})`).join(', ')}`);
  }

  // 8. Verdict per rule.
  const off = (kind: Kind) => rows.filter(r => r.kind === kind && r.hits > 0 && !r.place.startsWith('Member '));
  const verdicts: Array<[string, string, boolean, string]> = [
    ['I1', 'raw PHI/PII never leaves the device', off('plaintext').length === 0,
      [...new Set(off('plaintext').map(r => `${r.field} @ ${r.place}`))].join('; ')],
    ['I2', 'no per-field hashes leave the device', off('hash').length === 0,
      [...new Set(off('hash').map(r => `${r.field} @ ${r.place}`))].join('; ')],
    ['I3', 'the enrollment key never leaves the device', off('secret').length === 0,
      [...new Set(off('secret').map(r => `${r.field} @ ${r.place}`))].join('; ')],
    ['I6', 'nothing outside the device links wallet to employee', breaks.length === 0,
      [...new Set(breaks.map(b => b.place))].join('; ')],
  ];
  console.log('\n\nVerdict');
  for (const [id, rule, ok, detail] of verdicts) {
    console.log(`  ${ok ? 'HOLDS ' : 'BROKEN'}  ${id}  ${rule}`);
    if (!ok && detail) console.log(`          ${detail}`);
  }

  const broken = verdicts.filter(v => !v[2]).length;
  console.log(`\n${verdicts.length - broken}/${verdicts.length} rules hold.`);
  if (broken && STRICT) process.exit(1);
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
