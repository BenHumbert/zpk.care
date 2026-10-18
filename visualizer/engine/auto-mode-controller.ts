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
 * AutoModeController — Dynamic healthcare simulation stress test.
 *
 * Uses a **dynamic action pool** architecture instead of a linear pipeline.
 * Each cycle:
 *   1. Scan current state (enrolled members, prescriptions, PAs, fills)
 *   2. Build weighted list of ALL possible actions any node can take
 *   3. Randomly pick one and execute it
 *
 * This ensures every node type (member, prescriber, pharmacy, insurer) takes
 * action whenever there's an action to be taken, producing multiple Rx at
 * multiple pharmacies, PA requests/denials, reversals, messaging, delegation,
 * formulary updates — a true stress test of the system.
 *
 * Actions exercised:
 *   - Enrollment (randomized order) + PCP assignment
 *   - Doctor → member messaging (encrypted)
 *   - Member → doctor reply (threaded)
 *   - Pharmacy → member messaging
 *   - Insurer → member notification
 *   - Prescriptions (random prescriber, random pharmacy, random med)
 *   - Prior auth request + approve/deny
 *   - Pharmacy dispense (ACTIVE → DISPENSED)
 *   - Credential generation + verification
 *   - Pharmacy fill (DISPENSED → FILLED)
 *   - Pharmacy reject (ACTIVE → REJECTED)
 *   - Prescriber cancel (ACTIVE → CANCELLED)
 *   - Pharmacy reversal (FILLED → REVERSED)
 *   - AOR delegation (member → member)
 *   - Formulary updates (insurer changes tier/PA/removal)
 *
 * Start/stop via the dashboard "Auto Mode" toggle button.
 * Mutually exclusive with the smoke test.
 */
import type { AdjudicationService } from '../../src/adjudication/interactive-service.js';
import type { L2Node } from '../../src/l2/l2-node.js';
import { MEDICATIONS } from '../../src/data/index.js';
import { hashString } from '../../src/zkp/hash-utils.js';

// ─── Types ─────────────────────────────────────────

type AutoModeStatus = 'idle' | 'running' | 'stopping';

export interface AutoModeState {
  status: AutoModeStatus;
  cyclesCompleted: number;
  lastAction: string | null;
  lastError: string | null;
  startedAt: number | null;
}

type ActionType =
  | 'enroll'
  | 'assign_pcp'
  | 'doctor_message'
  | 'member_reply'
  | 'pharmacy_message'
  | 'insurer_message'
  | 'prescribe'
  | 'request_pa'
  | 'approve_pa'
  | 'deny_pa'
  | 'dispense'
  | 'generate_credential'
  | 'fill'
  | 'reject_rx'
  | 'cancel_rx'
  | 'reverse_rx'
  | 'create_delegation'
  | 'formulary_update'
  | 'prescriber_to_pharmacy'
  | 'member_to_pharmacy'
  | 'pharmacy_to_prescriber'
  | 'pharmacy_to_insurer';

interface WeightedAction {
  type: ActionType;
  weight: number;
  context: Record<string, unknown>;
}

// ─── Message Templates ─────────────────────────────

const DOCTOR_MESSAGES = [
  { subject: 'Follow-Up Appointment', body: 'Time for your follow-up. How have you been feeling since your last visit?' },
  { subject: 'Lab Results', body: 'Your lab results are in. Everything looks good — let\'s discuss at your next appointment.' },
  { subject: 'Medication Review', body: 'I\'d like to review your current medications. Any side effects or concerns?' },
  { subject: 'Treatment Plan Update', body: 'Based on your recent visit, I\'m updating your treatment plan. Please review.' },
  { subject: 'Wellness Check', body: 'Just checking in on how you\'re doing. Any new symptoms or concerns?' },
  { subject: 'Prescription Renewal', body: 'Your prescription is coming up for renewal. Let me know if the current dosage is working well.' },
];

const MEMBER_REPLIES = [
  { subject: 'Re: Follow-Up', body: 'Thank you, doctor. I\'ve been feeling much better lately.' },
  { subject: 'Re: Lab Results', body: 'Great news! I\'ll schedule an appointment to discuss.' },
  { subject: 'Re: Medication Review', body: 'No side effects so far. The medication seems to be working well.' },
  { subject: 'Re: Treatment Plan', body: 'I\'ve reviewed the plan. Everything looks good to me.' },
  { subject: 'Re: Wellness Check', body: 'Doing well, thank you for checking in. No new symptoms.' },
  { subject: 'Re: Prescription Renewal', body: 'Current dosage is working great. Please go ahead with the renewal.' },
];

const PHARMACY_MESSAGES = [
  { subject: 'Prescription Ready', body: 'Your prescription is ready for pickup at the pharmacy.' },
  { subject: 'Refill Reminder', body: 'Your medication refill is due soon. Would you like us to prepare it?' },
  { subject: 'Drug Interaction Notice', body: 'We noticed a potential interaction with your medications. Please consult your doctor.' },
  { subject: 'Generic Available', body: 'A generic equivalent is available for your medication. Ask about savings at pickup.' },
  { subject: 'Insurance Update', body: 'Your insurance coverage has been verified for this prescription.' },
  { subject: 'Pickup Reminder', body: 'Your dispensed medication is waiting for pickup. Please come at your earliest convenience.' },
];

