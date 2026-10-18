/**
 * The adjudication engine lives in src/, and src/ does not reach back into the visualizer.
 *
 * Plan item B1, step one (2026-10-17). The engine grew inside `visualizer/engine/` and the
 * sequencer boot loaded it by a path string inside a try/catch marked optional. These checks keep
 * the carve-out from regressing: the engine is imported like every other module, nothing under
 * `src/` imports from `visualizer/`, and the reader types the routes depend on have one owner.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function importSpecifiers(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_SPECIFIER)) specs.push(m[1]);
  return specs;
}

describe('engine location (B1, step one)', () => {
  const engineFiles = ['interactive-service.ts', 'interactive-routes.ts', 'proof-pool.ts', 'proof-pool-worker.ts', 'proof-pool-types.ts', 'nfc-port.ts'];

  it('the engine modules are under src/adjudication and no longer under visualizer/engine', () => {
    for (const name of engineFiles) {
      expect(fs.existsSync(path.join(REPO, 'src', 'adjudication', name))).toBe(true);
    }
    for (const name of engineFiles.filter((n) => n !== 'nfc-port.ts')) {
      expect(fs.existsSync(path.join(REPO, 'visualizer', 'engine', name))).toBe(false);
    }
  });

  it('nothing under src/ imports from the visualizer', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(path.join(REPO, 'src'))) {
      for (const spec of importSpecifiers(file)) {
        if (/(^|\/)visualizer(\/|$)/.test(spec)) offenders.push(`${path.relative(REPO, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the sequencer boot imports the engine statically, not by a path string', () => {
    const boot = fs.readFileSync(path.join(REPO, 'src/nodes/start-leviathan.ts'), 'utf8');
    expect(boot).toMatch(/^import \{ AdjudicationService \} from '\.\.\/adjudication\/interactive-service\.js';$/m);
    expect(boot).toMatch(/^import \{ registerInteractiveRoutes \} from '\.\.\/adjudication\/interactive-routes\.js';$/m);
    expect(boot).toMatch(/^import \{ ProofPool \} from '\.\.\/adjudication\/proof-pool\.js';$/m);
    // the boot still lazy-loads a few src modules by literal path; a computed path (an identifier) is what the carve-out removed
    expect(boot).not.toMatch(/await import\(\s*(\/\*[^*]*\*\/\s*)?[A-Za-z_$]/);
    expect(boot).not.toMatch(/visualizer/);
    expect(boot).not.toMatch(/not available \(optional\)/);
  });

  it('the proof-pool worker the boot names is the file beside the pool', () => {
    const boot = fs.readFileSync(path.join(REPO, 'src/nodes/start-leviathan.ts'), 'utf8');
    const m = boot.match(/path\.resolve\(thisDir, '\.\.', 'adjudication', 'proof-pool-worker\.ts'\)/);
    expect(m).not.toBeNull();
    expect(fs.existsSync(path.join(REPO, 'src/adjudication/proof-pool-worker.ts'))).toBe(true);
  });

  it('the routes depend on the reader interface, and the USB bridge implements it', () => {
    const routes = fs.readFileSync(path.join(REPO, 'src/adjudication/interactive-routes.ts'), 'utf8');
    expect(routes).toMatch(/import type \{ NfcReader, NfcTagEvent, NdefPayload \} from '\.\/nfc-port\.js';/);
    expect(routes).not.toMatch(/nfc-bridge/);
    const bridge = fs.readFileSync(path.join(REPO, 'visualizer/engine/nfc-bridge.ts'), 'utf8');
    expect(bridge).toMatch(/from '\.\.\/\.\.\/src\/adjudication\/nfc-port\.js'/);
    expect(bridge).toMatch(/class NfcBridge extends EventEmitter implements NfcReader/);
    expect(bridge).not.toMatch(/^export interface NfcTagEvent/m);
  });

  it('no module under src/adjudication imports node-hid', () => {
    for (const file of tsFilesUnder(path.join(REPO, 'src', 'adjudication'))) {
      expect(importSpecifiers(file)).not.toContain('node-hid');
    }
  });
});
