// Can a member's identity be recovered from what the sequencer stores or serves?
// Looks for each member's identity hashes on the sequencer's disk and in its public routes,
// then tries a small dictionary attack on the name and birth-date hashes.
import fs from 'fs';
import path from 'path';
import { hashString, hashDate } from '../../src/zkp/hash-utils.js';
const [disk, ...walletFiles] = process.argv.slice(2);
const stateText = fs.readFileSync(disk, 'utf8');
const publicState = await (await fetch('http://localhost:3030/interactive/state')).text();
const people = [
  { key: 'A1', first: 'Avery', last: 'Quillfeather', dob: '19870412' },
  { key: 'A2', first: 'Rowan', last: 'Ashgrove', dob: '19921103' },
  { key: 'B1', first: 'Jules', last: 'Marrowind', dob: '19750828' },
  { key: 'B2', first: 'Sasha', last: 'Penhallow', dob: '20010219' },
];
for (const p of people) {
  const h = { first: hashString(p.first).toString(), last: hashString(p.last).toString(), dob: hashDate(p.dob).toString() };
  console.log(p.key, 'first-name hash on disk:', stateText.includes(h.first), '| in public /interactive/state:', publicState.includes(h.first),
    '| DOB hash on disk:', stateText.includes(h.dob));
}
// Dictionary attack on one stored first-name hash: try a short list of common names.
const names = ['James','Mary','Avery','Rowan','Jules','Sasha','Michael','Linda','Robert','Patricia'];
const found = names.filter(n => stateText.includes(hashString(n).toString()));
console.log('names recovered from disk by a 10-name dictionary:', found.join(', '));
// Birth dates: every day 1930-2010 (~29k candidates).
let dobHits = 0; const t = Date.now();
for (let y = 1930; y <= 2010; y++) for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) {
  const s = `${y}${String(m).padStart(2,'0')}${String(d).padStart(2,'0')}`;
  if (stateText.includes(hashDate(s).toString())) dobHits++;
}
console.log(`birth dates recovered by brute force: ${dobHits} (in ${Math.round((Date.now()-t)/1000)} s)`);
