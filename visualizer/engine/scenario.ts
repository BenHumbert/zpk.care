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
 * Dynamic Simulation Engine — Generates realistic claim traffic at runtime.
 *
 * Members are onboarded one at a time on a configurable cadence (default 60s).
 * Each member goes through the full lifecycle before the next one starts:
 *   token → enrollment → eligibility → PA (if needed) → prescriptions → fulfillment
 *
 * This produces a steady, lifelike stream of events rather than a burst.
 */
import http from 'http';
import {
  PRESCRIBERS,
  PHARMACIES,
  TIER1_GENERICS,
  TIER2_PREFERRED,
  TIER3_NON_PREFERRED,
  TIER4_SPECIALTY,
} from '../../src/data/index.js';
import type { SeedPrescriber } from '../../src/data/index.js';
import type { SeedPharmacy } from '../../src/data/index.js';
import type { SeedMedication } from '../../src/data/index.js';
import type { VizEvent, VizActorType, VizLane } from '../../src/l2/l2-rpc-server.js';

// ─── Configuration ───────────────────────────────────

export interface ScenarioConfig {
  /** Number of members to enroll */
  memberCount: number;
  /** Employer name */
  employerName: string;
  /** Group ID for the employer */
  groupId: string;
  /** Plan ID */
  planId: string;
  /** Number of members who will need Prior Authorization */
  paMembers: number;
  /** Number of distinct drugs requiring PA (chosen from Tier 4) */
  paDrugCount: number;
  /** Total prescriptions to generate (distributed across members) */
  totalScripts: number;
  /** Base delay between events within a member lifecycle (ms) */
  paceMs: number;
  /** Delay between starting each member's lifecycle (ms). Default 60000 (1 minute). */
  memberIntervalMs: number;
  /** RPC server port */
  port: number;
}

export const DEFAULT_CONFIG: ScenarioConfig = {
  memberCount: 20,
  employerName: 'MegaCorp Industries',
  groupId: 'MEGA-CORP-001',
  planId: 'PLAN-PLATINUM-2026',
  paMembers: 5,
  paDrugCount: 3,
  totalScripts: 100,
  paceMs: 500,
  memberIntervalMs: 60_000,
  port: 3030,
};

// ─── Types ───────────────────────────────────────────

interface SimMember {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  cardholderId: string;
  needsPA: boolean;
  assignedPrescriber: SeedPrescriber;
  assignedPharmacy: SeedPharmacy;
  scripts: SimScript[];
  deductiblePaid: number;
  oopPaid: number;
}

interface SimScript {
  id: string;
  member: SimMember;
  prescriber: SeedPrescriber;
  pharmacy: SeedPharmacy;
  medication: SeedMedication;
  qty: number;
  needsPA: boolean;
  paApproved: boolean;
  status: 'pending' | 'active' | 'filled' | 'settled';
}

// ─── RNG Helpers ─────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Name Generator ─────────────────────────────────

const FIRST_NAMES = [
  'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda',
  'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Christopher', 'Karen', 'Charles', 'Lisa', 'Daniel', 'Nancy',
  'Matthew', 'Betty', 'Anthony', 'Margaret', 'Mark', 'Sandra',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
];

function generateName(index: number): { firstName: string; lastName: string } {
  const fi = (index * 7 + 3) % FIRST_NAMES.length;
  const li = (index * 13 + 5) % LAST_NAMES.length;
  return { firstName: FIRST_NAMES[fi], lastName: LAST_NAMES[li] };
}

// ─── Event Emission ──────────────────────────────────

let eventCounter = 0;
let baseUrl = 'http://127.0.0.1:3030';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function nextId(): string {
  eventCounter++;
  return `viz-${String(eventCounter).padStart(6, '0')}`;
}

function makeEvent(
  type: VizEvent['type'],
  actor: string,
  actorType: VizActorType,
  lane: VizLane,
  stage: number,
  totalStages: number,
  data: Record<string, unknown> = {},
  target?: string,
  targetType?: VizActorType,
): VizEvent {
  return {
    type, timestamp: Date.now(), id: nextId(),
    actor, actorType,
    target, targetType: targetType as string | undefined,
    data, lane, stage, totalStages,
  };
}

