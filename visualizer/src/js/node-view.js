/**
 * NodeView — Per-node lifecycle/activity card view.
 *
 * Three sections:
 *   1. Member Nodes — lifecycle stage badges (enrollment → fulfillment)
 *   2. Prescriber Nodes — activity counters (Rx written, eScripts, PA)
 *   3. Pharmacy Nodes — activity counters (Rx received, fills, settled)
 *
 * Each card shows a Poseidon wallet derivation animation on creation,
 * demonstrating how the ZK wallet ID is computed from PHI field hashes.
 *
 * A batch/settlement panel sits at the top showing L2 sequencer activity.
 */

import { toOpaqueId, formatTime, LANE_COLORS, ACTOR_COLORS } from './utils.js';

// ─── Wallet domain info for derivation visual ────────

const WALLET_DOMAINS = {
  member: {
    tag: 0,
    label: 'MEMBER',
    inputs: ['cardholderIdHash', 'dob', 'firstNameHash', 'lastNameHash', 'enrollmentKeyHash'],
    description: 'Patient identity fields hashed on device',
  },
  prescriber: {
    tag: 1,
    label: 'PRESCRIBER',
    inputs: ['npiHash', 'deaHash', 'enrollmentKeyHash'],
    description: 'NPI + DEA hashed locally',
  },
  pharmacy: {
    tag: 2,
    label: 'PHARMACY',
    inputs: ['ncpdpHash', 'npiHash', 'enrollmentKeyHash'],
    description: 'NCPDP + NPI hashed locally',
  },
};

// ─── Colors for node types ───────────────────────────

const NODE_COLORS = {
  member: '#4fc3f7',
  prescriber: '#66bb6a',
  pharmacy: '#ffa726',
};

// ─── Member lifecycle stage definitions ──────────────

const MEMBER_SECTIONS = [
  {
    id: 'enrollment',
    label: 'Enrollment',
    icon: '\u{1F4CB}',
    stages: ['Token Gen', 'Token Used', 'Enrolling', 'Credential Issued', 'ELIGIBLE'],
  },
  {
    id: 'eligibility',
    label: 'Eligibility',
    icon: '\u{2705}',
    stages: ['Check', 'Verified', 'Formulary', 'On Formulary'],
  },
  {
    id: 'prescription',
    label: 'Prescription',
    icon: '\u{1F48A}',
    stages: ['Written', 'eScript Sent', 'Received', 'ACTIVE'],
  },
  {
    id: 'fulfillment',
    label: 'Fulfillment',
    icon: '\u{1F4B0}',
    stages: ['Fill Started', 'Settled', 'Accum Updated', 'Batched', 'L1 Settled'],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    icon: '\u{1F4E8}',
    stages: ['Sent', 'Received'],
  },
];

// ─── Provider activity metric definitions ────────────

const PRESCRIBER_METRICS = [
  { id: 'rxWritten',   label: 'Rx Written',    icon: '\u{1F48A}' },
  { id: 'eScriptsSent', label: 'eScripts Sent', icon: '\u{1F4E4}' },
  { id: 'paRequests',  label: 'PA Requests',   icon: '\u{1F510}' },
  { id: 'messages',    label: 'Messages',      icon: '\u{1F4E8}' },
];

const PHARMACY_METRICS = [
  { id: 'rxReceived',    label: 'Rx Received',    icon: '\u{1F48A}' },
  { id: 'fillsStarted',  label: 'Fills Started',  icon: '\u{2697}\u{FE0F}' },
  { id: 'claimsSettled', label: 'Claims Settled', icon: '\u{2705}' },
  { id: 'messages',      label: 'Messages',       icon: '\u{1F4E8}' },
];

// ─── NodeView Class ──────────────────────────────────

export class NodeView {
  constructor(containerEl) {
    this.container = containerEl;
    this.members = new Map();
    this.prescribers = new Map();
    this.pharmacies = new Map();
    this.batches = [];
    this.batchPanelEl = null;
    this.batchListEl = null;
    this.memberGridEl = null;
    this.prescriberGridEl = null;
    this.pharmacyGridEl = null;

    this.init();
  }