const INSURER_MESSAGES = [
  { subject: 'Benefits Summary', body: 'Your annual benefits summary is now available. Review your deductible and OOP status.' },
  { subject: 'Plan Update', body: 'Important changes to your benefit plan will take effect next quarter.' },
  { subject: 'Wellness Program', body: 'You may be eligible for our wellness rewards program. Contact us for details.' },
  { subject: 'Claims Processed', body: 'Your recent claims have been processed successfully.' },
  { subject: 'Coverage Confirmation', body: 'Your coverage has been confirmed and is active for the current plan year.' },
  { subject: 'Preventive Care Reminder', body: 'Preventive care services are covered at 100%. Schedule your annual checkup.' },
];

const PRESCRIBER_TO_PHARMACY = [
  { subject: 'Dosage Clarification', body: 'Please confirm the dosage on the latest Rx. Patient may need adjustment.' },
  { subject: 'Substitute Authorization', body: 'If brand is unavailable, generic substitution is authorized for this patient.' },
  { subject: 'Rush Prescription', body: 'Patient needs this medication urgently. Please prioritize dispensing.' },
  { subject: 'Discontinuation Notice', body: 'Please cancel any pending refills for this medication. Treatment plan changed.' },
  { subject: 'Allergy Alert', body: 'Patient has a newly documented allergy. Please flag all related NDCs.' },
  { subject: 'Coordination Request', body: 'Can you confirm current fill status for my patient? Following up on compliance.' },
];

const MEMBER_TO_PHARMACY = [
  { subject: 'Pickup Inquiry', body: 'Is my prescription ready for pickup? I can come by this afternoon.' },
  { subject: 'Refill Request', body: 'I need to refill my medication. Can you process it today?' },
  { subject: 'Cost Question', body: 'Can you check my copay for this medication before I pick it up?' },
  { subject: 'Transfer Request', body: 'I\'d like to transfer a prescription from another pharmacy. How do I start?' },
  { subject: 'Side Effects', body: 'I\'m experiencing some side effects from this medication. Should I talk to the pharmacist?' },
  { subject: 'Thank You', body: 'Thank you for the quick service on my last prescription.' },
];

const PHARMACY_TO_PRESCRIBER = [
  { subject: 'DUR Alert', body: 'Drug utilization review flagged a potential interaction. Please advise on this patient.' },
  { subject: 'Refill Authorization', body: 'Patient has no refills remaining. Can you authorize a renewal?' },
  { subject: 'Therapeutic Substitution', body: 'Formulary change affects this medication. Requesting therapeutic alternative recommendation.' },
  { subject: 'Quantity Mismatch', body: 'Prescribed quantity exceeds plan maximum. Can you adjust or override?' },
  { subject: 'Prior Auth Needed', body: 'Insurance requires prior authorization for this Rx. Please submit when convenient.' },
  { subject: 'Compliance Concern', body: 'Patient has not picked up medication in 14 days. Following up per protocol.' },
];

const PHARMACY_TO_INSURER = [
  { subject: 'Claim Inquiry', body: 'Requesting clarification on rejected claim. NDC and coverage details attached.' },
  { subject: 'Override Request', body: 'Requesting override for quantity limit. Medical necessity documented by prescriber.' },
  { subject: 'PA Status Check', body: 'Checking status of pending prior authorization for patient prescription.' },
  { subject: 'Billing Correction', body: 'Submitting corrected claim after reversal. Updated pricing and DAW code.' },
  { subject: 'Network Status', body: 'Please confirm our pharmacy\'s network participation status for this plan.' },
  { subject: 'Audit Response', body: 'Responding to audit request with documentation for flagged claims.' },
];

const REJECT_REASONS = [
  'Drug Utilization Review flag — potential interaction detected',
  'Quantity exceeds plan maximum for this medication',
  'Prescriber not in network for this pharmacy',
  'Prior authorization expired or not on file',
  'NDC not found in current formulary',
  'Member eligibility could not be verified',
];

const CANCEL_REASONS = [
  'Patient requested alternative medication',
  'Prescriber changed treatment plan',
  'Duplicate prescription identified',
  'Medication no longer indicated',
  'Patient allergic reaction reported',
  'Dosage adjustment needed — new Rx to follow',
];

const REVERSAL_REASONS = [
  'Patient returned medication — adverse reaction',
  'Insurance claim correction required',
  'Incorrect quantity dispensed — reprocessing',
  'Patient billing dispute resolved',
  'Duplicate claim identified during audit',
  'Medication recall — manufacturer notification',
];

const FORMULARY_ACTIONS: Array<'MODIFY' | 'REMOVE' | 'ADD'> = ['MODIFY', 'REMOVE', 'ADD'];

// Medication indices: 0-7 tier 1 (no PA), 8-11 tier 2 (no PA), 12-13 tier 3 PA, 14 no PA, 15 tier 3 PA, 16 no PA
// Safe indices (no PA, on-formulary): 0-11, 14, 16
const SAFE_MED_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 16];
// PA-required indices (on-formulary): 12, 13, 15, 17, 18, 19, 20, 21
const PA_MED_INDICES = [12, 13, 15, 17, 18, 19, 20, 21];

// ─── Helpers ───────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Weighted random selection — pick one action from pool based on weights */
function weightedPick(actions: WeightedAction[]): WeightedAction {
  const total = actions.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const action of actions) {
    r -= action.weight;
    if (r <= 0) return action;
  }
  return actions[actions.length - 1]; // fallback
}

// ─── Controller ────────────────────────────────────

export class AutoModeController {
  private status: AutoModeStatus = 'idle';
  private cyclesCompleted = 0;
  private lastAction: string | null = null;
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private abortFlag = false;
  private sleepReject: (() => void) | null = null;
  private consecutiveErrors = 0;

