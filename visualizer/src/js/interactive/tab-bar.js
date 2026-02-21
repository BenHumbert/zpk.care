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
