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
 * Tab Bar — Horizontal role-based navigation (Member, Prescriber, Insurer, Pharmacy).
 *
 * All tabs are always clickable — no locking or sequential progression.
 */

export class TabBar {
  constructor(onTabChange) {
    this.onTabChange = onTabChange;
    this.tabs = ['member', 'prescriber', 'insurer', 'pharmacy', 'reports', 'l2chain'];
    this.tabElements = {};
    this.activeTab = 'member';

    this.init();
  }

  init() {
    for (const tab of this.tabs) {
      const el = document.querySelector(`.tab-item[data-tab="${tab}"]`);
      this.tabElements[tab] = el;
      el.addEventListener('click', () => this.switchTo(tab));
    }
  }

  switchTo(tab) {
    if (tab === this.activeTab) return;

    // Deactivate all
    for (const t of this.tabs) {
      this.tabElements[t].classList.remove('active');
    }
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    // Activate selected
    this.tabElements[tab].classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
    this.activeTab = tab;

    this.onTabChange(tab);
  }

  getActiveTab() {
    return this.activeTab;
  }

  reset() {
    // Reset to member tab without triggering onTabChange
    for (const t of this.tabs) {
      this.tabElements[t].classList.remove('active');
    }
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    this.tabElements['member'].classList.add('active');
    document.getElementById('tab-member').classList.add('active');
    this.activeTab = 'member';
  }
}
