#!/usr/bin/env node
/**
 * scenario-runner.mjs — Random Scenario Runner for zkpCare Interactive Demo
 *
 * Enrolls all 8 members, generates credentials, then executes 5 random
 * scenario paths per member against the running demo server.
 * Designed to be watched in real-time on the network topology dashboard.
 *
 * Usage:
 *   node visualizer/demo/scenario-runner.mjs [--base http://localhost:3030] [--delay 2000] [--members 0,1,2] [--scenarios 5]
 *
 * Options:
 *   --base       Base URL of running demo server (default: http://localhost:3030)
 *   --delay      Delay in ms between operations for visual observability (default: 2000)
 *   --members    Comma-separated member indices to run (default: all 0-7)
 *   --scenarios  Number of scenarios per member (default: 5)
 *   --no-reset   Skip session reset (continue from current state)
 *   --skip-setup Skip enrollment+credential phase (assume already done)
 */

// ─── Configuration ──────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const BASE_URL = getArg('base', 'http://localhost:3030');
const OP_DELAY = parseInt(getArg('delay', '2000'), 10);
const SCENARIOS_PER_MEMBER = parseInt(getArg('scenarios', '5'), 10);
const SKIP_RESET = hasFlag('no-reset');
const SKIP_SETUP = hasFlag('skip-setup');
const MEMBER_FILTER = getArg('members', null);

// ─── Demo Data Reference ────────────────────────────────────
// Indices into DEMO_MEMBERS, DEMO_PRESCRIBERS, DEMO_PHARMACIES, DEMO_MEDICATIONS

const MEMBERS = [
  { idx: 0, name: 'Alice Johnson',    familyId: 'FAM-ACME-10001', relationship: 'SELF' },
  { idx: 1, name: 'Bob Martinez',     familyId: 'FAM-ACME-10002', relationship: 'SELF' },
  { idx: 2, name: 'Carol Williams',   familyId: 'FAM-ACME-10003', relationship: 'SELF' },
  { idx: 3, name: 'Daniel Williams',  familyId: 'FAM-ACME-10003', relationship: 'SPOUSE' },
  { idx: 4, name: 'Emma Williams',    familyId: 'FAM-ACME-10003', relationship: 'CHILD' },
  { idx: 5, name: 'Frank Lee',        familyId: 'FAM-GX-50001',   relationship: 'SELF' },
  { idx: 6, name: 'Grace Nakamura',   familyId: 'FAM-GX-50002',   relationship: 'SELF' },
  { idx: 7, name: 'Henry Okafor',     familyId: 'FAM-GX-50003',   relationship: 'SELF' },
];

// Medications that DON'T require PA and DON'T require step therapy (safe to prescribe immediately)
const EASY_MEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14]; // Tier 1 generics + Jardiance, Eliquis, Symbicort, Entresto, Vyvanse

// Medications that REQUIRE PA (on-formulary)
const PA_MEDS = [12, 13, 15, 17, 18, 19, 20, 21]; // Rinvoq, Xolair, Trulicity, Humira, Keytruda, Revlimid, Ozempic, Stelara

