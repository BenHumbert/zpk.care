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
 * Interactive App — Browser entry point for the adjudication engine.
 *
 * Connects to the backend, manages phase state machine,
 * dispatches UI updates to phase modules.
 */

export const API_BASE = 'http://127.0.0.1:3030';

export function formatCents(cents) {
  return '$' + (cents / 100).toFixed(2);
}

// ─── Shared ZK Rendering Helpers ──────────────────────────

const CREDENTIAL_TYPE_LABELS = { '1': 'ELIGIBILITY', '2': 'PRESCRIPTION' };
const FOREST_DOMAIN_LABELS = {
  memberRoot: 'MEMBER',
  prescriberRoot: 'PRESCRIBER',
  pharmacyRoot: 'PHARMACY',
  medicationRoot: 'MEDICATION',
  accessControlRoot: 'ACCESS_CONTROL',
  transactionRoot: 'TRANSACTION',
};

/**
 * Update the persistent chain state panel with CareContract's 8 on-chain slots.
 */
export function updateChainState(chainState) {
  const body = document.getElementById('chain-state-body');
  if (!body || !chainState) return;

  body.innerHTML = `
    <div class="chain-state-grid">
      <div class="cs-label">walletRegistryRoot</div>
      <div class="cs-value">${chainState.walletRegistryRoot}</div>
      <div class="cs-label">walletCount</div>
      <div class="cs-value">${chainState.walletCount}</div>
      <div class="cs-label">adminPublicKeyHash</div>
      <div class="cs-value">${chainState.adminPublicKeyHash}</div>
      <div class="cs-label">lifecycleRoot</div>
      <div class="cs-value">${chainState.lifecycleRoot}</div>
      <div class="cs-label">benefitPlanRoot</div>
      <div class="cs-value">${chainState.benefitPlanRoot}</div>
      <div class="cs-label">credentialRegistryRoot</div>
      <div class="cs-value">${chainState.nftRegistryRoot}</div>
      <div class="cs-label">eligibilityVkHash</div>
      <div class="cs-value">${chainState.eligibilityVkHash}</div>
      <div class="cs-label">messagingRoot</div>
      <div class="cs-value">${chainState.messagingRoot}</div>
    </div>
  `;
}

/**
 * Render a collapsible credential card with all 7 fields + commitment.
 */
