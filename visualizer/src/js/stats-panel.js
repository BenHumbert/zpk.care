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
 * StatsPanel — Counter cards, Chart.js charts, and accumulator progress bars.
 */

import { createTierChart, createCumulativeChart, createCostChart } from './charts.js';
import { formatTime } from './utils.js';

export class StatsPanel {
  constructor() {
    this.init();
  }

  init() {
    this.enrolled = 0;
    this.claims = 0;
    this.messages = 0;
    this.settled = 0;
    this.totalPatientPay = 0;
    this.totalPlanPay = 0;

    // Tier counts
    this.tierCounts = [0, 0, 0, 0];

    // Cost data per claim
    this.claimLabels = [];
    this.patientPayData = [];
    this.planPayData = [];

    // Cumulative timeline
    this.timeLabels = [];
    this.enrollCumulative = [];
    this.claimCumulative = [];
    this.messageCumulative = [];

    // Accumulators per member
    this.accumulators = new Map();

    // Reset DOM counters
    for (const id of ['stat-enrolled', 'stat-claims', 'stat-messages', 'stat-settled']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '0';
    }
    const accumPanel = document.getElementById('accumulator-panel');
    if (accumPanel) accumPanel.innerHTML = '';

    // Charts (destroy old + recreate)
    if (this.tierChart) { this.tierChart.destroy(); this.tierChart = null; }
    if (this.cumulativeChart) { this.cumulativeChart.destroy(); this.cumulativeChart = null; }
    if (this.costChart) { this.costChart.destroy(); this.costChart = null; }

    this.initCharts();
  }

  initCharts() {
    const tierCanvas = document.getElementById('chart-tiers');
    const cumulCanvas = document.getElementById('chart-cumulative');
    const costCanvas = document.getElementById('chart-costs');

    if (tierCanvas) this.tierChart = createTierChart(tierCanvas);
    if (cumulCanvas) this.cumulativeChart = createCumulativeChart(cumulCanvas);
    if (costCanvas) this.costChart = createCostChart(costCanvas);
  }

  /** Handle a viz event and update stats */
  handleEvent(event) {
    if (!event.type?.startsWith('viz:')) return;

    const timeLabel = formatTime(event.timestamp || Date.now());

    switch (event.type) {
      case 'viz:enrollment:complete':
        if (event.data?.lifecycle === 'ELIGIBLE') {
          this.enrolled++;
          this.updateCounter('stat-enrolled', this.enrolled);
          this.pushCumulative(timeLabel);
        }
        break;

      case 'viz:fulfillment:settled': {
        this.claims++;
        this.updateCounter('stat-claims', this.claims);

        const tier = event.data?.tier;
        if (tier >= 1 && tier <= 4) {
          this.tierCounts[tier - 1]++;
          this.updateTierChart();
        }

        const patientCents = event.data?.patientPayCents || 0;
        const planCents = event.data?.planPayCents || 0;
        this.totalPatientPay += patientCents;
        this.totalPlanPay += planCents;

        const drugLabel = event.data?.drug || `Claim ${this.claims}`;
        this.claimLabels.push(drugLabel);
        this.patientPayData.push(patientCents);
        this.planPayData.push(planCents);
        this.updateCostChart();

        this.pushCumulative(timeLabel);
        break;
      }

      case 'viz:message:sent':
        this.messages++;
        this.updateCounter('stat-messages', this.messages);
        this.pushCumulative(timeLabel);
        break;

      case 'viz:batch:settled':
        if (event.data?.l1TxHash) {
          this.settled++;
          this.updateCounter('stat-settled', this.settled);
        }
        break;

      case 'viz:accumulator:updated':
        this.updateAccumulatorPanel(event);
        break;
    }
  }

  updateCounter(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  updateTierChart() {
    if (!this.tierChart) return;
    this.tierChart.data.datasets[0].data = [...this.tierCounts];
    this.tierChart.update('none');
  }

  updateCostChart() {
    if (!this.costChart) return;
    this.costChart.data.labels = [...this.claimLabels];
    this.costChart.data.datasets[0].data = [...this.patientPayData];
    this.costChart.data.datasets[1].data = [...this.planPayData];
    this.costChart.update('none');
  }

  pushCumulative(timeLabel) {
    this.timeLabels.push(timeLabel);
    this.enrollCumulative.push(this.enrolled);
    this.claimCumulative.push(this.claims);
    this.messageCumulative.push(this.messages);

    if (!this.cumulativeChart) return;
    this.cumulativeChart.data.labels = [...this.timeLabels];
    this.cumulativeChart.data.datasets[0].data = [...this.enrollCumulative];
    this.cumulativeChart.data.datasets[1].data = [...this.claimCumulative];
    this.cumulativeChart.data.datasets[2].data = [...this.messageCumulative];
    this.cumulativeChart.update('none');
  }

  updateAccumulatorPanel(event) {
    const member = event.data?.member || event.target || 'Unknown';
    const panel = document.getElementById('accumulator-panel');
    if (!panel) return;

    // Parse accumulator data
    const dedPaid = event.data?.deductiblePaid || '$0.00';
    const dedMax = event.data?.deductibleMax || '$500.00';
    const oopPaid = event.data?.oopPaid || '$0.00';
    const oopMax = event.data?.oopMax || '$3,000.00';

    const parseDollar = (s) => parseFloat(s.replace(/[$,]/g, ''));
    const dedPaidVal = parseDollar(dedPaid);
    const dedMaxVal = parseDollar(dedMax);
    const oopPaidVal = parseDollar(oopPaid);
    const oopMaxVal = parseDollar(oopMax);

    // Store
    this.accumulators.set(member, { dedPaidVal, dedMaxVal, oopPaidVal, oopMaxVal });

    // Rebuild panel
    panel.innerHTML = '';
    for (const [name, acc] of this.accumulators) {
      // Deductible row
      panel.appendChild(this.makeAccumRow(
        `${name} — Deductible`,
        acc.dedPaidVal,
        acc.dedMaxVal,
        '#4fc3f7',
      ));
      // OOPM row
      panel.appendChild(this.makeAccumRow(
        `${name} — OOPM`,
        acc.oopPaidVal,
        acc.oopMaxVal,
        '#ffa726',
      ));
    }
  }

  makeAccumRow(label, paid, max, color) {
    const pct = max > 0 ? Math.min(100, (paid / max) * 100) : 0;

    const row = document.createElement('div');
    row.className = 'accum-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'accum-label';
    labelEl.textContent = label;

    const barContainer = document.createElement('div');
    barContainer.className = 'accum-bar-container';

    const fill = document.createElement('div');
    fill.className = 'accum-bar-fill';
    fill.style.width = `${pct}%`;
    fill.style.background = color;

    const text = document.createElement('div');
    text.className = 'accum-bar-text';
    text.textContent = `$${paid.toFixed(2)} / $${max.toFixed(2)}`;

    barContainer.appendChild(fill);
    barContainer.appendChild(text);
    row.appendChild(labelEl);
    row.appendChild(barContainer);
    return row;
  }
}