// 10 prescribers (indices 0-9), 8 pharmacies (indices 0-7)
function randomPrescriber() { return Math.floor(Math.random() * 10); }
function randomPharmacy() { return Math.floor(Math.random() * 8); }
function randomEasyMed() { return EASY_MEDS[Math.floor(Math.random() * EASY_MEDS.length)]; }
function randomPaMed() { return PA_MEDS[Math.floor(Math.random() * PA_MEDS.length)]; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── HTTP Helpers ───────────────────────────────────────────

async function post(path, body = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Poll an async job until complete/error. */
async function pollUntilDone(pollPath, label, maxWaitMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(5000);
    const { data } = await get(pollPath);
    if (data.status === 'complete') {
      log(`  [OK] ${label} complete`);
      return data.result;
    }
    if (data.status === 'error') {
      log(`  [ERR] ${label} failed: ${data.error}`);
      return null;
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  [..] ${label} — ${elapsed}s elapsed...`);
  }
  log(`  [TIMEOUT] ${label} exceeded ${maxWaitMs / 1000}s`);
  return null;
}

// ─── Logging ────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function header(msg) { console.log(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}`); }
function subheader(msg) { console.log(`\n  ── ${msg} ──`); }

/** Wait for the demo server to be reachable AND compilation to finish. */
async function waitForServer(maxWaitMs = 600000) {
  const start = Date.now();

  // Phase 1: Wait for server to respond
  log('Waiting for server...');
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${BASE_URL}/interactive/state`);
      if (res.ok) {
        log(`Server reachable at ${BASE_URL}`);
        break;
      }
    } catch {
      // Server not up yet
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  Waiting for server at ${BASE_URL}... (${elapsed}s)`);
    await sleep(3000);
  }

  // Phase 2: Wait for ZkProgram compilation to complete
  log('Waiting for ZkProgram compilation...');
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${BASE_URL}/flowchart/compilation`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'complete') {
          log('All ZkPrograms compiled. Ready to run scenarios.');
          return;
        }
        const done = data.programs.filter(p => p.status === 'complete').length;
        const total = data.programs.length;
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        process.stdout.write(`\r  Compiling ZkPrograms... ${done}/${total} (${elapsed}s)`);
      }
    } catch {
      // Compilation endpoint not available — try /interactive/state as fallback
      try {
        const res = await fetch(`${BASE_URL}/interactive/state`);
        if (res.ok) {
          const data = await res.json();
          // If compilation endpoint doesn't exist (start-interactive mode), check if programs work
          if (data && !data.error) {
            log('Server ready (no compilation endpoint — assuming compiled).');
            return;
          }
        }
      } catch { /* still starting */ }
    }
    await sleep(5000);
  }
  throw new Error(`Server not ready after ${maxWaitMs / 1000}s`);
}

// ─── Setup Phase ────────────────────────────────────────────

async function resetSession() {
  log('Resetting session...');
  const { data } = await post('/interactive/reset');
  log(`Reset: ${data.message || 'done'}`);
}

/**
 * Enroll a single member (async with polling).
 * Returns walletId string or null on failure.
 */
async function enrollMember(memberIndex, memberName) {
  log(`Enrolling ${memberName} (index ${memberIndex})...`);
  const { status, data } = await post('/interactive/enroll', { memberIndex });

  if (status === 200 && data.status === 'complete') {
    log(`  [OK] ${memberName} already enrolled`);
    return data.result?.walletId || null;
  }

  if (status !== 202 && status !== 200) {
    log(`  [ERR] Enroll failed (${status}): ${JSON.stringify(data)}`);
    return null;
  }

  // Poll for completion
  const result = await pollUntilDone(
    `/interactive/enroll-status?memberIndex=${memberIndex}`,
    `Enrollment of ${memberName}`
  );
  return result?.walletId || null;
}

/**
 * Generate a portable credential for a member (async with polling).
 */
async function generateCredential(walletId, memberName) {
  log(`Generating credential for ${memberName}...`);
  const { status, data } = await post('/interactive/generate-credential', {
    walletId,
    proofType: 'holding',
  });

  if (status === 200 && data.status === 'complete') {
    log(`  [OK] ${memberName} credential already generated`);
    return data.result;
  }

  if (status !== 202 && status !== 200) {
    log(`  [ERR] Credential failed (${status}): ${JSON.stringify(data)}`);
    return null;
  }

  const result = await pollUntilDone(
    `/interactive/credential-status?walletId=${walletId}&proofType=holding`,
    `Credential for ${memberName}`
  );
  return result;
}

/** Get current state to find already-enrolled members. */
async function getState() {
  const { data } = await get('/interactive/state');
  return data;
}

// ─── Scenario Definitions ───────────────────────────────────

/**
 * Each scenario is a function(ctx) where ctx = { walletId, memberName, memberIndex }.
 * Returns a brief description of what happened.
 */

/** P1/P2: Prescribe (no PA) → Fill → Complete */
async function scenarioPrescribeFillComplete(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Fill → Complete`);

  // Prescribe
  log(`  Prescribing medication ${medIdx} via prescriber ${presIdx} at pharmacy ${pharmIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 2,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Prescription ${rxId} created — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Fill (async)
  log(`  Filling prescription ${rxId}...`);
  const fill = await post('/interactive/fill', { prescriptionId: rxId });
  if (fill.status !== 202 && fill.status !== 200) {
    log(`  [ERR] Fill failed: ${JSON.stringify(fill.data)}`);
    return `Rx ${rxId} created but fill failed`;
  }
  const fillResult = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill ${rxId}`
  );
  if (!fillResult) return `Rx ${rxId} fill timed out`;
  await sleep(OP_DELAY);

  // Complete
  log(`  Completing prescription ${rxId}...`);
  const complete = await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'COMPLETED',
    role: 'pharmacy',
    actorIndex: pharmIdx,
  });
  if (complete.status === 200) {
    log(`  [OK] Rx ${rxId} COMPLETED — ${rx.data.medication?.brandName}`);
  } else {
    log(`  [WARN] Complete status update: ${JSON.stringify(complete.data)}`);
  }

  return `P1: ${rx.data.medication?.brandName} prescribed, filled, completed`;
}

