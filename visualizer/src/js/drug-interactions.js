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

// drug-interactions.js — Drug interaction reference matrix for pharmacy DUR panel
// Based on Adjuda-GATOR seed medication therapeutic classes

// Each interaction: [classA, classB, severity, description]
// severity: 'critical' | 'major' | 'moderate' | 'minor'
export const DRUG_INTERACTIONS = [
  // Critical
  ['Factor Xa Inhibitor Anticoagulant', 'TNF-alpha Inhibitor', 'critical', 'Increased bleeding risk with concurrent anticoagulant and TNF inhibitor use'],
  ['Factor Xa Inhibitor Anticoagulant', 'JAK Inhibitor', 'critical', 'Significantly increased bleeding and thrombotic event risk'],
  ['PD-1 Inhibitor (Immunotherapy)', 'TNF-alpha Inhibitor', 'critical', 'Severe immunosuppression/immune dysregulation risk'],
  ['PD-1 Inhibitor (Immunotherapy)', 'JAK Inhibitor', 'critical', 'Conflicting immune modulation — increased infection risk'],
  ['PD-1 Inhibitor (Immunotherapy)', 'IL-12/23 Inhibitor', 'critical', 'Opposing immunological mechanisms — risk of immune paradox'],

  // Major
  ['ACE Inhibitor', 'ARNI (Heart Failure)', 'major', 'Contraindicated: dual RAAS blockade increases angioedema risk. 36h washout required'],
  ['Biguanide Antidiabetic', 'SGLT2 Inhibitor', 'major', 'Increased risk of diabetic ketoacidosis and lactic acidosis'],
  ['DPP-4 Inhibitor', 'GLP-1 Receptor Agonist', 'major', 'Overlapping incretin mechanism — no additional benefit, increased GI adverse effects'],
  ['JAK Inhibitor', 'TNF-alpha Inhibitor', 'major', 'Dual immunosuppression — significantly increased serious infection risk'],
  ['JAK Inhibitor', 'IL-12/23 Inhibitor', 'major', 'Combined immunosuppression increases opportunistic infection risk'],
  ['TNF-alpha Inhibitor', 'IL-12/23 Inhibitor', 'major', 'Dual biologic immunosuppression — increased infection and malignancy risk'],
  ['Immunomodulatory Agent (Oncology)', 'JAK Inhibitor', 'major', 'Combined immunosuppression with increased toxicity risk'],
  ['Immunomodulatory Agent (Oncology)', 'TNF-alpha Inhibitor', 'major', 'Overlapping immunosuppression — increased infection risk'],

  // Moderate
  ['HMG-CoA Reductase Inhibitor (Statin)', 'Immunomodulatory Agent (Oncology)', 'moderate', 'Increased risk of myopathy/rhabdomyolysis with concurrent use'],
  ['ACE Inhibitor', 'SGLT2 Inhibitor', 'moderate', 'Additive hypotensive effect — monitor blood pressure'],
  ['Proton Pump Inhibitor', 'Thyroid Hormone', 'moderate', 'PPI reduces absorption of levothyroxine — separate dosing by 4+ hours'],
  ['Proton Pump Inhibitor', 'Biguanide Antidiabetic', 'moderate', 'PPI may increase metformin absorption — monitor blood glucose'],
  ['Factor Xa Inhibitor Anticoagulant', 'Proton Pump Inhibitor', 'moderate', 'PPI may alter anticoagulant absorption — monitor INR equivalent'],
  ['CNS Stimulant', 'Short-Acting Beta-2 Agonist (SABA)', 'moderate', 'Additive cardiovascular stimulation — monitor heart rate'],
  ['GLP-1 Receptor Agonist', 'SGLT2 Inhibitor', 'moderate', 'Combined use increases hypoglycemia risk — monitor closely'],

  // Minor
  ['Aminopenicillin Antibiotic', 'Proton Pump Inhibitor', 'minor', 'PPI may slightly reduce amoxicillin absorption — generally not clinically significant'],
  ['Thyroid Hormone', 'HMG-CoA Reductase Inhibitor (Statin)', 'minor', 'Hypothyroidism may increase statin sensitivity — monitor CK levels'],
];

// Check interactions between a list of active medications
// activeMeds: array of {therapeuticClass: string, brandName: string, ...}
// Returns: array of {medA, medB, severity, description}
export function checkInteractions(activeMeds) {
  const alerts = [];
  for (let i = 0; i < activeMeds.length; i++) {
    for (let j = i + 1; j < activeMeds.length; j++) {
      const classA = activeMeds[i].therapeuticClass;
      const classB = activeMeds[j].therapeuticClass;
      if (!classA || !classB) continue;

      for (const [c1, c2, severity, description] of DRUG_INTERACTIONS) {
        if ((classA === c1 && classB === c2) || (classA === c2 && classB === c1)) {
          alerts.push({
            medA: activeMeds[i].brandName || activeMeds[i].ndcHash,
            medB: activeMeds[j].brandName || activeMeds[j].ndcHash,
            classA, classB,
            severity,
            description,
          });
        }
      }
    }
  }
  // Sort: critical first, then major, moderate, minor
  const order = { critical: 0, major: 1, moderate: 2, minor: 3 };
  alerts.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
  return alerts;
}

// Get overall DUR status from interaction alerts
export function getDurStatus(alerts) {
  if (alerts.some(a => a.severity === 'critical')) return 'red';
  if (alerts.some(a => a.severity === 'major')) return 'red';
  if (alerts.some(a => a.severity === 'moderate')) return 'amber';
  if (alerts.some(a => a.severity === 'minor')) return 'amber';
  return 'green';
}

// Render DUR status badge
export function renderDurBadge(status) {
  const labels = { green: 'No Interactions', amber: 'Potential Interactions', red: 'Interactions Found' };
  return `<span class="dur-status dur-${status}">${labels[status]}</span>`;
}

// Render interaction alert cards
export function renderInteractionAlerts(alerts) {
  if (alerts.length === 0) {
    return `<div style="color: var(--accent-green); padding: 12px; text-align: center;">No drug interactions detected</div>`;
  }
  return alerts.map(a => `
    <div class="dur-alert-card dur-alert-${a.severity}">
      <div class="dur-alert-header">
        <span class="badge badge-${a.severity === 'critical' || a.severity === 'major' ? 'reversal' : 'pending'}">${a.severity.toUpperCase()}</span>
        <span>${a.medA} + ${a.medB}</span>
      </div>
      <div class="dur-alert-body">${a.description}</div>
    </div>
  `).join('');
}