export function renderCredentialCard(title, nftData, colorClass) {
  if (!nftData) return '';
  const typeLabel = CREDENTIAL_TYPE_LABELS[nftData.nftType] || nftData.nftType;
  return `
    <div class="zk-section collapsed">
      <div class="zk-section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
        <span style="color: var(--color-${colorClass});">${title}</span>
        <span class="zk-arrow">&#9660;</span>
      </div>
      <div class="zk-section-body">
        <div class="zk-data-grid">
          <div class="zk-label">Credential Type</div><div class="zk-value">${typeLabel} (${nftData.nftType})</div>
          <div class="zk-label">Forest Root</div><div class="zk-value">${nftData.forestRoot}</div>
          <div class="zk-label">Issuer Wallet ID</div><div class="zk-value">${nftData.issuerWalletId}</div>
          <div class="zk-label">Subject Wallet ID</div><div class="zk-value">${nftData.subjectWalletId}</div>
          <div class="zk-label">Issued At</div><div class="zk-value">${nftData.issuedAt}</div>
          <div class="zk-label">Expires At</div><div class="zk-value">${nftData.expiresAt === '0' ? '0 (never)' : nftData.expiresAt}</div>
          <div class="zk-label">Revoked</div><div class="zk-value">${nftData.revoked === '0' ? '0 (active)' : nftData.revoked}</div>
          <div class="zk-label">Credential Commitment</div><div class="zk-value zk-highlight">${nftData.commitment}</div>
        </div>
        <div class="hash-flow">
          <span class="hf-op">Poseidon.hash</span>
          <span class="hf-arrow">(</span>
          <span class="hf-input">7 fields</span>
          <span class="hf-arrow">)</span>
          <span class="hf-arrow">=</span>
          <span class="hf-output">${nftData.commitment}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render a collapsible forest card with 6 domain roots + composite.
 */
export function renderForestCard(title, forestRoots, colorClass) {
  if (!forestRoots) return '';
  const rows = Object.entries(FOREST_DOMAIN_LABELS).map(([key, label]) => `
    <div class="zk-label">${label}</div><div class="zk-value">${forestRoots[key]}</div>
  `).join('');

  return `
    <div class="zk-section collapsed">
      <div class="zk-section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
        <span style="color: var(--color-${colorClass});">${title}</span>
        <span class="zk-arrow">&#9660;</span>
      </div>
      <div class="zk-section-body">
        <div class="zk-data-grid">
          ${rows}
          <div class="zk-label" style="font-weight:700;">Forest Root</div>
          <div class="zk-value zk-highlight">${forestRoots.forestRoot}</div>
        </div>
        <div class="hash-flow">
          <span class="hf-op">Poseidon.hash</span>
          <span class="hf-arrow">(</span>
          <span class="hf-input">6 tree roots</span>
          <span class="hf-arrow">)</span>
          <span class="hf-arrow">=</span>
          <span class="hf-output">${forestRoots.forestRoot}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render a collapsible data section with arbitrary key-value pairs.
 */
export function renderZkDataSection(title, data, colorClass, commitLabel, commitValue) {
  if (!data) return '';
  const rows = Object.entries(data).map(([key, val]) => `
    <div class="zk-label">${key}</div><div class="zk-value">${val}</div>
  `).join('');

  const hashFlow = commitLabel ? `
    <div class="hash-flow">
      <span class="hf-op">Poseidon.hash</span>
      <span class="hf-arrow">(</span>
      <span class="hf-input">${commitLabel}</span>
      <span class="hf-arrow">)</span>
      <span class="hf-arrow">=</span>
      <span class="hf-output">${commitValue || ''}</span>
    </div>
  ` : '';

  return `
    <div class="zk-section collapsed">
      <div class="zk-section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
        <span style="color: var(--color-${colorClass});">${title}</span>
        <span class="zk-arrow">&#9660;</span>
      </div>
      <div class="zk-section-body">
        <div class="zk-data-grid">
          ${rows}
        </div>
        ${hashFlow}
      </div>
    </div>
  `;
}

// ─── App ──────────────────────────────────────────────────

import { ConsolePanel } from './interactive/console-panel.js';
import { TabBar } from './interactive/tab-bar.js';
import { MemberPhase } from './interactive/member-phase.js';
import { PrescriberPhase } from './interactive/prescriber-phase.js';
import { InsurerTab } from './interactive/insurer-tab.js';
import { PharmacyPhase } from './interactive/pharmacy-phase.js';
import { ReportsTab } from './interactive/reports-tab.js';
import { L2ChainTab } from './interactive/l2-chain-tab.js';
// B1: the operator's token on every /interactive/ request, and one way to load state.
import './interactive/operator-auth.js';
import { loadInteractiveState } from './interactive/state-client.js';

class InteractiveApp {
  constructor() {
    this.console = new ConsolePanel();
    this.tabBar = new TabBar((tab) => this.onTabChange(tab));
    this.memberPhase = new MemberPhase(this);
    this.prescriberPhase = new PrescriberPhase(this);
    this.insurerTab = new InsurerTab(this);
    this.pharmacyPhase = new PharmacyPhase(this);
    this.reportsTab = new ReportsTab(this);
    this.l2ChainTab = new L2ChainTab(this);

    // Shared state
    this.enrollmentResult = null;
    this.state = null;
    this.compiled = false;

    this.init();
  }

  async init() {
    // Reset button
    document.getElementById('btn-reset').addEventListener('click', () => this.doReset());

    // Chain state toggle
    document.getElementById('chain-state-toggle').addEventListener('click', () => {
      document.getElementById('chain-state-panel').classList.toggle('collapsed');
    });

    // Phase 1: Wait for server to be reachable (not compiled, just responding)
    await this.waitForServerUp();

    // Phase 2: Fetch state and render immediately (even during compilation)
    await this.fetchState();
    if (this.state) {
      this.memberPhase.render(this.state);
      document.getElementById('btn-reset').disabled = false;
      // Show initial chain state if available
      if (this.state.chainState) {
        updateChainState(this.state.chainState);
      }
    }

    // Phase 3: If not compiled yet, poll in the background until compiled
    if (!this.compiled) {
      this.pollForCompilation();
    } else {
      this.startBackgroundPoll();
    }
  }

  /**
   * Wait until the server responds to ANY request (may not be compiled yet).
   */
  async waitForServerUp() {
    this.setStatus('compiling', 'Waiting for server...');

    for (let i = 0; i < 120; i++) { // 2 minutes max for server to start
      try {
        const data = await loadInteractiveState(API_BASE);
        if (data) {
          this.state = data;
          if (data.compiled) {
            this.compiled = true;
            this.setStatus('ready', 'Ready');
          } else {
            this.setStatus('compiling', 'Compiling ZkPrograms...');
          }
          return; // Server is up
        }
      } catch {
        // Server not up yet — connection refused
      }

      // Update status with countdown
      if (i > 0 && i % 5 === 0) {
        this.setStatus('compiling', `Waiting for server... (${i}s)`);
      }
      await sleep(1000);
    }

    this.setStatus('ready', 'Server not responding');
  }

  /**
   * Background polling — waits for compilation to finish, then enables actions.
   */
  async pollForCompilation() {
    this.setStatus('compiling', 'Compiling ZkPrograms...');

    for (let i = 0; i < 600; i++) { // 10 minutes max
      await sleep(2000);
      try {
        const data = await loadInteractiveState(API_BASE);
        if (data) {
          if (data.compiled) {
            this.compiled = true;
            this.state = data;
            this.setStatus('ready', 'Ready');
            // Re-enable any disabled enroll buttons
            const btn = document.getElementById('btn-enroll');
            if (btn && btn.dataset.waitingCompile === 'true') {
              btn.disabled = false;
              btn.dataset.waitingCompile = '';
              btn.innerHTML = '<span class="spinner"></span> <span class="btn-text">Begin Enrollment</span>';
            }
            this.startBackgroundPoll();
            return;
          }
        }
      } catch {
        // Server might have restarted
      }
    }
  }

  async fetchState() {
    // B1: the state as the operator, with the fixture directory attached (state-client.js).
    const state = await loadInteractiveState(API_BASE);
    if (state) {
      this.state = state;
      this.compiled = this.state.compiled;
    }
  }

  /**
   * Background state poll — checks for new enrollments, batch updates, etc.
   * every 10 seconds. Only re-renders when the state actually changes
   * (enrolled count, Rx count, batch count) to avoid disrupting user input.
   */
  startBackgroundPoll() {
    let lastEnrolledCount = this.state?.enrolled?.length ?? 0;
    let lastRxCount = this.state?.prescriptions?.length ?? 0;
    let lastBatchCount = this.state?.chainState?.totalBatchesBuilt ?? 0;
    let lastFulfillmentCount = this.state?.fulfillments?.length ?? 0;

    setInterval(async () => {
      await this.fetchState();
      if (!this.state) return;

      const enrolledCount = this.state.enrolled?.length ?? 0;
      const rxCount = this.state.prescriptions?.length ?? 0;
      const batchCount = this.state.chainState?.totalBatchesBuilt ?? 0;
      const fulfillmentCount = this.state.fulfillments?.length ?? 0;

      const changed = enrolledCount !== lastEnrolledCount
        || rxCount !== lastRxCount
        || batchCount !== lastBatchCount
        || fulfillmentCount !== lastFulfillmentCount;

      if (changed) {
        lastEnrolledCount = enrolledCount;
        lastRxCount = rxCount;
        lastBatchCount = batchCount;
        lastFulfillmentCount = fulfillmentCount;

        // Re-render the active tab
        const tab = this.tabBar.getActiveTab();
        if (tab === 'member') this.memberPhase.render(this.state);
        else if (tab === 'prescriber') this.prescriberPhase.render(this.state);
        else if (tab === 'insurer') this.insurerTab.render(this.state);
        else if (tab === 'pharmacy') this.pharmacyPhase.render(this.state);
        else if (tab === 'reports') this.reportsTab.render(this.state);
        else if (tab === 'l2chain') this.l2ChainTab.render(this.state);

        if (this.state.chainState) {
          updateChainState(this.state.chainState);
        }
      }
    }, 10_000);
  }

  onTabChange(tab) {
    if (!this.state) return;
    this.fetchState().then(() => {
      if (tab === 'member') this.memberPhase.render(this.state);
      else if (tab === 'prescriber') this.prescriberPhase.render(this.state);
      else if (tab === 'insurer') this.insurerTab.render(this.state);
      else if (tab === 'pharmacy') this.pharmacyPhase.render(this.state);
      else if (tab === 'reports') this.reportsTab.render(this.state);
      else if (tab === 'l2chain') this.l2ChainTab.render(this.state);
    });
  }

  setStatus(type, text) {
    const dot = document.getElementById('status-indicator');
    const label = document.getElementById('status-text');
    dot.className = `status-dot ${type}`;
    label.textContent = text;
  }

  isCompiled() {
    return this.compiled;
  }

  async doReset() {
    this.setStatus('working', 'Resetting...');

    try {
      await fetch(`${API_BASE}/interactive/reset`, { method: 'POST' });
      this.enrollmentResult = null;
      await this.fetchState();
      this.tabBar.reset();
      this.memberPhase.render(this.state);
      if (this.state && this.state.chainState) {
        updateChainState(this.state.chainState);
      }
      this.setStatus('ready', 'Ready');
    } catch (err) {
      console.error('Reset failed:', err);
      this.setStatus('ready', 'Reset failed');
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Boot
new InteractiveApp();