/** P10: Prescribe → Prescriber Cancels */
async function scenarioPrescribeCancel(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Cancel`);

  log(`  Prescribing medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 0,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Prescription ${rxId} — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Cancel
  log(`  Prescriber cancelling ${rxId}...`);
  const cancel = await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'CANCELLED',
    role: 'prescriber',
    actorIndex: presIdx,
    note: 'Prescriber changed treatment plan',
  });
  log(`  [OK] Rx ${rxId} CANCELLED`);

  return `P10: ${rx.data.medication?.brandName} prescribed then cancelled`;
}

/** P11: Prescribe → Pharmacy Rejects */
async function scenarioPrescribeReject(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Pharmacy Reject`);

  log(`  Prescribing medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 0,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Prescription ${rxId} — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Reject
  log(`  Pharmacy rejecting ${rxId}...`);
  await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'REJECTED',
    role: 'pharmacy',
    actorIndex: pharmIdx,
    note: 'Medication out of stock',
  });
  log(`  [OK] Rx ${rxId} REJECTED by pharmacy`);

  return `P11: ${rx.data.medication?.brandName} prescribed, pharmacy rejected`;
}

/** P6/P33: Prescribe → Fill → Reverse → Re-fill */
async function scenarioPrescribeFillReverse(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Fill → Reverse`);

  log(`  Prescribing medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 1,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Prescription ${rxId} — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Fill
  log(`  Filling ${rxId}...`);
  await post('/interactive/fill', { prescriptionId: rxId });
  const fillResult = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill ${rxId}`
  );
  if (!fillResult) return `Rx ${rxId} fill failed`;
  await sleep(OP_DELAY);

  // Reverse
  log(`  Reversing ${rxId}...`);
  const rev = await post('/interactive/reverse', {
    prescriptionId: rxId,
    reason: 'Wrong strength dispensed',
  });
  if (rev.status === 200) {
    log(`  [OK] Rx ${rxId} REVERSED — accumulators rolled back`);
  } else {
    log(`  [WARN] Reverse: ${JSON.stringify(rev.data)}`);
  }

  return `P6: ${rx.data.medication?.brandName} filled then reversed`;
}

/** P5: Request PA → Approve → Prescribe → Fill */
async function scenarioPaApproveFill(ctx) {
  const medIdx = randomPaMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: PA → Approve → Prescribe → Fill`);

  // Request PA
  log(`  Requesting PA for medication ${medIdx}...`);
  const paReq = await post('/interactive/request-prior-auth', {
    memberWalletId: ctx.walletId,
    prescriberIndex: presIdx,
    medicationIndex: medIdx,
  });
  if (paReq.status !== 200) {
    log(`  [ERR] PA request failed: ${JSON.stringify(paReq.data)}`);
    return 'PA request failed';
  }
  const paId = paReq.data.paId;
  log(`  [OK] PA ${paId} PENDING — ${paReq.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Approve PA
  log(`  Insurer approving PA ${paId}...`);
  const paApprove = await post('/interactive/approve-prior-auth', { priorAuthId: paId });
  if (paApprove.status !== 200) {
    log(`  [ERR] PA approval failed: ${JSON.stringify(paApprove.data)}`);
    return `PA ${paId} approval failed`;
  }
  log(`  [OK] PA ${paId} APPROVED`);
  await sleep(OP_DELAY);

  // Prescribe with PA
  log(`  Prescribing PA medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 1,
    refills: 0,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return `PA approved but prescribe failed`;
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Rx ${rxId} — ${rx.data.medication?.brandName} (with PA)`);
  await sleep(OP_DELAY);

  // Fill
  log(`  Filling ${rxId}...`);
  await post('/interactive/fill', { prescriptionId: rxId });
  const fillResult = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill ${rxId}`
  );
  if (!fillResult) return `Rx ${rxId} fill timed out`;

  return `P5: ${rx.data.medication?.brandName} PA approved, prescribed, filled`;
}