  /** Track which member indices have been enrolled (randomized order) */
  private unenrolledIndices: number[] = [];

  /** Cache last credential JSON per wallet for fill actions */
  private credentialCache = new Map<string, string>();

  /** Track created delegations to avoid duplicates */
  private delegationPairs = new Set<string>();

  constructor(
    private service: AdjudicationService,
    private l2Node: L2Node,
  ) {}

  getState(): AutoModeState {
    return {
      status: this.status,
      cyclesCompleted: this.cyclesCompleted,
      lastAction: this.lastAction,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    if (this.status === 'running') return;
    this.status = 'running';
    this.abortFlag = false;
    this.cyclesCompleted = 0;
    this.consecutiveErrors = 0;
    this.lastAction = null;
    this.lastError = null;
    this.startedAt = Date.now();
    this.credentialCache.clear();
    this.delegationPairs.clear();

    // Build randomized enrollment order
    const state = this.service.getState() as Record<string, unknown>;
    const enrolled = (state.enrolledMembers ?? []) as Array<Record<string, unknown>>;
    const enrolledIndices = new Set(enrolled.map(m => m.memberIndex as number));
    this.unenrolledIndices = [];
    for (let i = 0; i < 8; i++) {
      if (!enrolledIndices.has(i)) this.unenrolledIndices.push(i);
    }
    // Shuffle unenrolled — Fisher-Yates
    for (let i = this.unenrolledIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.unenrolledIndices[i], this.unenrolledIndices[j]] =
        [this.unenrolledIndices[j], this.unenrolledIndices[i]];
    }

    console.log(`  [AutoMode] Starting (${this.unenrolledIndices.length} unenrolled, pool scan each cycle)...`);

    // Pause the L2 node's automatic batch timer — auto-mode builds batches
    // explicitly after proof-generating actions. This prevents the batch timer's
    // wrapSingle/wrapPair from racing with action proofs and avoids the o1js WASM
    // hang that occurs after ~60-70 proofs when the batch timer contends for the
    // proving lock during WASM execution.
    this.l2Node.pauseBatchTimer();

    try {
      await this.loop();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.log(`  [AutoMode] Fatal error: ${this.lastError}`);
    } finally {
      this.l2Node.resumeBatchTimer();
      this.status = 'idle';
      console.log(`  [AutoMode] Stopped. ${this.cyclesCompleted} cycles completed.`);
    }
  }

  stop(): void {
    if (this.status !== 'running') return;
    this.status = 'stopping';
    this.abortFlag = true;
    if (this.sleepReject) {
      this.sleepReject();
      this.sleepReject = null;
    }
  }

  reset(): void {
    this.stop();
    this.cyclesCompleted = 0;
    this.consecutiveErrors = 0;
    this.lastAction = null;
    this.lastError = null;
    this.startedAt = null;
    this.unenrolledIndices = [];
    this.credentialCache.clear();
    this.delegationPairs.clear();
  }

  // ─── Core Loop ─────────────────────────────────────

  private async loop(): Promise<void> {
    while (!this.abortFlag) {
      try {
        const state = this.service.getState() as Record<string, unknown>;
        const actions = this.buildActionPool(state);

        if (actions.length === 0) {
          // Nothing to do — all 8 enrolled, all Rx terminal, etc.
          console.log('  [AutoMode] No actions available, sleeping...');
          await this.interruptibleSleep(5000);
          continue;
        }

        const action = weightedPick(actions);
        await this.executeAction(action, state);

        this.cyclesCompleted++;
        this.consecutiveErrors = 0;
        // Hint GC to reclaim o1js WASM memory between proof-heavy operations
        (globalThis as unknown as { gc?: () => void }).gc?.();

        // Cooperative batch building — the automatic batch timer is paused,
        // so we explicitly flush pending transitions after each action.
        // This eliminates the race condition where the batch timer's WASM
        // execution blocks the event loop and causes the o1js prover to hang.
        if (this.abortFlag) break;
        await this.maybeFlushBatch();

        // Brief pause between cycles
        await this.interruptibleSleep(2000);
      } catch (err) {
        if (this.abortFlag) break;
        this.consecutiveErrors++;
        this.lastError = err instanceof Error ? err.message : String(err);
        console.log(`  [AutoMode] Error (${this.consecutiveErrors}): ${this.lastError}`);
        const backoff = Math.min(3000 * Math.pow(2, this.consecutiveErrors - 1), 30000);
        await this.interruptibleSleep(backoff);
      }
    }
  }

  /**
   * Flush ALL pending transitions into batches.
   * Called cooperatively from the main loop (batch timer is paused).
   * Loops because MAX_TRANSITIONS_PER_BATCH=2, so a formulary cascade
   * with 8 transitions needs 4 batch cycles.
   */
  private async maybeFlushBatch(): Promise<void> {
    let pending = this.l2Node.getPendingCount();
    if (pending === 0) return;

    while (pending > 0 && !this.abortFlag) {
      console.log(`  [AutoMode] Flushing batch (${pending} pending)...`);
      try {
        const batch = await this.l2Node.forceBatch();
        if (batch) {
          console.log(`  [AutoMode] Batch ${batch.batchNumber} built (${batch.transitionCount} tx, ${batch.registrationCount} reg)`);
        } else {
          break; // forceBatch returned null (e.g., batchInProgress or root mismatch)
        }
      } catch (err) {
        console.log(`  [AutoMode] Batch flush error: ${err instanceof Error ? err.message : String(err)}`);
        break; // Don't retry on error — let the next cycle handle it
      }
      // GC between batch proofs
      (globalThis as unknown as { gc?: () => void }).gc?.();
      const rss = process.memoryUsage().rss;
      console.log(`  [AutoMode] Post-batch RSS: ${(rss / 1024 / 1024).toFixed(0)}MB`);
      pending = this.l2Node.getPendingCount();
    }
  }