  init() {
    this.members = new Map();
    this.prescribers = new Map();
    this.pharmacies = new Map();
    this.batches = [];
    this.container.innerHTML = '';

    // ── Batch/Settlement Panel ──
    const batchPanel = document.createElement('div');
    batchPanel.className = 'nv-batch-panel';

    const batchHeader = document.createElement('div');
    batchHeader.className = 'nv-batch-header';
    batchHeader.innerHTML = `
      <div class="nv-batch-title">
        <span class="nv-batch-icon">\u{1F4E6}</span>
        <span>L2 Batch Settlement</span>
        <span class="nv-batch-actor">Adjuda-GATOR PBM</span>
      </div>
      <div class="nv-batch-proof" id="nv-batch-proof">Waiting for batches...</div>
    `;
    batchPanel.appendChild(batchHeader);

    const batchList = document.createElement('div');
    batchList.className = 'nv-batch-list';
    batchPanel.appendChild(batchList);
    this.batchListEl = batchList;
    this.batchPanelEl = batchPanel;

    this.container.appendChild(batchPanel);

    // ── Section Grids ──
    this.memberGridEl = this.createGridSection('Member Nodes', 'member');
    this.prescriberGridEl = this.createGridSection('Prescriber Nodes', 'prescriber');
    this.pharmacyGridEl = this.createGridSection('Pharmacy Nodes', 'pharmacy');
  }

  /** Create a labeled grid section with a header */
  createGridSection(title, type) {
    const section = document.createElement('div');
    section.className = 'nv-grid-section';

    const header = document.createElement('div');
    header.className = `nv-grid-header nv-grid-header-${type}`;
    header.innerHTML = `
      <span class="nv-grid-dot" style="background: ${NODE_COLORS[type]}"></span>
      <span class="nv-grid-title">${title}</span>
      <span class="nv-grid-count" id="nv-count-${type}">0</span>
    `;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'nv-member-grid';
    section.appendChild(grid);

    this.container.appendChild(section);
    return grid;
  }

  /** Update the count badge in a section header */
  updateSectionCount(type, count) {
    const el = document.getElementById(`nv-count-${type}`);
    if (el) el.textContent = String(count);
  }

  // ── Event Routing ─────────────────────────────────

  handleEvent(event) {
    if (!event.type?.startsWith('viz:')) return;

    // Batch events go to the top panel
    if (event.lane === 'batch') {
      this.handleBatchEvent(event);
      return;
    }

    // Route to member card
    const memberName = this.resolveMember(event);
    if (memberName) {
      let card = this.members.get(memberName);
      if (!card) {
        card = this.createMemberCard(memberName);
        this.members.set(memberName, card);
        this.updateSectionCount('member', this.members.size);
      }
      this.advanceMemberCard(card, event);
    }

    // Route to prescriber card
    const prescriberName = this.resolveByType(event, 'prescriber');
    if (prescriberName) {
      let card = this.prescribers.get(prescriberName);
      if (!card) {
        card = this.createProviderCard(prescriberName, 'prescriber');
        this.prescribers.set(prescriberName, card);
        this.updateSectionCount('prescriber', this.prescribers.size);
      }
      this.updateProviderActivity(card, event);
    }

    // Route to pharmacy card
    const pharmacyName = this.resolveByType(event, 'pharmacy');
    if (pharmacyName) {
      let card = this.pharmacies.get(pharmacyName);
      if (!card) {
        card = this.createProviderCard(pharmacyName, 'pharmacy');
        this.pharmacies.set(pharmacyName, card);
        this.updateSectionCount('pharmacy', this.pharmacies.size);
      }
      this.updateProviderActivity(card, event);
    }
  }

  /** Find the member an event relates to */
  resolveMember(event) {
    if (event.actorType === 'member' && event.actor) return event.actor;
    if (event.targetType === 'member' && event.target) return event.target;
    if (event.data?.member) return event.data.member;
    return null;
  }

  /** Find an actor/target of a specific type */
  resolveByType(event, type) {
    if (event.actorType === type && event.actor) return event.actor;
    if (event.targetType === type && event.target) return event.target;
    return null;
  }

  // ── Wallet Derivation Visual ──────────────────────

  /** Create a wallet derivation animation element */
  createWalletDerivation(type, hash) {
    const domain = WALLET_DOMAINS[type];
    if (!domain) return null;

    const el = document.createElement('div');
    el.className = 'nv-derive';

    const inputList = domain.inputs.join(', ');
    el.innerHTML = `
      <div class="nv-derive-line nv-derive-computing">Computing wallet ID...</div>
      <div class="nv-derive-line">
        Domain: <span class="nv-derive-tag">${domain.label} (${domain.tag})</span>
        <span class="nv-derive-desc">${domain.description}</span>
      </div>
      <div class="nv-derive-line nv-derive-hash-line">
        Poseidon.hash([<span class="nv-derive-fields">${inputList}</span>])
      </div>
      <div class="nv-derive-line nv-derive-result">\u{2192} ${hash}</div>
    `;

    // Animate: expand after next frame, collapse after 5 seconds
    requestAnimationFrame(() => {
      el.classList.add('nv-derive-visible');
    });

    setTimeout(() => {
      el.classList.remove('nv-derive-visible');
    }, 5000);

    return el;
  }

