// Checks whether the sequencer's "next empty slot" witness reproduces its published registry root.
import { Field, Poseidon } from 'o1js';
import { l2Parse } from '../../src/l2/l2-json.js';
const call = async (method: string) => (l2Parse(await (await fetch('http://localhost:3030/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) })).text()) as any).result;
const w = await call('l2_getRegistrationWitnesses');
const st = await call('l2_getChainState');
const wit = JSON.parse(w.registryWitnessJson);
let h = Field(0);
for (let i = 0; i < wit.path.length; i++) h = wit.isLeft[i] ? Poseidon.hash([h, Field(BigInt(wit.path[i]))]) : Poseidon.hash([Field(BigInt(wit.path[i])), h]);
console.log(JSON.stringify({
  nextSlotIndex: w.nextSlotIndex, walletCount: String(st?.walletCount ?? st?.chainState?.walletCount ?? '?'),
  publishedRegistryRoot: w.currentRegistryRoot, rootFromEmptySlotWitness: h.toString(),
  witnessMatchesPublishedRoot: h.toString() === String(w.currentRegistryRoot),
}, null, 1));