  // ─── Action Pool Builder ──────────────────────────

  private buildActionPool(state: Record<string, unknown>): WeightedAction[] {
    const pool: WeightedAction[] = [];
    const enrolled = (state.enrolledMembers ?? []) as Array<Record<string, unknown>>;
    const rxList = (state.prescriptions ?? []) as Array<Record<string, unknown>>;
    const paList = (state.priorAuths ?? []) as Array<Record<string, unknown>>;

    // Filter to active (non-revoked) members
    const activeMembers = enrolled.filter(m => m.lifecycle !== 'REVOKED');
    const membersWithPcp = activeMembers.filter(m => m.pcpAssignment != null);

    // ── ENROLLMENT (high priority when < 8 enrolled) ──
    if (this.unenrolledIndices.length > 0) {
      // Higher weight when few members enrolled, lower when most are
      const enrollWeight = activeMembers.length < 3 ? 30 : 10;
      pool.push({ type: 'enroll', weight: enrollWeight, context: {} });
    }

    // ── PCP ASSIGNMENT ──
    const noPcp = activeMembers.filter(m => m.pcpAssignment == null);
    for (const m of noPcp) {
      pool.push({
        type: 'assign_pcp',
        weight: 20, // high priority — unblocks other actions
        context: { walletId: m.walletId, displayName: m.displayName },
      });
    }

    // ── PRESCRIBE (any PCP prescriber → random pharmacy) ──
    if (membersWithPcp.length > 0) {
      // Add multiple prescribe actions for different members
      for (const m of membersWithPcp) {
        pool.push({
          type: 'prescribe',
          weight: 15,
          context: {
            walletId: m.walletId,
            displayName: m.displayName,
            pcpIndex: (m.pcpAssignment as Record<string, unknown>).prescriberIndex,
          },
        });
      }
    }

    // ── PA REQUEST (for PA-required meds) ──
    if (membersWithPcp.length > 0) {
      const m = pick(membersWithPcp);
      pool.push({
        type: 'request_pa',
        weight: 8,
        context: {
          walletId: m.walletId,
          displayName: m.displayName,
          pcpIndex: (m.pcpAssignment as Record<string, unknown>).prescriberIndex,
        },
      });
    }

    // ── PA APPROVE / DENY (insurer acts on pending PAs) ──
    const pendingPAs = paList.filter(pa => pa.status === 'PENDING');
    for (const pa of pendingPAs) {
      // 70% approve, 30% deny
      if (Math.random() < 0.7) {
        pool.push({ type: 'approve_pa', weight: 25, context: { paId: pa.id, memberName: pa.memberName } });
      } else {
        pool.push({ type: 'deny_pa', weight: 25, context: { paId: pa.id, memberName: pa.memberName } });
      }
    }

    // ── DISPENSE (pharmacy: ACTIVE Rx → DISPENSED) ──
    const activeRx = rxList.filter(rx => rx.status === 'ACTIVE');
    for (const rx of activeRx) {
      pool.push({
        type: 'dispense',
        weight: 18,
        context: { prescriptionId: rx.id, pharmacyIndex: rx.pharmacyIndex, memberWalletId: rx.memberWalletId },
      });
    }

    // ── GENERATE CREDENTIAL (for members with DISPENSED Rx, no cached credential) ──
    const dispensedRx = rxList.filter(rx => rx.status === 'DISPENSED');
    const walletsNeedingCredential = new Set<string>();
    for (const rx of dispensedRx) {
      const wid = rx.memberWalletId as string;
      if (!this.credentialCache.has(wid)) walletsNeedingCredential.add(wid);
    }
    for (const wid of Array.from(walletsNeedingCredential)) {
      const m = activeMembers.find(m => m.walletId === wid);
      if (m) {
        pool.push({
          type: 'generate_credential',
          weight: 20,
          context: { walletId: wid, displayName: m.displayName },
        });
      }
    }

    // ── FILL (pharmacy: DISPENSED Rx → FILLED, requires credential) ──
    for (const rx of dispensedRx) {
      const wid = rx.memberWalletId as string;
      if (this.credentialCache.has(wid)) {
        pool.push({
          type: 'fill',
          weight: 20,
          context: {
            prescriptionId: rx.id,
            walletId: wid,
            pharmacyIndex: rx.pharmacyIndex,
          },
        });
      }
    }

    // ── REJECT RX (pharmacy rejects ACTIVE Rx — ~10% of active Rx) ──
    if (activeRx.length > 2) {
      const rx = pick(activeRx);
      pool.push({
        type: 'reject_rx',
        weight: 5,
        context: { prescriptionId: rx.id, pharmacyIndex: rx.pharmacyIndex },
      });
    }

    // ── CANCEL RX (prescriber cancels ACTIVE Rx) ──
    if (activeRx.length > 2) {
      const rx = pick(activeRx);
      pool.push({
        type: 'cancel_rx',
        weight: 4,
        context: { prescriptionId: rx.id, prescriberIndex: rx.prescriberIndex },
      });
    }

    // ── REVERSE (pharmacy reverses FILLED Rx) ──
    const filledRx = rxList.filter(rx => rx.status === 'FILLED');
    if (filledRx.length > 1) {
      const rx = pick(filledRx);
      pool.push({
        type: 'reverse_rx',
        weight: 6,
        context: { prescriptionId: rx.id, pharmacyIndex: rx.pharmacyIndex },
      });
    }

    // ── DOCTOR → MEMBER MESSAGE ──
    if (membersWithPcp.length > 0) {
      const m = pick(membersWithPcp);
      pool.push({
        type: 'doctor_message',
        weight: 8,
        context: {
          walletId: m.walletId,
          displayName: m.displayName,
          pcpIndex: (m.pcpAssignment as Record<string, unknown>).prescriberIndex,
        },
      });
    }

    // ── MEMBER → DOCTOR REPLY ──
    if (membersWithPcp.length > 0) {
      const m = pick(membersWithPcp);
      pool.push({
        type: 'member_reply',
        weight: 6,
        context: {
          walletId: m.walletId,
          displayName: m.displayName,
          pcpIndex: (m.pcpAssignment as Record<string, unknown>).prescriberIndex,
        },
      });
    }

    // ── PHARMACY → MEMBER MESSAGE ──
    // Find pharmacies that have Rx for members
    const pharmacyMemberPairs: Array<{ pharmacyIndex: number; memberWalletId: string }> = [];
    const seenPairs = new Set<string>();
    for (const rx of rxList) {
      const key = `${rx.pharmacyIndex}-${rx.memberWalletId}`;
      if (!seenPairs.has(key) && rx.status !== 'CANCELLED' && rx.status !== 'REJECTED') {
        seenPairs.add(key);
        pharmacyMemberPairs.push({
          pharmacyIndex: rx.pharmacyIndex as number,
          memberWalletId: rx.memberWalletId as string,
        });
      }
    }
    if (pharmacyMemberPairs.length > 0) {
      const pair = pick(pharmacyMemberPairs);
      pool.push({
        type: 'pharmacy_message',
        weight: 6,
        context: pair,
      });
    }

    // ── PRESCRIBER → PHARMACY MESSAGE ──
    if (membersWithPcp.length > 0 && pharmacyMemberPairs.length > 0) {
      const pair = pick(pharmacyMemberPairs);
      // Find a prescriber who has this member as a patient
      const m = membersWithPcp.find(m => m.walletId === pair.memberWalletId);
      if (m) {
        pool.push({
          type: 'prescriber_to_pharmacy',
          weight: 5,
          context: {
            prescriberIndex: (m.pcpAssignment as Record<string, unknown>).prescriberIndex,
            pharmacyIndex: pair.pharmacyIndex,
          },
        });
      }
    }

    // ── MEMBER → PHARMACY MESSAGE ──
    if (pharmacyMemberPairs.length > 0) {
      const pair = pick(pharmacyMemberPairs);
      pool.push({
        type: 'member_to_pharmacy',
        weight: 5,
        context: { memberWalletId: pair.memberWalletId, pharmacyIndex: pair.pharmacyIndex },
      });
    }

    // ── PHARMACY → PRESCRIBER MESSAGE ──
    if (pharmacyMemberPairs.length > 0 && membersWithPcp.length > 0) {
      const pair = pick(pharmacyMemberPairs);
      const m = membersWithPcp.find(m => m.walletId === pair.memberWalletId);
      if (m) {
        pool.push({
          type: 'pharmacy_to_prescriber',
          weight: 5,
          context: {
            pharmacyIndex: pair.pharmacyIndex,
            prescriberIndex: (m.pcpAssignment as Record<string, unknown>).prescriberIndex,
          },
        });
      }
    }

    // ── PHARMACY → INSURER MESSAGE ──
    if (pharmacyMemberPairs.length > 0) {
      const pair = pick(pharmacyMemberPairs);
      pool.push({
        type: 'pharmacy_to_insurer',
        weight: 4,
        context: { pharmacyIndex: pair.pharmacyIndex },
      });
    }

    // ── INSURER → MEMBER NOTIFICATION ──
    if (activeMembers.length > 0) {
      const m = pick(activeMembers);
      pool.push({
        type: 'insurer_message',
        weight: 4,
        context: { walletId: m.walletId, displayName: m.displayName },
      });
    }

    // ── DELEGATION (AOR — member → member) ──
    if (activeMembers.length >= 2) {
      // Pick two different members
      const delegator = pick(activeMembers);
      const candidates = activeMembers.filter(m => m.walletId !== delegator.walletId);
      if (candidates.length > 0) {
        const delegate = pick(candidates);
        const pairKey = `${delegator.walletId}-${delegate.walletId}`;
        if (!this.delegationPairs.has(pairKey)) {
          pool.push({
            type: 'create_delegation',
            weight: 3,
            context: {
              delegatorWalletId: delegator.walletId,
              delegatorName: delegator.displayName,
              delegateWalletId: delegate.walletId,
              delegateName: delegate.displayName,
            },
          });
        }
      }
    }

    // ── FORMULARY UPDATE (insurer changes drug formulary) ──
    if (activeMembers.length >= 2) {
      pool.push({
        type: 'formulary_update',
        weight: 3,
        context: {},
      });
    }

    return pool;
  }