  // ── Member Card ───────────────────────────────────

  createMemberCard(name) {
    const walletHash = toOpaqueId(name);

    const el = document.createElement('div');
    el.className = 'nv-card nv-card-member';

    // Header
    const header = document.createElement('div');
    header.className = 'nv-card-header';
    header.innerHTML = `
      <div class="nv-card-name" style="color: ${NODE_COLORS.member}">${this.escapeHtml(name)}</div>
      <div class="nv-card-hash">${walletHash}</div>
    `;
    el.appendChild(header);

    // Wallet derivation animation
    const derive = this.createWalletDerivation('member', walletHash);
    if (derive) el.appendChild(derive);

    // Lifecycle sections
    const sections = {};
    const body = document.createElement('div');
    body.className = 'nv-card-body';

    for (const def of MEMBER_SECTIONS) {
      const section = document.createElement('div');
      section.className = `nv-section nv-section-${def.id}`;

      const sLabel = document.createElement('div');
      sLabel.className = 'nv-section-label';
      sLabel.innerHTML = `<span class="nv-section-icon">${def.icon}</span>${def.label}`;
      section.appendChild(sLabel);

      const stagesRow = document.createElement('div');
      stagesRow.className = 'nv-stages';

      const stageBadges = [];
      for (const stageName of def.stages) {
        const badge = document.createElement('span');
        badge.className = 'nv-stage';
        badge.textContent = stageName;
        stagesRow.appendChild(badge);
        stageBadges.push(badge);
      }

      section.appendChild(stagesRow);
      body.appendChild(section);

      sections[def.id] = {
        el: section,
        badges: stageBadges,
        currentStage: -1,
        msgCount: 0,
      };
    }

    el.appendChild(body);
    this.memberGridEl.appendChild(el);

    return { el, name, sections, walletHash };
  }

  /** Advance a member card based on an event */
  advanceMemberCard(card, event) {
    const lane = event.lane;
    const section = card.sections[lane];
    if (!section) return;

    if (lane === 'messaging') {
      section.msgCount++;
      if (event.type === 'viz:message:sent') {
        this.activateBadge(section.badges[0]);
        this.updateMsgCount(section);
      } else if (event.type === 'viz:message:received') {
        this.activateBadge(section.badges[1]);
        this.updateMsgCount(section);
      }
      return;
    }

    const stageIndex = event.stage;
    if (stageIndex === undefined || stageIndex === null) return;

    // Light up all stages up to and including this one
    for (let i = 0; i <= Math.min(stageIndex, section.badges.length - 1); i++) {
      this.activateBadge(section.badges[i]);
    }

    // If final stage, mark the section as complete
    const totalStages = event.totalStages || section.badges.length;
    if (stageIndex >= totalStages - 1) {
      section.el.classList.add('nv-section-complete');
      const lastBadge = section.badges[Math.min(stageIndex, section.badges.length - 1)];
      if (lastBadge && !lastBadge.textContent.includes('\u2714')) {
        lastBadge.textContent += ' \u2714';
      }
    }

    section.currentStage = Math.max(section.currentStage, stageIndex);
    this.addEventDetail(card, event);
  }

  activateBadge(badge) {
    if (!badge) return;
    if (!badge.classList.contains('nv-stage-active')) {
      badge.classList.add('nv-stage-active');
    }
  }

  updateMsgCount(section) {
    let countEl = section.el.querySelector('.nv-msg-count');
    if (!countEl) {
      countEl = document.createElement('span');
      countEl.className = 'nv-msg-count';
      section.el.querySelector('.nv-stages').appendChild(countEl);
    }
    countEl.textContent = `${section.msgCount} msg`;
  }