/** P17: Request PA → Deny */
async function scenarioPaDeny(ctx) {
  const medIdx = randomPaMed();
  const presIdx = randomPrescriber();

  subheader(`${ctx.memberName}: PA → Deny`);

  log(`  Requesting PA for medication ${medIdx}...`);
  const paReq = await post('/interactive/request-prior-auth', {
    memberWalletId: ctx.walletId,
    prescriberIndex: presIdx,
    medicationIndex: medIdx,
  });
  if (paReq.status !== 200) {
    log(`  [ERR] PA request failed: ${JSON.stringify(paReq.data)}`);
    return 'PA request failed';
  }
  const paId = paReq.data.paId;
  log(`  [OK] PA ${paId} PENDING — ${paReq.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Deny
  log(`  Insurer denying PA ${paId}...`);
  await post('/interactive/deny-prior-auth', { priorAuthId: paId });
  log(`  [OK] PA ${paId} DENIED`);

  return `P17: ${paReq.data.medication?.brandName} PA denied`;
}

/** P7: Assign PCP → Prescribe → Fill → Complete */
async function scenarioAssignPcpPrescribeFill(ctx) {
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();
  const medIdx = randomEasyMed();

  subheader(`${ctx.memberName}: Assign PCP → Prescribe → Fill`);

  // Assign PCP
  log(`  Assigning PCP (prescriber ${presIdx})...`);
  const pcp = await post('/interactive/assign-pcp', {
    memberWalletId: ctx.walletId,
    prescriberIndex: presIdx,
  });
  if (pcp.status === 200) {
    log(`  [OK] PCP assigned — ${pcp.data.pcp?.name || 'prescriber ' + presIdx}`);
  } else {
    log(`  [WARN] PCP assignment: ${JSON.stringify(pcp.data)}`);
  }
  await sleep(OP_DELAY);

  // Prescribe from the PCP
  log(`  PCP prescribing medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 3,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'PCP prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Rx ${rxId} — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Fill
  log(`  Filling ${rxId}...`);
  await post('/interactive/fill', { prescriptionId: rxId });
  const fillResult = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill ${rxId}`
  );
  if (!fillResult) return `Rx ${rxId} fill timed out`;

  // Complete
  log(`  Completing ${rxId}...`);
  await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'COMPLETED',
    role: 'pharmacy',
    actorIndex: pharmIdx,
  });
  log(`  [OK] Rx ${rxId} COMPLETED`);

  return `P7: PCP assigned, ${rx.data.medication?.brandName} prescribed + filled`;
}

/** P8: Prescribe → Dispense → Complete */
async function scenarioPrescribeDispenseComplete(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Dispense → Complete`);

  log(`  Prescribing medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 0,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Rx ${rxId} — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Mark as dispensed (awaiting pickup)
  log(`  Pharmacy dispensing ${rxId} (staging for pickup)...`);
  const disp = await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'DISPENSED',
    role: 'pharmacy',
    actorIndex: pharmIdx,
    note: 'Ready for pickup',
  });
  if (disp.status === 200) {
    log(`  [OK] Rx ${rxId} DISPENSED — awaiting member pickup`);
  } else {
    log(`  [WARN] Dispense: ${JSON.stringify(disp.data)}`);
    // Fall through — try to fill instead
    log(`  Falling back to fill...`);
    await post('/interactive/fill', { prescriptionId: rxId });
    const fillResult = await pollUntilDone(
      `/interactive/fill-status?prescriptionId=${rxId}`,
      `Fill ${rxId}`
    );
    if (!fillResult) return `Rx ${rxId} fill timed out`;
    await sleep(OP_DELAY);

    await post('/interactive/update-rx-status', {
      prescriptionId: rxId,
      newStatus: 'COMPLETED',
      role: 'pharmacy',
      actorIndex: pharmIdx,
    });
    log(`  [OK] Rx ${rxId} COMPLETED (via fill)`);
    return `P8: ${rx.data.medication?.brandName} filled + completed`;
  }

  await sleep(OP_DELAY);

  // Member picks up → fill
  log(`  Member picks up — filling ${rxId}...`);
  await post('/interactive/fill', { prescriptionId: rxId });
  const fillResult = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill ${rxId}`
  );
  if (!fillResult) return `Rx ${rxId} fill timed out after dispense`;
  await sleep(OP_DELAY);

  // Complete
  await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'COMPLETED',
    role: 'pharmacy',
    actorIndex: pharmIdx,
  });
  log(`  [OK] Rx ${rxId} COMPLETED`);

  return `P8: ${rx.data.medication?.brandName} dispensed, picked up, completed`;
}