  // ─── Action Dispatcher ────────────────────────────

  private async executeAction(action: WeightedAction, state: Record<string, unknown>): Promise<void> {
    switch (action.type) {
      case 'enroll': return this.doEnroll();
      case 'assign_pcp': return this.doAssignPcp(action.context);
      case 'doctor_message': return this.doDoctorMessage(action.context);
      case 'member_reply': return this.doMemberReply(action.context);
      case 'pharmacy_message': return this.doPharmacyMessage(action.context);
      case 'insurer_message': return this.doInsurerMessage(action.context);
      case 'prescribe': return this.doPrescribe(action.context);
      case 'request_pa': return this.doRequestPA(action.context);
      case 'approve_pa': return this.doApprovePA(action.context);
      case 'deny_pa': return this.doDenyPA(action.context);
      case 'dispense': return this.doDispense(action.context);
      case 'generate_credential': return this.doGenerateCredential(action.context);
      case 'fill': return this.doFill(action.context);
      case 'reject_rx': return this.doRejectRx(action.context);
      case 'cancel_rx': return this.doCancelRx(action.context);
      case 'reverse_rx': return this.doReverseRx(action.context);
      case 'create_delegation': return this.doCreateDelegation(action.context);
      case 'formulary_update': return this.doFormularyUpdate();
      case 'prescriber_to_pharmacy': return this.doPrescriberToPharmacy(action.context);
      case 'member_to_pharmacy': return this.doMemberToPharmacy(action.context);
      case 'pharmacy_to_prescriber': return this.doPharmacyToPrescriber(action.context);
      case 'pharmacy_to_insurer': return this.doPharmacyToInsurer(action.context);
    }
  }