  addEventDetail(card, event) {
    const d = event.data || {};
    const section = card.sections[event.lane];
    if (!section) return;

    let detailText = null;

    if (event.type === 'viz:prescription:written') {
      detailText = d.drug || null;
    } else if (event.type === 'viz:fulfillment:settled') {
      detailText = `Patient: ${d.patientPay || ''} / Plan: ${d.planPay || ''}`;
    } else if (event.type === 'viz:accumulator:updated') {
      detailText = `Ded: ${d.deductiblePaid || ''} | OOP: ${d.oopPaid || ''}`;
    }

    if (detailText) {
      let detailEl = section.el.querySelector('.nv-detail');
      if (!detailEl) {
        detailEl = document.createElement('div');
        detailEl.className = 'nv-detail';
        section.el.appendChild(detailEl);
      }
      detailEl.textContent = detailText;
    }
  }

  // ── Provider Card (Prescriber / Pharmacy) ─────────

  createProviderCard(name, type) {
    const walletHash = toOpaqueId(name);
    const metrics = type === 'prescriber' ? PRESCRIBER_METRICS : PHARMACY_METRICS;
    const grid = type === 'prescriber' ? this.prescriberGridEl : this.pharmacyGridEl;

    const el = document.createElement('div');
    el.className = `nv-card nv-card-${type}`;

    // Header
    const header = document.createElement('div');
    header.className = 'nv-card-header';
    header.innerHTML = `
      <div class="nv-card-name" style="color: ${NODE_COLORS[type]}">${this.escapeHtml(name)}</div>
      <div class="nv-card-hash">${walletHash}</div>
    `;
    el.appendChild(header);

    // Wallet derivation animation
    const derive = this.createWalletDerivation(type, walletHash);
    if (derive) el.appendChild(derive);

    // Activity counters
    const body = document.createElement('div');
    body.className = 'nv-card-body';

    const counters = {};
    for (const m of metrics) {
      const row = document.createElement('div');
      row.className = 'nv-activity-row';

      const icon = document.createElement('span');
      icon.className = 'nv-activity-icon';
      icon.textContent = m.icon;

      const label = document.createElement('span');
      label.className = 'nv-activity-label';
      label.textContent = m.label;

      const count = document.createElement('span');
      count.className = 'nv-activity-count';
      count.textContent = '0';

      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(count);
      body.appendChild(row);

      counters[m.id] = { el: count, value: 0 };
    }

    el.appendChild(body);

    // Patients/serving section
    const patientsEl = document.createElement('div');
    patientsEl.className = 'nv-patients';
    el.appendChild(patientsEl);

    // Recent activity
    const recentEl = document.createElement('div');
    recentEl.className = 'nv-recent';
    el.appendChild(recentEl);

    grid.appendChild(el);

    return { el, name, type, counters, patientsEl, recentEl, patients: new Set() };
  }

  // ── Provider Activity Update ──────────────────────

  updateProviderActivity(card, event) {
    // Track patients (members this provider has interacted with)
    const memberName = this.resolveMember(event);
    if (memberName && !card.patients.has(memberName)) {
      card.patients.add(memberName);
      this.renderPatients(card);
    }

    // Increment the right counter based on event type and provider type
    if (card.type === 'prescriber') {
      this.updatePrescriberCounters(card, event);
    } else if (card.type === 'pharmacy') {
      this.updatePharmacyCounters(card, event);
    }

    // Update recent activity
    this.updateRecentActivity(card, event);
  }

  updatePrescriberCounters(card, event) {
    if (event.type === 'viz:prescription:written' && event.actorType === 'prescriber') {
      this.incrementCounter(card.counters.rxWritten);
    } else if (event.type === 'viz:prescription:sent' && event.actorType === 'prescriber') {
      this.incrementCounter(card.counters.eScriptsSent);
    } else if (event.type === 'viz:message:sent' && event.actorType === 'prescriber' &&
               event.data?.messageType?.includes('PA')) {
      this.incrementCounter(card.counters.paRequests);
    } else if ((event.type === 'viz:message:sent' || event.type === 'viz:message:received') &&
               (event.actorType === 'prescriber' || event.targetType === 'prescriber')) {
      this.incrementCounter(card.counters.messages);
    }
  }

  updatePharmacyCounters(card, event) {
    if (event.type === 'viz:prescription:received' && event.actorType === 'pharmacy') {
      this.incrementCounter(card.counters.rxReceived);
    } else if (event.type === 'viz:fulfillment:started' && event.actorType === 'pharmacy') {
      this.incrementCounter(card.counters.fillsStarted);
    } else if (event.type === 'viz:prescription:status' && event.actorType === 'pharmacy' &&
               event.data?.newStatus === 'FILLED') {
      this.incrementCounter(card.counters.claimsSettled);
    } else if ((event.type === 'viz:message:sent' || event.type === 'viz:message:received') &&
               (event.actorType === 'pharmacy' || event.targetType === 'pharmacy')) {
      this.incrementCounter(card.counters.messages);
    }
  }