async function emit(event: VizEvent): Promise<void> {
  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const url = new URL('/viz/emit', baseUrl);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function prescriberDisplayName(p: SeedPrescriber): string {
  return `Dr. ${p.lastName}`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Per-Member Lifecycle ────────────────────────────

async function processMember(
  m: SimMember,
  cfg: ScenarioConfig,
  paDrugs: SeedMedication[],
  batchNumber: { value: number },
): Promise<void> {
  const pace = cfg.paceMs;

  // ── Token Generation ──
  await emit(makeEvent(
    'viz:token:generated', `${cfg.employerName} HR`, 'employer', 'enrollment', 0, 5,
    { tokenId: `TOKEN-${m.id}`, groupId: cfg.groupId, planId: cfg.planId, memberHint: m.displayName },
    m.displayName, 'member',
  ));
  await sleep(pace);

  // ── Enrollment ──
  await emit(makeEvent(
    'viz:token:consumed', m.displayName, 'member', 'enrollment', 1, 5,
    { tokenId: `TOKEN-${m.id}` },
  ));
  await sleep(pace / 2);

  await emit(makeEvent(
    'viz:enrollment:started', m.displayName, 'member', 'enrollment', 2, 5,
    { tokenId: `TOKEN-${m.id}`, step: 'Computing wallet ID on device' },
  ));
  await sleep(pace);

  await emit(makeEvent(
    'viz:enrollment:complete', 'Adjuda-GATOR PBM', 'insurer', 'enrollment', 3, 5,
    { walletRegistered: true, credentialMinted: true, credentialType: 'ELIGIBILITY', lifecycle: 'ELIGIBLE' },
    m.displayName, 'member',
  ));
  await sleep(pace / 2);

  await emit(makeEvent(
    'viz:enrollment:complete', m.displayName, 'member', 'enrollment', 4, 5,
    { lifecycle: 'ELIGIBLE', plan: cfg.planId },
  ));
  await sleep(pace);

  // ── Eligibility Check ──
  if (m.scripts.length > 0) {
    const firstMed = m.scripts[0].medication;

    await emit(makeEvent(
      'viz:eligibility:check', m.displayName, 'member', 'eligibility', 0, 4,
      { plan: cfg.planId },
    ));
    await sleep(pace / 2);

    await emit(makeEvent(
      'viz:eligibility:verified', 'Adjuda-GATOR PBM', 'insurer', 'eligibility', 1, 4,
      { eligible: true, coverageType: 'MEDICAL', deductible: '$500' },
      m.displayName, 'member',
    ));
    await sleep(pace / 2);

    await emit(makeEvent(
      'viz:formulary:check', m.displayName, 'member', 'eligibility', 2, 4,
      { medication: firstMed.brandName || firstMed.genericName, ndc: firstMed.ndcFormatted,
        tier: firstMed.formularyEntry.tierLevel },
    ));
    await sleep(pace / 2);

    await emit(makeEvent(
      'viz:formulary:verified', 'Adjuda-GATOR PBM', 'insurer', 'eligibility', 3, 4,
      { onFormulary: true, tier: firstMed.formularyEntry.tierLevel,
        copay: formatCents(firstMed.formularyEntry.copayAmount),
        requiresPA: firstMed.formularyEntry.requiresPriorAuth },
      m.displayName, 'member',
    ));
    await sleep(pace);
  }

  // ── Prior Authorization (if needed) ──
  const paScripts = m.scripts.filter(s => s.needsPA);
  for (const script of paScripts) {
    const pName = prescriberDisplayName(script.prescriber);
    const drug = script.medication.brandName || script.medication.genericName;

    await emit(makeEvent(
      'viz:message:sent', pName, 'prescriber', 'messaging', 0, 5,
      { messageType: 'MSG_TYPE_PA_REQUEST',
        content: `Prior Auth Request: ${drug} for ${m.displayName}`, encrypted: true },
      'Adjuda-GATOR PBM', 'insurer',
    ));
    await sleep(pace);

    await emit(makeEvent(
      'viz:message:received', 'Adjuda-GATOR PBM', 'insurer', 'messaging', 3, 5,
      { messageType: 'MSG_TYPE_PA_REQUEST', from: pName },
    ));
    await sleep(pace);

    const approved = Math.random() < 0.9;
    script.paApproved = approved;

    await emit(makeEvent(
      'viz:message:sent', 'Adjuda-GATOR PBM', 'insurer', 'messaging', 0, 5,
      { messageType: 'MSG_TYPE_PA_RESPONSE',
        content: approved
          ? `PA APPROVED: ${drug} — auth code ZKP-PA-${randInt(1000, 9999)}`
          : `PA DENIED: ${drug} — step therapy required`,
        approved },
      pName, 'prescriber',
    ));
    await sleep(pace / 2);

    await emit(makeEvent(
      'viz:message:received', pName, 'prescriber', 'messaging', 3, 5,
      { messageType: 'MSG_TYPE_PA_RESPONSE', approved, from: 'Adjuda-GATOR PBM' },
    ));
    await sleep(pace);
  }

  // ── Prescriptions + Messages ──
  const writableScripts = m.scripts.filter(s => !s.needsPA || s.paApproved);
  const shuffledScripts = shuffle(writableScripts);

  for (const script of shuffledScripts) {
    const pName = prescriberDisplayName(script.prescriber);
    const phName = script.pharmacy.storeName;
    const drug = script.medication.brandName || script.medication.genericName;
    const mName = m.displayName;

    await emit(makeEvent(
      'viz:prescription:written', pName, 'prescriber', 'prescription', 0, 4,
      { drug: `${drug} ${script.medication.strength}`, tier: script.medication.formularyEntry.tierLevel,
        ndc: script.medication.ndcFormatted, qty: script.qty, scriptId: script.id,
        ...(script.needsPA ? { priorAuth: 'APPROVED' } : {}) },
      mName, 'member',
    ));
    await sleep(pace / 2);

    // eScript message: prescriber → pharmacy
    await emit(makeEvent(
      'viz:message:sent', pName, 'prescriber', 'messaging', 0, 5,
      { messageType: 'MSG_TYPE_PRESCRIPTION',
        content: `eScript: ${drug} ${script.medication.strength} #${script.qty}`, encrypted: true },
      phName, 'pharmacy',
    ));
    await sleep(pace / 4);

    await emit(makeEvent(
      'viz:message:received', phName, 'pharmacy', 'messaging', 3, 5,
      { messageType: 'MSG_TYPE_PRESCRIPTION', from: pName },
    ));
    await sleep(pace / 4);

    await emit(makeEvent(
      'viz:prescription:sent', pName, 'prescriber', 'prescription', 1, 4,
      { destination: phName, scriptId: script.id }, phName, 'pharmacy',
    ));
    await sleep(pace / 4);

    await emit(makeEvent(
      'viz:prescription:received', phName, 'pharmacy', 'prescription', 2, 4,
      { from: pName, drug, scriptId: script.id },
    ));
    await sleep(pace / 4);

    await emit(makeEvent(
      'viz:prescription:status', phName, 'pharmacy', 'prescription', 3, 4,
      { status: 'ACTIVE', drug, scriptId: script.id },
    ));

    script.status = 'active';

    // Random side-channel messages (~20%)
    if (Math.random() < 0.2) {
      const msgTypes = [
        { type: 'MSG_TYPE_GENERAL', from: pName, fromType: 'prescriber' as VizActorType,
          to: phName, toType: 'pharmacy' as VizActorType,
          content: `Drug interaction alert for ${mName}: check ${drug} with current medications` },
        { type: 'MSG_TYPE_NOTIFICATION', from: phName, fromType: 'pharmacy' as VizActorType,
          to: mName, toType: 'member' as VizActorType,
          content: `Your ${drug} prescription is being processed` },
        { type: 'MSG_TYPE_NOTIFICATION', from: 'Adjuda-GATOR PBM', fromType: 'insurer' as VizActorType,
          to: phName, toType: 'pharmacy' as VizActorType,
          content: `Formulary note: ${drug} — verify quantity limits` },
      ];
      const sideMsg = pick(msgTypes);

      await sleep(pace / 2);
      await emit(makeEvent(
        'viz:message:sent', sideMsg.from, sideMsg.fromType, 'messaging', 0, 5,
        { messageType: sideMsg.type, content: sideMsg.content, encrypted: true },
        sideMsg.to, sideMsg.toType,
      ));
      await sleep(pace / 4);
      await emit(makeEvent(
        'viz:message:received', sideMsg.to, sideMsg.toType, 'messaging', 3, 5,
        { messageType: sideMsg.type, from: sideMsg.from },
      ));
    }

    await sleep(pace / 2);
  }

  // ── Fulfillment ──
  const activeScripts = m.scripts.filter(s => s.status === 'active');
  const fillOrder = shuffle(activeScripts);

  for (const script of fillOrder) {
    const phName = script.pharmacy.storeName;
    const drug = script.medication.brandName || script.medication.genericName;
    const mName = m.displayName;

    const ingredientCost = script.medication.awpUnitPriceCents * script.qty;
    const dispensingFee = 200;
    const total = ingredientCost + dispensingFee;
    const copay = script.medication.formularyEntry.copayAmount;

    let patientPay: number;
    let planPay: number;
    let phase: string;

    const deductibleRemaining = 50000 - m.deductiblePaid;
    if (deductibleRemaining > 0 && total <= deductibleRemaining) {
      patientPay = total;
      planPay = 0;
      phase = 'DEDUCTIBLE';
    } else if (deductibleRemaining > 0) {
      patientPay = deductibleRemaining + Math.min(total - deductibleRemaining, copay);
      planPay = total - patientPay;
      phase = 'DEDUCTIBLE_PARTIAL';
    } else {
      patientPay = Math.min(total, copay);
      planPay = total - patientPay;
      phase = 'NORMAL_COPAY';
    }

    if (m.oopPaid + patientPay > 300000) {
      patientPay = Math.max(0, 300000 - m.oopPaid);
      planPay = total - patientPay;
      phase = 'OOPM_MET';
    }

    await emit(makeEvent(
      'viz:prescription:status', phName, 'pharmacy', 'prescription', 3, 4,
      { oldStatus: 'ACTIVE', newStatus: 'FILLED', drug, qty: script.qty, scriptId: script.id },
    ));
    await sleep(pace / 2);

    await emit(makeEvent(
      'viz:fulfillment:started', phName, 'pharmacy', 'fulfillment', 0, 5,
      { drug, qty: script.qty, scriptId: script.id,
        ingredientCost: formatCents(ingredientCost),
        dispensingFee: formatCents(dispensingFee) },
      mName, 'member',
    ));
    await sleep(pace);

    await emit(makeEvent(
      'viz:fulfillment:settled', 'Adjuda-GATOR PBM', 'insurer', 'fulfillment', 1, 5,
      { patientPay: formatCents(patientPay),
        planPay: formatCents(planPay),
        patientPayCents: patientPay, planPayCents: planPay,
        phase, drug, tier: script.medication.formularyEntry.tierLevel, scriptId: script.id },
      mName, 'member',
    ));
    await sleep(pace / 2);

    // Update accumulators
    if (phase === 'DEDUCTIBLE') {
      m.deductiblePaid += patientPay;
    } else if (phase === 'DEDUCTIBLE_PARTIAL') {
      m.deductiblePaid = 50000;
    }
    m.oopPaid += patientPay;

    await emit(makeEvent(
      'viz:accumulator:updated', 'Adjuda-GATOR PBM', 'insurer', 'fulfillment', 2, 5,
      { member: mName,
        deductiblePaid: formatCents(Math.min(m.deductiblePaid, 50000)),
        deductibleMax: '$500.00',
        oopPaid: formatCents(Math.min(m.oopPaid, 300000)),
        oopMax: '$3,000.00' },
      mName, 'member',
    ));
    await sleep(pace / 4);

    await emit(makeEvent(
      'viz:batch:submitted', phName, 'pharmacy', 'fulfillment', 3, 5,
      { receiptId: `l2-${script.id}`, drug },
    ));

    script.status = 'settled';
    await sleep(pace / 4);

    // Pickup notification (~40%)
    if (Math.random() < 0.4) {
      await emit(makeEvent(
        'viz:message:sent', phName, 'pharmacy', 'messaging', 0, 5,
        { messageType: 'MSG_TYPE_NOTIFICATION',
          content: `Your ${drug} is ready for pickup`, encrypted: true },
        mName, 'member',
      ));
      await sleep(pace / 4);
      await emit(makeEvent(
        'viz:message:received', mName, 'member', 'messaging', 3, 5,
        { messageType: 'MSG_TYPE_NOTIFICATION', from: phName },
      ));
      await sleep(pace / 4);
    }
  }

  // ── Random support message (~25% chance) ──
  if (Math.random() < 0.25) {
    await emit(makeEvent(
      'viz:message:sent', m.displayName, 'member', 'messaging', 0, 5,
      { messageType: 'MSG_TYPE_SUPPORT',
        content: pick([
          'What is my deductible balance?',
          'Can I transfer my prescription?',
          'Need help with copay',
          'Question about coverage',
        ]),
        encrypted: true },
      'Adjuda-GATOR PBM', 'insurer',
    ));
    await sleep(pace);

    await emit(makeEvent(
      'viz:message:received', 'Adjuda-GATOR PBM', 'insurer', 'messaging', 3, 5,
      { messageType: 'MSG_TYPE_SUPPORT', from: m.displayName },
    ));
    await sleep(pace);

    await emit(makeEvent(
      'viz:message:sent', 'Adjuda-GATOR PBM', 'insurer', 'messaging', 0, 5,
      { messageType: 'MSG_TYPE_SUPPORT_SUMMARY',
        content: `Deductible: ${formatCents(Math.min(m.deductiblePaid, 50000))} of $500. OOPM: ${formatCents(Math.min(m.oopPaid, 300000))} of $3,000.` },
      m.displayName, 'member',
    ));
    await sleep(pace / 2);

    await emit(makeEvent(
      'viz:message:received', m.displayName, 'member', 'messaging', 3, 5,
      { messageType: 'MSG_TYPE_SUPPORT_SUMMARY', from: 'Adjuda-GATOR PBM' },
    ));
    await sleep(pace / 2);
  }

  // ── Random reversal (~5% chance per settled script) ──
  const settled = m.scripts.filter(s => s.status === 'settled');
  for (const script of settled) {
    if (Math.random() >= 0.05) continue;

    const drug = script.medication.brandName || script.medication.genericName;
    const total = script.medication.awpUnitPriceCents * script.qty + 200;
    const copay = script.medication.formularyEntry.copayAmount;
    const patientRefund = Math.min(total, copay);
    const planRefund = total - patientRefund;

    await emit(makeEvent(
      'viz:reversal:processed', script.pharmacy.storeName, 'pharmacy', 'fulfillment', 0, 5,
      { drug: `${drug} ${script.medication.strength}`, scriptId: script.id,
        patientRefund: formatCents(patientRefund),
        planRefund: formatCents(planRefund),
        reason: pick([
          'Medication returned — adverse reaction',
          'Duplicate claim correction',
          'Insurance adjustment',
          'Pharmacy error correction',
        ]) },
      m.displayName, 'member',
    ));
    await sleep(pace);

    await emit(makeEvent(
      'viz:accumulator:updated', 'Adjuda-GATOR PBM', 'insurer', 'fulfillment', 2, 5,
      { member: m.displayName, action: 'REVERSAL_DECREMENT',
        deductiblePaid: formatCents(Math.max(0, m.deductiblePaid - patientRefund)),
        deductibleMax: '$500.00',
        oopPaid: formatCents(Math.max(0, m.oopPaid - patientRefund)),
        oopMax: '$3,000.00' },
      m.displayName, 'member',
    ));
    await sleep(pace);
  }
}

// ─── Simulation Engine ───────────────────────────────

export async function runScenario(config: Partial<ScenarioConfig> = {}): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  baseUrl = `http://127.0.0.1:${cfg.port}`;
  eventCounter = 0;
  startTime = Date.now();

  const totalMinutes = Math.ceil((cfg.memberCount * cfg.memberIntervalMs) / 60_000);

  console.log(`[Sim] Starting simulation → ${baseUrl}`);
  console.log(`[Sim] ${cfg.memberCount} members at ${cfg.employerName}`);
  console.log(`[Sim] ${cfg.totalScripts} prescriptions, ${cfg.paMembers} need PA on ${cfg.paDrugCount} drugs`);
  console.log(`[Sim] Pace: ${cfg.paceMs}ms between events, ${cfg.memberIntervalMs / 1000}s between members`);
  console.log(`[Sim] Estimated duration: ~${totalMinutes} minutes\n`);

  // ─── Build the world ───────────────────────────────

  console.log('[Sim] Building simulation world...');

  // Generate members
  const members: SimMember[] = [];
  for (let i = 0; i < cfg.memberCount; i++) {
    const { firstName, lastName } = generateName(i);
    members.push({
      id: `M${String(i + 1).padStart(3, '0')}`,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      cardholderId: `${cfg.groupId.split('-')[0]}-EMP-${String(i + 1).padStart(4, '0')}`,
      needsPA: false,
      assignedPrescriber: pick(PRESCRIBERS),
      assignedPharmacy: pick(PHARMACIES),
      scripts: [],
      deductiblePaid: 0,
      oopPaid: 0,
    });
  }

  // Randomly flag PA members
  const paMemberIndices = pickN([...Array(cfg.memberCount).keys()], cfg.paMembers);
  for (const idx of paMemberIndices) {
    members[idx].needsPA = true;
  }

  // Pick PA drugs (from Tier 4)
  const paDrugs = pickN(TIER4_SPECIALTY, cfg.paDrugCount);
  console.log(`[Sim] PA drugs: ${paDrugs.map(d => d.brandName).join(', ')}`);
  console.log(`[Sim] PA members: ${paMemberIndices.map(i => members[i].displayName).join(', ')}`);

  // Build non-PA drug pool
  const nonPaDrugs = [...TIER1_GENERICS, ...TIER2_PREFERRED, ...TIER3_NON_PREFERRED];

  // Generate scripts — distribute across members
  let scriptCounter = 0;

  for (let s = 0; s < cfg.totalScripts; s++) {
    const member = pick(members);
    scriptCounter++;

    let medication: SeedMedication;
    let needsPA = false;

    if (member.needsPA && paDrugs.length > 0 && Math.random() < 0.3) {
      medication = pick(paDrugs);
      needsPA = true;
    } else {
      medication = pick(nonPaDrugs);
    }

    const prescriber = Math.random() < 0.3 ? pick(PRESCRIBERS) : member.assignedPrescriber;
    const pharmacy = Math.random() < 0.2 ? pick(PHARMACIES) : member.assignedPharmacy;

    const qty = medication.formularyEntry.tierLevel === 4
      ? randInt(1, 3)
      : randInt(15, 90);

    const script: SimScript = {
      id: `RX-${String(scriptCounter).padStart(5, '0')}`,
      member,
      prescriber,
      pharmacy,
      medication,
      qty,
      needsPA,
      paApproved: false,
      status: 'pending',
    };

    member.scripts.push(script);
  }

  const allScripts = members.flatMap(m => m.scripts);
  console.log(`[Sim] ${allScripts.length} scripts generated`);
  console.log(`[Sim] ${allScripts.filter(s => s.needsPA).length} require PA\n`);

  // ─── Process members one at a time ─────────────────

  const batchNumber = { value: 0 };

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');

    console.log(`[Sim] [${mm}:${ss}] Member ${i + 1}/${members.length}: ${m.displayName} (${m.scripts.length} scripts${m.needsPA ? ', needs PA' : ''})...`);

    await processMember(m, cfg, paDrugs, batchNumber);

    // Wait before starting next member (skip wait after last)
    if (i < members.length - 1) {
      const waitSec = Math.round(cfg.memberIntervalMs / 1000);
      console.log(`[Sim] Next member in ${waitSec}s...`);
      await sleep(cfg.memberIntervalMs);
    }
  }

  // ─── Final batch settlement ────────────────────────

  console.log('[Sim] Settling final batches...');

  const settledCount = allScripts.filter(s => s.status === 'settled').length;
  const batchCount = Math.ceil(settledCount / 32);

  for (let b = 0; b < batchCount; b++) {
    const count = Math.min(32, settledCount - b * 32);
    batchNumber.value++;

    await emit(makeEvent(
      'viz:batch:submitted', 'Adjuda-GATOR PBM', 'insurer', 'batch', 0, 4,
      { pendingCount: count, batchNumber: batchNumber.value },
    ));
    await sleep(cfg.paceMs * 2);

    await emit(makeEvent(
      'viz:batch:submitted', 'Adjuda-GATOR PBM', 'insurer', 'batch', 1, 4,
      { batchNumber: batchNumber.value, transitionCount: count, buildTimeMs: randInt(800, 2500) },
    ));
    await sleep(cfg.paceMs * 2);

    await emit(makeEvent(
      'viz:batch:settled', 'Adjuda-GATOR PBM', 'insurer', 'batch', 2, 4,
      { batchNumber: batchNumber.value,
        l1TxHash: `sim-l1-tx-${String(batchNumber.value).padStart(5, '0')}`,
        transitionCount: count },
    ));
    await sleep(cfg.paceMs);
  }

  // ─── Summary ───────────────────────────────────────

  const deniedCount = allScripts.filter(s => s.needsPA && !s.paApproved).length;
  const writtenCount = allScripts.filter(s => !s.needsPA || s.paApproved).length;
  const settledFinal = allScripts.filter(s => s.status === 'settled').length;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const durMm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const durSs = String(elapsed % 60).padStart(2, '0');

  console.log(`\n[Sim] ═══ Simulation Complete (${durMm}:${durSs}) ═══`);
  console.log(`[Sim] Events emitted: ${eventCounter}`);
  console.log(`[Sim] Members enrolled: ${members.length}`);
  console.log(`[Sim] Scripts written: ${writtenCount} (${deniedCount} PA denied)`);
  console.log(`[Sim] Claims settled: ${settledFinal}`);
  console.log(`[Sim] Batches: ${batchCount}`);
}

let startTime = Date.now();