/** E: Send message to a prescriber or pharmacy */
async function scenarioSendMessage(ctx) {
  const messageTargets = ['prescriber', 'pharmacy'];
  const targetType = pick(messageTargets);
  const targetIndex = targetType === 'prescriber' ? randomPrescriber() : randomPharmacy();

  subheader(`${ctx.memberName}: Send Message → ${targetType}`);

  const subjects = [
    'Appointment request',
    'Medication question',
    'Refill request',
    'Insurance inquiry',
    'Thank you note',
    'Prescription status question',
  ];
  const bodies = [
    'I would like to schedule a follow-up appointment regarding my medication.',
    'Can you clarify the dosage instructions for my prescription?',
    'I need to refill my medication - can you process this?',
    'I have a question about my coverage for this medication.',
    'Thank you for your excellent care and attention.',
    'When will my prescription be ready for pickup?',
  ];
  const idx = Math.floor(Math.random() * subjects.length);

  log(`  Sending message to ${targetType} ${targetIndex}...`);
  const msg = await post('/interactive/send-message', {
    senderType: 'member',
    senderWalletId: ctx.walletId,
    recipientType: targetType,
    recipientIndex: targetIndex,
    subject: subjects[idx],
    body: bodies[idx],
  });
  if (msg.status === 200) {
    log(`  [OK] Message sent to ${targetType} ${targetIndex}`);
  } else {
    log(`  [WARN] Message: ${JSON.stringify(msg.data)}`);
  }

  return `E: Message sent to ${targetType}`;
}

/** P35: Prescribe → Fill → Reverse → Cancel */
async function scenarioFillReverseCancel(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Fill → Reverse → Cancel`);

  log(`  Prescribing medication ${medIdx}...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 0,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Rx ${rxId} — ${rx.data.medication?.brandName}`);
  await sleep(OP_DELAY);

  // Fill
  log(`  Filling ${rxId}...`);
  await post('/interactive/fill', { prescriptionId: rxId });
  const fillResult = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill ${rxId}`
  );
  if (!fillResult) return `Fill timed out`;
  await sleep(OP_DELAY);

  // Reverse
  log(`  Reversing ${rxId}...`);
  const rev = await post('/interactive/reverse', {
    prescriptionId: rxId,
    reason: 'Patient adverse reaction',
  });
  if (rev.status !== 200) {
    log(`  [WARN] Reverse: ${JSON.stringify(rev.data)}`);
    return `Reverse failed`;
  }
  log(`  [OK] Rx ${rxId} reversed`);
  await sleep(OP_DELAY);

  // Cancel
  log(`  Cancelling ${rxId}...`);
  await post('/interactive/update-rx-status', {
    prescriptionId: rxId,
    newStatus: 'CANCELLED',
    role: 'prescriber',
    actorIndex: presIdx,
    note: 'Adverse reaction — discontinue medication',
  });
  log(`  [OK] Rx ${rxId} CANCELLED after reversal`);

  return `P35: ${rx.data.medication?.brandName} filled, reversed, cancelled`;
}

