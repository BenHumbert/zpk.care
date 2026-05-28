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
 * Charts — Chart.js wrappers for the dashboard tab.
 */

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#b0b0b0', font: { size: 11 } } },
  },
};

/** Create the tier distribution doughnut chart */
export function createTierChart(canvas) {
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Tier 1 (Generic)', 'Tier 2 (Preferred)', 'Tier 3 (Non-Pref)', 'Tier 4 (Specialty)'],
      datasets: [{
        data: [0, 0, 0, 0],
        backgroundColor: ['#66bb6a', '#4fc3f7', '#ffa726', '#ef5350'],
        borderColor: '#16213e',
        borderWidth: 2,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      cutout: '60%',
    },
  });
}

/** Create the cumulative events line chart */
export function createCumulativeChart(canvas) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Enrollments',
          data: [],
          borderColor: '#1565c0',
          backgroundColor: 'rgba(21,101,192,0.1)',
          fill: true,
          tension: 0.3,
        },
        {
          label: 'Claims',
          data: [],
          borderColor: '#ad1457',
          backgroundColor: 'rgba(173,20,87,0.1)',
          fill: true,
          tension: 0.3,
        },
        {
          label: 'Messages',
          data: [],
          borderColor: '#6a1b9a',
          backgroundColor: 'rgba(106,27,154,0.1)',
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: '#666', maxTicksLimit: 10 }, grid: { color: '#2a2a4a' } },
        y: { ticks: { color: '#666' }, grid: { color: '#2a2a4a' }, beginAtZero: true },
      },
    },
  });
}

/** Create the cost breakdown bar chart */
export function createCostChart(canvas) {
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Patient Pay',
          data: [],
          backgroundColor: '#4fc3f7',
        },
        {
          label: 'Plan Pay',
          data: [],
          backgroundColor: '#ffa726',
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: '#666' }, grid: { color: '#2a2a4a' }, stacked: true },
        y: {
          ticks: {
            color: '#666',
            callback: (v) => `$${(v / 100).toFixed(0)}`,
          },
          grid: { color: '#2a2a4a' },
          stacked: true,
          beginAtZero: true,
        },
      },
    },
  });
}