  // ─── Action Implementations ───────────────────────

  private async doEnroll(): Promise<void> {
    if (this.unenrolledIndices.length === 0) return;

    const idx = this.unenrolledIndices.shift()!;
    this.lastAction = `Enrolling member ${idx}`;
    console.log(`  [AutoMode] Enrolling member index ${idx}...`);

    const result = await this.l2Node.withProvingLock(() =>
      this.service.enrollMember(idx)
    ) as Record<string, unknown>;

    const walletId = result.walletId as string;
    const displayName = result.displayName as string;

    if (this.abortFlag) return;
    await this.interruptibleSleep(2000);
    if (this.abortFlag) return;

    // Auto-assign random PCP
    const prescriberIndex = randInt(0, 9);
    this.lastAction = `Assigning PCP to ${displayName}`;
    console.log(`  [AutoMode] Assigning PCP (prescriber ${prescriberIndex}) to ${displayName}...`);

    await this.l2Node.withProvingLock(() =>
      this.service.assignPcp({ memberWalletId: walletId, prescriberIndex })
    );
  }

  private async doAssignPcp(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;
    const prescriberIndex = randInt(0, 9);

    this.lastAction = `Assigning PCP to ${displayName}`;
    console.log(`  [AutoMode] Assigning PCP (prescriber ${prescriberIndex}) to ${displayName}...`);

    await this.l2Node.withProvingLock(() =>
      this.service.assignPcp({ memberWalletId: walletId, prescriberIndex })
    );
  }