/** Multiple fills on same Rx — prescribe with refills, fill twice */
async function scenarioMultipleFills(ctx) {
  const medIdx = randomEasyMed();
  const presIdx = randomPrescriber();
  const pharmIdx = randomPharmacy();

  subheader(`${ctx.memberName}: Prescribe → Fill → Fill again (refill)`);

  log(`  Prescribing medication ${medIdx} with refills...`);
  const rx = await post('/interactive/prescribe', {
    prescriberIndex: presIdx,
    memberWalletId: ctx.walletId,
    medicationIndex: medIdx,
    pharmacyIndex: pharmIdx,
    quantity: 30,
    refills: 3,
  });
  if (rx.status !== 200) {
    log(`  [ERR] Prescribe failed: ${JSON.stringify(rx.data)}`);
    return 'Prescribe failed';
  }
  const rxId = rx.data.prescriptionId;
  log(`  [OK] Rx ${rxId} — ${rx.data.medication?.brandName} (qty 30, 3 refills)`);
  await sleep(OP_DELAY);

  // First fill
  log(`  First fill of ${rxId}...`);
  await post('/interactive/fill', { prescriptionId: rxId });
  const fill1 = await pollUntilDone(
    `/interactive/fill-status?prescriptionId=${rxId}`,
    `Fill 1 of ${rxId}`
  );
  if (!fill1) return `First fill timed out`;
  log(`  [OK] Fill 1 complete — patient pay: ${fill1.adjudication?.patientPayCents || '?'}c, plan pay: ${fill1.adjudication?.planPayCents || '?'}c`);
  await sleep(OP_DELAY);

  // Second fill (if Rx allows)
  log(`  Second fill of ${rxId}...`);
  const fill2start = await post('/interactive/fill', { prescriptionId: rxId });
  if (fill2start.status === 202 || fill2start.status === 200) {
    const fill2 = await pollUntilDone(
      `/interactive/fill-status?prescriptionId=${rxId}`,
      `Fill 2 of ${rxId}`
    );
    if (fill2) {
      log(`  [OK] Fill 2 complete — patient pay: ${fill2.adjudication?.patientPayCents || '?'}c, plan pay: ${fill2.adjudication?.planPayCents || '?'}c`);
    }
  } else {
    log(`  [INFO] Second fill not possible: ${JSON.stringify(fill2start.data)}`);
  }

  return `P4: ${rx.data.medication?.brandName} prescribed with refills, filled twice`;
}

// ─── Scenario Selection ─────────────────────────────────────

/**
 * Weighted scenario pool. Higher weight = more likely to be picked.
 * Ensures a good mix of visual scenarios.
 */
const SCENARIO_POOL = [
  { name: 'prescribe_fill_complete',   weight: 4, fn: scenarioPrescribeFillComplete },
  { name: 'prescribe_cancel',          weight: 2, fn: scenarioPrescribeCancel },
  { name: 'prescribe_reject',          weight: 2, fn: scenarioPrescribeReject },
  { name: 'prescribe_fill_reverse',    weight: 3, fn: scenarioPrescribeFillReverse },
  { name: 'pa_approve_fill',           weight: 3, fn: scenarioPaApproveFill },
  { name: 'pa_deny',                   weight: 2, fn: scenarioPaDeny },
  { name: 'pcp_prescribe_fill',        weight: 2, fn: scenarioAssignPcpPrescribeFill },
  { name: 'dispense_complete',         weight: 2, fn: scenarioPrescribeDispenseComplete },
  { name: 'send_message',              weight: 2, fn: scenarioSendMessage },
  { name: 'fill_reverse_cancel',       weight: 2, fn: scenarioFillReverseCancel },
  { name: 'multiple_fills',            weight: 2, fn: scenarioMultipleFills },
];

/** Select N random scenarios using weighted random selection. */
function selectScenarios(count) {
  const totalWeight = SCENARIO_POOL.reduce((sum, s) => sum + s.weight, 0);
  const selected = [];
  const used = new Set();

  for (let i = 0; i < count; i++) {
    let attempts = 0;
    while (attempts < 50) {
      let roll = Math.random() * totalWeight;
      for (const scenario of SCENARIO_POOL) {
        roll -= scenario.weight;
        if (roll <= 0) {
          // Allow duplicates if we've exhausted unique scenarios
          if (!used.has(scenario.name) || used.size >= SCENARIO_POOL.length) {
            selected.push(scenario);
            used.add(scenario.name);
            attempts = 100; // break outer
          }
          break;
        }
      }
      attempts++;
    }
  }

  return selected;
}

// ─── Main Runner ────────────────────────────────────────────

