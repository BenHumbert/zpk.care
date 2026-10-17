// Times the sequencer's formulary load on a sample to extrapolate the full 32,768-drug boot cost.
import { formularyRaw } from '../../src/data/formulary-loader.js';
import { FormularyService } from '../../src/l2/formulary-service.js';
const n = Number(process.argv[2] || 500);
const fs = new FormularyService();
const t = Date.now(), c = process.cpuUsage();
fs.loadFromNadac(formularyRaw.slice(0, n));
const ms = Date.now() - t, cpu = process.cpuUsage(c);
console.log(JSON.stringify({ sample: n, total: formularyRaw.length, wallMs: ms, cpuMs: Math.round((cpu.user + cpu.system) / 1000), extrapolatedFullWallSec: Math.round(ms / n * formularyRaw.length / 1000) }));