  private async doDoctorMessage(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;
    const pcpIndex = ctx.pcpIndex as number;
    const msg = pick(DOCTOR_MESSAGES);

    this.lastAction = `Doctor messaging ${displayName}`;
    console.log(`  [AutoMode] Doctor ${pcpIndex} → ${displayName}: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'prescriber',
        senderIndex: pcpIndex,
        recipientType: 'member',
        recipientWalletId: walletId,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doMemberReply(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;
    const pcpIndex = ctx.pcpIndex as number;
    const msg = pick(MEMBER_REPLIES);

    this.lastAction = `${displayName} replying to doctor`;
    console.log(`  [AutoMode] ${displayName} → Doctor ${pcpIndex}: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'member',
        senderWalletId: walletId,
        recipientType: 'prescriber',
        recipientIndex: pcpIndex,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doPharmacyMessage(ctx: Record<string, unknown>): Promise<void> {
    const pharmacyIndex = ctx.pharmacyIndex as number;
    const memberWalletId = ctx.memberWalletId as string;
    const msg = pick(PHARMACY_MESSAGES);

    this.lastAction = `Pharmacy ${pharmacyIndex} messaging patient`;
    console.log(`  [AutoMode] Pharmacy ${pharmacyIndex} → member: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'pharmacy',
        senderIndex: pharmacyIndex,
        recipientType: 'member',
        recipientWalletId: memberWalletId,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doInsurerMessage(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;
    const msg = pick(INSURER_MESSAGES);

    this.lastAction = `Insurer notifying ${displayName}`;
    console.log(`  [AutoMode] Insurer → ${displayName}: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'insurer',
        recipientType: 'member',
        recipientWalletId: walletId,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doPrescriberToPharmacy(ctx: Record<string, unknown>): Promise<void> {
    const prescriberIndex = ctx.prescriberIndex as number;
    const pharmacyIndex = ctx.pharmacyIndex as number;
    const msg = pick(PRESCRIBER_TO_PHARMACY);

    this.lastAction = `Dr ${prescriberIndex} → Pharmacy ${pharmacyIndex}`;
    console.log(`  [AutoMode] Dr ${prescriberIndex} → Pharmacy ${pharmacyIndex}: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'prescriber',
        senderIndex: prescriberIndex,
        recipientType: 'pharmacy',
        recipientIndex: pharmacyIndex,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doMemberToPharmacy(ctx: Record<string, unknown>): Promise<void> {
    const memberWalletId = ctx.memberWalletId as string;
    const pharmacyIndex = ctx.pharmacyIndex as number;
    const msg = pick(MEMBER_TO_PHARMACY);

    this.lastAction = `Member → Pharmacy ${pharmacyIndex}`;
    console.log(`  [AutoMode] Member → Pharmacy ${pharmacyIndex}: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'member',
        senderWalletId: memberWalletId,
        recipientType: 'pharmacy',
        recipientIndex: pharmacyIndex,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doPharmacyToPrescriber(ctx: Record<string, unknown>): Promise<void> {
    const pharmacyIndex = ctx.pharmacyIndex as number;
    const prescriberIndex = ctx.prescriberIndex as number;
    const msg = pick(PHARMACY_TO_PRESCRIBER);

    this.lastAction = `Pharmacy ${pharmacyIndex} → Dr ${prescriberIndex}`;
    console.log(`  [AutoMode] Pharmacy ${pharmacyIndex} → Dr ${prescriberIndex}: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'pharmacy',
        senderIndex: pharmacyIndex,
        recipientType: 'prescriber',
        recipientIndex: prescriberIndex,
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doPharmacyToInsurer(ctx: Record<string, unknown>): Promise<void> {
    const pharmacyIndex = ctx.pharmacyIndex as number;
    const msg = pick(PHARMACY_TO_INSURER);

    this.lastAction = `Pharmacy ${pharmacyIndex} → Insurer`;
    console.log(`  [AutoMode] Pharmacy ${pharmacyIndex} → Insurer: "${msg.subject}"`);

    await this.l2Node.withProvingLock(() =>
      this.service.sendMessage({
        senderType: 'pharmacy',
        senderIndex: pharmacyIndex,
        recipientType: 'insurer',
        subject: msg.subject,
        body: msg.body,
      })
    );
  }

  private async doPrescribe(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;
    const pcpIndex = ctx.pcpIndex as number;
    const pharmacyIndex = randInt(0, 7);
    const medIndex = pick(SAFE_MED_INDICES);
    const quantity = randInt(15, 90);

    this.lastAction = `Prescribing med ${medIndex} → pharmacy ${pharmacyIndex} for ${displayName}`;
    console.log(`  [AutoMode] Dr ${pcpIndex} prescribing med ${medIndex} → pharmacy ${pharmacyIndex} for ${displayName}...`);

    await this.l2Node.withProvingLock(() =>
      this.service.createPrescription({
        prescriberIndex: pcpIndex,
        memberWalletId: walletId,
        ndcHash: hashString(MEDICATIONS[medIndex].ndc).toString(),
        pharmacyIndex,
        quantity,
        refills: randInt(0, 3),
      })
    );
  }

  private async doRequestPA(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;
    const pcpIndex = ctx.pcpIndex as number;
    const medIndex = pick(PA_MED_INDICES);

    this.lastAction = `Requesting PA (med ${medIndex}) for ${displayName}`;
    console.log(`  [AutoMode] Dr ${pcpIndex} requesting PA for med ${medIndex}, patient ${displayName}...`);

    try {
      this.service.requestPriorAuth({
        memberWalletId: walletId,
        prescriberIndex: pcpIndex,
        ndcHash: hashString(MEDICATIONS[medIndex].ndc).toString(),
      });
    } catch (err) {
      console.log(`  [AutoMode] PA request skipped: ${(err as Error).message}`);
    }
  }

  private async doApprovePA(ctx: Record<string, unknown>): Promise<void> {
    const paId = ctx.paId as string;
    const memberName = ctx.memberName as string;

    this.lastAction = `Insurer approving PA ${paId} for ${memberName}`;
    console.log(`  [AutoMode] Insurer approving PA ${paId}...`);

    await this.l2Node.withProvingLock(() =>
      this.service.approvePriorAuth(paId)
    );
  }

  private async doDenyPA(ctx: Record<string, unknown>): Promise<void> {
    const paId = ctx.paId as string;
    const memberName = ctx.memberName as string;

    this.lastAction = `Insurer denying PA ${paId} for ${memberName}`;
    console.log(`  [AutoMode] Insurer DENYING PA ${paId}...`);

    this.service.denyPriorAuth(paId);
  }

  private async doDispense(ctx: Record<string, unknown>): Promise<void> {
    const prescriptionId = ctx.prescriptionId as string;
    const pharmacyIndex = ctx.pharmacyIndex as number;

    this.lastAction = `Pharmacy ${pharmacyIndex} dispensing ${prescriptionId}`;
    console.log(`  [AutoMode] Pharmacy ${pharmacyIndex} dispensing ${prescriptionId}...`);

    this.service.updateRxStatus({
      prescriptionId,
      newStatus: 'DISPENSED',
      role: 'pharmacy',
      actorIndex: pharmacyIndex,
    });
  }

  private async doGenerateCredential(ctx: Record<string, unknown>): Promise<void> {
    const walletId = ctx.walletId as string;
    const displayName = ctx.displayName as string;

    this.lastAction = `Generating credential for ${displayName}`;
    console.log(`  [AutoMode] Generating credential for ${displayName}...`);

    const credResult = await this.l2Node.withProvingLock(() =>
      this.service.generateCredential(walletId)
    ) as Record<string, unknown>;

    const credentialJson = credResult.credentialJson as string;
    this.credentialCache.set(walletId, credentialJson);

    if (this.abortFlag) return;

    // Also verify it inline (instant, <1s)
    this.lastAction = `Verifying credential for ${displayName}`;
    console.log(`  [AutoMode] Verifying credential for ${displayName}...`);
    await this.service.verifyCredential(credentialJson);
  }

  private async doFill(ctx: Record<string, unknown>): Promise<void> {
    const prescriptionId = ctx.prescriptionId as string;
    const walletId = ctx.walletId as string;
    const pharmacyIndex = ctx.pharmacyIndex as number;

    const credentialJson = this.credentialCache.get(walletId);
    if (!credentialJson) {
      console.log(`  [AutoMode] Fill skipped — no credential for ${walletId}`);
      return;
    }

    this.lastAction = `Pharmacy ${pharmacyIndex} filling ${prescriptionId}`;
    console.log(`  [AutoMode] Pharmacy ${pharmacyIndex} filling ${prescriptionId}...`);

    await this.l2Node.withProvingLock(() =>
      this.service.dispensePrescription({ prescriptionId, credentialJson })
    );
  }

  private async doRejectRx(ctx: Record<string, unknown>): Promise<void> {
    const prescriptionId = ctx.prescriptionId as string;
    const pharmacyIndex = ctx.pharmacyIndex as number;
    const reason = pick(REJECT_REASONS);

    this.lastAction = `Pharmacy ${pharmacyIndex} rejecting ${prescriptionId}`;
    console.log(`  [AutoMode] Pharmacy ${pharmacyIndex} REJECTING ${prescriptionId}: ${reason}`);

    this.service.updateRxStatus({
      prescriptionId,
      newStatus: 'REJECTED',
      role: 'pharmacy',
      actorIndex: pharmacyIndex,
      note: reason,
    });
  }

  private async doCancelRx(ctx: Record<string, unknown>): Promise<void> {
    const prescriptionId = ctx.prescriptionId as string;
    const prescriberIndex = ctx.prescriberIndex as number;
    const reason = pick(CANCEL_REASONS);

    this.lastAction = `Dr ${prescriberIndex} cancelling ${prescriptionId}`;
    console.log(`  [AutoMode] Dr ${prescriberIndex} CANCELLING ${prescriptionId}: ${reason}`);

    this.service.updateRxStatus({
      prescriptionId,
      newStatus: 'CANCELLED',
      role: 'prescriber',
      actorIndex: prescriberIndex,
      note: reason,
    });
  }

  private async doReverseRx(ctx: Record<string, unknown>): Promise<void> {
    const prescriptionId = ctx.prescriptionId as string;
    const reason = pick(REVERSAL_REASONS);

    this.lastAction = `Reversing ${prescriptionId}`;
    console.log(`  [AutoMode] Reversing ${prescriptionId}: ${reason}`);

    await this.l2Node.withProvingLock(() =>
      this.service.reversePrescription({
        prescriptionId,
        reason,
      })
    );
  }

  private async doCreateDelegation(ctx: Record<string, unknown>): Promise<void> {
    const delegatorWalletId = ctx.delegatorWalletId as string;
    const delegatorName = ctx.delegatorName as string;
    const delegateWalletId = ctx.delegateWalletId as string;
    const delegateName = ctx.delegateName as string;

    // Random scope: READ(1), WRITE(2), PICKUP(4) — combinations
    const scopeFlags = pick([1, 3, 5, 7]); // READ, READ+WRITE, READ+PICKUP, ALL
    const relationshipCode = pick([1, 2, 3, 4, 6]); // Parent, Spouse, PoA, Guardian, Appointed Rep

    this.lastAction = `Delegation: ${delegatorName} → ${delegateName}`;
    console.log(`  [AutoMode] Creating delegation: ${delegatorName} → ${delegateName} (scope=${scopeFlags})...`);

    await this.l2Node.withProvingLock(() =>
      this.service.createDelegation({
        delegatorWalletId,
        delegateWalletId,
        scopeFlags,
        relationshipCode,
      })
    );

    // Track to avoid duplicate delegations
    this.delegationPairs.add(`${delegatorWalletId}-${delegateWalletId}`);
  }

  private async doFormularyUpdate(): Promise<void> {
    const medIndex = randInt(0, 21);
    let action = pick(FORMULARY_ACTIONS);

    // Guard: don't ADD if already on formulary, don't REMOVE if already off.
    // The service throws inside o1js context which can bypass JS try/catch.
    const isActive = (this.service as unknown as { formularyActive: boolean[] }).formularyActive?.[medIndex] ?? true;
    if (action === 'ADD' && isActive) action = 'MODIFY';
    if (action === 'REMOVE' && !isActive) action = 'ADD';
    // If still invalid after swap (ADD on active after REMOVE→ADD swap when not active is impossible, but guard anyway)
    if (action === 'ADD' && isActive) action = 'MODIFY';

    this.lastAction = `Insurer updating formulary (med ${medIndex}, ${action})`;
    console.log(`  [AutoMode] Insurer updating formulary: med ${medIndex} → ${action}...`);

    try {
      const payload: Record<string, unknown> = { ndcHash: hashString(MEDICATIONS[medIndex].ndc).toString(), action };
      if (action === 'MODIFY') {
        payload.newTierLevel = randInt(1, 3);
        payload.newRequiresPriorAuth = Math.random() < 0.3;
      }

      // Formulary updates cascade credential changes to all enrolled members,
      // generating a StateTransitionProof per member. Must hold the proving lock.
      await this.l2Node.withProvingLock(() =>
        this.service.updateFormularyEntry(payload as {
          ndcHash: string;
          action: 'MODIFY' | 'REMOVE' | 'ADD';
          newTierLevel?: number;
          newRequiresPriorAuth?: boolean;
        }),
      );
    } catch (err) {
      console.log(`  [AutoMode] Formulary update skipped: ${(err as Error).message}`);
    }
  }

  // ─── Interruptible Sleep ───────────────────────────

  private interruptibleSleep(ms: number): Promise<void> {
    if (this.abortFlag) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepReject = null;
        resolve();
      }, ms);
      this.sleepReject = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