async function main() {
  header('zkpCare Random Scenario Runner');
  log(`Server: ${BASE_URL}`);
  log(`Delay between operations: ${OP_DELAY}ms`);
  log(`Scenarios per member: ${SCENARIOS_PER_MEMBER}`);

  // Wait for server to be ready (handles combined start)
  await waitForServer();

  // Determine which members to run
  const memberIndices = MEMBER_FILTER
    ? MEMBER_FILTER.split(',').map(s => parseInt(s.trim(), 10))
    : MEMBERS.map(m => m.idx);
  log(`Members: ${memberIndices.join(', ')} (${memberIndices.length} total)`);

  // ─── Phase 1: Reset ────────────────────────────
  if (!SKIP_RESET && !SKIP_SETUP) {
    header('Phase 1: Session Reset');
    await resetSession();
    await sleep(1000);
  }

  // ─── Phase 2: Enrollment ───────────────────────
  const memberWallets = new Map(); // memberIndex → walletId

  if (!SKIP_SETUP) {
    header('Phase 2: Member Enrollment');

    for (const memberIdx of memberIndices) {
      const member = MEMBERS[memberIdx];
      if (!member) {
        log(`[SKIP] Invalid member index: ${memberIdx}`);
        continue;
      }

      const walletId = await enrollMember(memberIdx, member.name);
      if (walletId) {
        memberWallets.set(memberIdx, walletId);
        log(`  Wallet: ${walletId.substring(0, 20)}...`);
      } else {
        log(`  [SKIP] ${member.name} enrollment failed`);
      }

      await sleep(OP_DELAY);
    }

    log(`\nEnrolled ${memberWallets.size} / ${memberIndices.length} members`);

    // ─── Phase 3: Credential Generation ────────────
    header('Phase 3: Credential Generation');

    for (const [memberIdx, walletId] of memberWallets) {
      const member = MEMBERS[memberIdx];
      await generateCredential(walletId, member.name);
      await sleep(OP_DELAY);
    }

    log(`\nCredentials generated for ${memberWallets.size} members`);
  } else {
    // Load existing state
    header('Loading Existing State');
    const state = await getState();
    const enrolled = state.enrolledMembers || [];
    for (const m of enrolled) {
      const idx = m.memberIndex;
      if (memberIndices.includes(idx)) {
        memberWallets.set(idx, m.walletId);
        log(`Found: ${m.displayName} → ${m.walletId.substring(0, 20)}...`);
      }
    }
    if (memberWallets.size === 0) {
      log('[ERR] No enrolled members found. Run without --skip-setup first.');
      process.exit(1);
    }
  }

  // ─── Phase 4: Random Scenarios ─────────────────
  header(`Phase 4: Random Scenarios (${SCENARIOS_PER_MEMBER} per member)`);

  const results = [];
  let scenarioNum = 0;

  for (const [memberIdx, walletId] of memberWallets) {
    const member = MEMBERS[memberIdx];
    const scenarios = selectScenarios(SCENARIOS_PER_MEMBER);

    header(`${member.name} — ${scenarios.length} scenarios`);

    for (let i = 0; i < scenarios.length; i++) {
      scenarioNum++;
      const scenario = scenarios[i];
      const ctx = { walletId, memberName: member.name, memberIndex: memberIdx };

      log(`\n[Scenario ${scenarioNum}] ${member.name} → ${scenario.name}`);

      try {
        const result = await scenario.fn(ctx);
        results.push({ member: member.name, scenario: scenario.name, result, success: true });
        log(`  Result: ${result}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ member: member.name, scenario: scenario.name, result: msg, success: false });
        log(`  [ERR] ${msg}`);
      }

      await sleep(OP_DELAY);
    }
  }

  // ─── Summary ───────────────────────────────────
  header('Run Summary');

  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success).length;
  log(`Total scenarios: ${results.length}`);
  log(`Successes: ${successes}`);
  log(`Failures: ${failures}`);

  console.log('\nDetailed Results:');
  console.log('─'.repeat(60));
  for (const r of results) {
    const icon = r.success ? 'OK' : 'FAIL';
    console.log(`  [${icon}] ${r.member} / ${r.scenario}: ${r.result}`);
  }
  console.log('─'.repeat(60));

  if (failures > 0) {
    console.log(`\n${failures} scenario(s) had errors — check output above for details.`);
  }

  log('\nDone! Check the visualizer dashboard to review all activity.');
}

// ─── Entry Point ────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