  incrementCounter(counter) {
    if (!counter) return;
    counter.value++;
    counter.el.textContent = String(counter.value);
    // Pulse animation
    counter.el.classList.remove('nv-counter-pulse');
    void counter.el.offsetWidth; // force reflow for re-animation
    counter.el.classList.add('nv-counter-pulse');
  }

  renderPatients(card) {
    if (!card.patientsEl) return;
    const names = [...card.patients];
    if (names.length === 0) return;

    const label = card.type === 'prescriber' ? 'Patients' : 'Serving';
    const chips = names.map(n =>
      `<span class="nv-patient-chip">${this.escapeHtml(n.split(' ')[0])}</span>`
    ).join('');

    card.patientsEl.innerHTML = `
      <span class="nv-patients-label">${label}:</span>${chips}
    `;
  }

  updateRecentActivity(card, event) {
    if (!card.recentEl) return;
    const d = event.data || {};
    let text = null;

    if (event.type === 'viz:prescription:written') {
      text = `Rx: ${d.drug || ''} #${d.qty || ''}`;
    } else if (event.type === 'viz:fulfillment:started') {
      text = `Filling: ${d.drug || ''}`;
    } else if (event.type === 'viz:prescription:received') {
      text = `Rx from ${d.from || ''}`;
    } else if (event.type === 'viz:prescription:status' && d.newStatus === 'FILLED') {
      text = `Filled: ${d.drug || ''}`;
    }

    if (text) {
      card.recentEl.textContent = text;
    }
  }

  // ── Batch Panel ───────────────────────────────────

  handleBatchEvent(event) {
    const d = event.data || {};
    const batchNum = d.batchNumber || this.batches.length + 1;

    let batch = this.batches.find(b => b.number === batchNum);
    if (!batch) {
      batch = { number: batchNum, status: 'pending', transitions: 0, l1TxHash: null, buildTimeMs: null };
      this.batches.push(batch);
    }

    if (event.type === 'viz:batch:submitted') {
      if (event.stage === 0) {
        batch.status = 'pending';
        batch.transitions = d.pendingCount || d.transitionCount || 0;
      } else if (event.stage === 1) {
        batch.status = 'building';
        batch.transitions = d.transitionCount || batch.transitions;
        batch.buildTimeMs = d.buildTimeMs || null;
      }
    } else if (event.type === 'viz:batch:settled') {
      batch.status = 'settled';
      batch.l1TxHash = d.l1TxHash || null;
      batch.transitions = d.transitionCount || batch.transitions;
    }

    this.renderBatchPanel();
  }

  renderBatchPanel() {
    if (!this.batchListEl) return;
    this.batchListEl.innerHTML = '';

    const proofEl = document.getElementById('nv-batch-proof');

    if (this.batches.length === 0) {
      if (proofEl) proofEl.textContent = 'Waiting for batches...';
      return;
    }

    const settled = this.batches.filter(b => b.status === 'settled');
    const totalTransitions = settled.reduce((sum, b) => sum + b.transitions, 0);

    if (proofEl) {
      proofEl.textContent = `${settled.length} batch${settled.length !== 1 ? 'es' : ''} settled \u2022 ${totalTransitions} transitions rolled up`;
    }

    for (const batch of this.batches) {
      const row = document.createElement('div');
      row.className = `nv-batch-row nv-batch-${batch.status}`;

      const num = document.createElement('span');
      num.className = 'nv-batch-num';
      num.textContent = `Batch #${batch.number}`;

      const info = document.createElement('span');
      info.className = 'nv-batch-info';
      info.textContent = `${batch.transitions} transitions`;

      const status = document.createElement('span');
      status.className = `nv-batch-status nv-batch-status-${batch.status}`;

      if (batch.status === 'settled') {
        status.textContent = `SETTLED \u2714`;
      } else if (batch.status === 'building') {
        status.textContent = 'BUILDING...';
      } else {
        status.textContent = 'PENDING';
      }

      const proof = document.createElement('span');
      proof.className = 'nv-batch-hash';
      if (batch.l1TxHash) {
        proof.textContent = batch.l1TxHash;
      } else if (batch.buildTimeMs) {
        proof.textContent = `${batch.buildTimeMs}ms`;
      }

      row.appendChild(num);
      row.appendChild(info);
      row.appendChild(status);
      row.appendChild(proof);
      this.batchListEl.appendChild(row);
    }
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
