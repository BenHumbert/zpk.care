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
 * Where each dashboard of a local network is, and which token it asks for. The tokens are the local profile's
 * (`.zpk/local.env`): a page asks once, in the tab named here, and keeps it. `npm run setup` and `npm run tokens` print
 * the values; `npm start` prints the table without them.
 */
import { DEFAULT_EXPLORER_PORT, HR_TOOL_PORT } from './profile.js';

export interface Dashboard {
  name: string;
  url: string;
  asks: string;
  /** the local env name of the token the page asks for, if any */
  token?: string;
}

export function dashboards(env: Record<string, string | undefined>): Dashboard[] {
  const explorer = Number(env.ZKTRIDENT_EXPLORER_PORT) || DEFAULT_EXPLORER_PORT;
  return [
    { name: 'Insurer (the plan)', url: 'http://localhost:4004/', asks: 'Admin tab, Admin Token', token: 'ZKTRIDENT_INSURER_ADMIN_TOKEN' },
    { name: 'Marketplace (employers)', url: 'http://localhost:4004/marketplace/', asks: 'nothing; activation shows the employer node and its token once' },
    { name: 'HR Tool (the employer)', url: `http://localhost:${HR_TOOL_PORT}/`, asks: 'the employer node URL and token from activation, and a passphrase you choose' },
    { name: 'Member (the phone)', url: 'http://localhost:4001/', asks: 'a device PIN you choose; the enrollment PIN is in `npm run texts`' },
    { name: 'Prescriber', url: 'http://localhost:4002/', asks: 'Onboarding tab, Node admin token (for a patient\'s own price)', token: 'ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN' },
    { name: 'Pharmacy', url: 'http://localhost:4003/', asks: 'nothing' },
    { name: 'Sequencer', url: 'http://localhost:3030/', asks: 'Config & Admin tab, Admin Token', token: 'ZKTRIDENT_ADMIN_TOKEN' },
    { name: 'Explorer', url: `http://localhost:${explorer}/`, asks: 'nothing' },
  ];
}

/** The dashboard table; with `showTokens`, each token's value under its row. */
export function guideText(env: Record<string, string | undefined>, showTokens: boolean): string {
  const rows = dashboards(env);
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const urlWidth = Math.max(...rows.map((r) => r.url.length));
  const lines = ['', '  Dashboards', ''];
  for (const r of rows) {
    lines.push(`  ${r.name.padEnd(nameWidth)}  ${r.url.padEnd(urlWidth)}  ${r.asks}`);
    if (showTokens && r.token) lines.push(`  ${''.padEnd(nameWidth)}  ${''.padEnd(urlWidth)}  ${r.token} = ${env[r.token] ?? '(not set)'}`);
  }
  lines.push(
    '',
    "  Sample files: .zpk/samples/roster.csv (the HR Tool's import) and .zpk/samples/sample-ein-letter.pdf (the marketplace's upload).",
    showTokens ? '  These tokens are for this machine only; `npm run tokens` shows them again.' : '  `npm run tokens` shows the tokens; `npm run texts` shows the PINs the HR Tool texted.',
    '',
  );
  return lines.join('\n');
}
