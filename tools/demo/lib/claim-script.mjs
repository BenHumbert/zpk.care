/**
 * What the walkthrough says, scene by scene, and the cast it says it about: the final script ("One Claim, End to
 * End", judged for accuracy and tone, with every fix the judges listed) as director.mjs runs it, rewritten where the
 * product changed after it was written (9f5099d: the pharmacy verifies a tap, the marketplace takes the IRS letter at
 * submission and shows the activation code on the page, the member app shows her own limits and the attestation's
 * fields, the prescriber's badge says what the engine made). director.mjs, voice-check.mjs, voice-audition.mjs and
 * whiteboard-preview.mjs read it.
 *
 * Shape:
 *   storyLines(c)[sceneKey][beatName] = [ line, ... ]
 *   line = { who, text, mood?, estMs?, board?, pricing? }
 *     who     a PEOPLE key, the voice role: narrator, analyst (Theo), hr (Delphine), member (Avery),
 *             prescriber (Dr. Fallowmere), pharmacist (Walt)
 *     text    what is said; captions show it as written, lib/narrate.mjs toSpeech() makes the spoken form
 *     mood    a lib/narrate.mjs MOODS key (delivery hints for the engines that use them)
 *     estMs   a rehearsal's stand-in length when no voice is rendered (otherwise ~2.6 words a second)
 *     board   whiteboard actions run while this line plays (lib/board-beats.mjs):
 *             { do: 'clear' | 'title' | 'write' | 'annotate' | 'value' | 'circle' | 'underline' | 'box' | 'arrow' | 'check' | 'erase' | 'pen',
 *               when: 'start' | 0.4 (a fraction of the clip) | { word: 'group', at: 0.4 } (saved word times, else the fraction) | 'end',
 *               card: '2b'  (write: a card key in lib/equations.mjs; its board id is 'eq-2b'),
 *               target / near / from / to: { card: '2b', find: 'f5' } | { card, findRe: '...' } | { card, line: 2 } | 'eq-2b' | { x, y, w, h },
 *               text, color: 'ink' | 'blue' | 'red' | 'green', size, side, ms, keepTitle, ... }
 *     pricing true on a line that says where the copay, the ingredient cost or the fee come from, or says a claim
 *             amount. Each was checked against the pricing commit (e2f0864: each phone member bound to her plan's
 *             formulary and copay; every fill priced at NADAC x quantity + the plan's dispensing fee, the pharmacy
 *             sending no cost); `node director.mjs --plan` lists them, to recheck whenever pricing changes.
 *
 * Amounts. No line holds a claim amount in its source: it holds a {slot} (CLAIM_SLOTS) that storyLines() fills from
 * c.claim. castOf() predicts the claim with the fill circuit's own arithmetic (priceFill, lib/equations.mjs cards 7b
 * to 7g) on the pricing rule (predictPrice), so voice-check.mjs and the director's pre-roll can render every line before
 * a take. Once the fill proof is done, the director reads the engine's answer, calls withClaim(c, answer) and speaks
 * every later line from that real claim; a take whose claim differs from the prediction stops before the first line it
 * did not render, and storyChecks() stops one whose claim breaks what the lines say (first fill of the year, inside the
 * deductible, above the copay: P = T, Q = 0, kappa = T). Plan values (deductible, out-of-pocket, copay) are the plan the
 * director itself types, said in words from castOf().
 *
 * Nobody says a PIN, a key, a code, a token or an identity value aloud; audit finding numbers stay on-screen text.
 * Every person here is fictional (the doctor and the pharmacy are row 0 of src/data/prescribers.json and
 * pharmacies.json, Sorrel Prairie, WI); web-search every name, the employer too, again before publishing.
 */
import { sayAmount, sayNumber } from './narrate.mjs';

export const SCRIPT_STATUS = 'final';
/** The lines marked pricing wait on the pricing commit (see the header). */
export const PRICING_STATUS = 'final';

export const PEOPLE = Object.freeze({
  narrator: Object.freeze({ key: 'narrator', name: 'Narrator', role: 'Narrator', color: '#a5b4fc', mood: 'precise' }),
  analyst: Object.freeze({ key: 'analyst', name: 'Theo Brandvold', role: 'Insurer analyst', color: '#38bdf8', mood: 'dry' }),
  hr: Object.freeze({ key: 'hr', name: 'Delphine Okerlund', role: 'HR administrator', color: '#f59e0b', mood: 'brisk' }),
  member: Object.freeze({ key: 'member', name: 'Avery Quillfeather', role: 'Member', color: '#f472b6', mood: 'warm' }),
  prescriber: Object.freeze({ key: 'prescriber', name: 'Dr. Miriam Fallowmere', role: 'Prescriber', color: '#34d399', mood: 'kind' }),
  pharmacist: Object.freeze({ key: 'pharmacist', name: 'Walt Kettleby', role: 'Pharmacist', color: '#fb923c', mood: 'wry' })
});

/** Delivery hints (lib/narrate.mjs MOODS). */
export const MOOD = Object.freeze({ calm: 'calm', precise: 'precise', warm: 'warm', curious: 'curious', dry: 'dry', brisk: 'brisk', anxious: 'anxious', relieved: 'relieved', kind: 'kind', wry: 'wry' });

export const ACTS = Object.freeze({ 1: 'The plan and the employer', 2: 'Avery enrolls', 3: 'The prescription and the pickup', 4: 'The ledger' });

/**
 * The scenes in the order the script and the UI give them. camera: the shot director.mjs cuts to. kind: screen |
 * board (the whiteboard) | status (the director-drawn status card). script: the final script's scene number(s).
 * The script's scene 3 (Request Docs) is gone: the marketplace now asks for the IRS letter right after Submit, so HR
 * uploads it at once (docs) and the insurer's first look at the row is the review (approve).
 */
export const SCENES = Object.freeze([
  { key: 'plan', act: 1, kind: 'screen', camera: 'insurer', script: '1', title: 'The insurer publishes a plan' },
  { key: 'apply', act: 1, kind: 'screen', camera: 'employer:marketplace', script: '2', title: 'HR picks the plan and applies' },
  { key: 'docs', act: 1, kind: 'screen', camera: 'employer:marketplace', script: '4', title: 'HR saves the activation code and uploads the IRS letter' },
  { key: 'approve', act: 1, kind: 'screen', camera: 'insurer', script: '3+5', title: 'The insurer reviews the letter and approves' },
  { key: 'sign', act: 1, kind: 'screen', camera: 'employer:marketplace', script: '6', title: 'HR signs; the employer node starts' },
  { key: 'group', act: 1, kind: 'screen', camera: 'employer:node', script: '7', title: 'HR creates the benefit group' },
  { key: 'codes', act: 1, kind: 'screen', camera: 'employer:hrtool', script: '8', title: 'HR issues enrollment codes' },
  { key: 'enroll', act: 2, kind: 'screen', camera: 'member', script: '9', title: 'Avery enrolls on her phone' },
  { key: 'board-wallet', act: 2, kind: 'board', camera: 'board', script: '10', title: 'From identity to wallet ID' },
  { key: 'enrolling', act: 2, kind: 'screen', camera: 'member', script: '11', title: 'Enrolling with the insurer' },
  { key: 'board-registration', act: 2, kind: 'board', camera: 'board', script: '12', title: 'What the registration proof says' },
  { key: 'board-gate', act: 2, kind: 'board', camera: 'board', script: '13', title: "The sequencer's gate" },
  { key: 'enrolled', act: 2, kind: 'screen', camera: 'member', script: '14', title: 'Enrollment complete' },
  { key: 'status-registration', act: 2, kind: 'status', camera: 'status', script: '15', title: 'Registration, behind the screen' },
  { key: 'board-record', act: 2, kind: 'board', camera: 'board', script: '16', title: "Avery's record" },
  { key: 'pcp', act: 3, kind: 'screen', camera: 'member', script: '17', title: 'Avery picks her doctor' },
  { key: 'prescribe', act: 3, kind: 'screen', camera: 'prescriber', script: '18', title: 'The doctor writes the prescription' },
  { key: 'fill', act: 3, kind: 'screen', camera: 'pharmacy', script: '19', title: 'The pharmacy fills it' },
  { key: 'attest', act: 3, kind: 'screen', camera: 'member', script: '20', title: 'At the counter: the phone’s attestation' },
  { key: 'verify-dispense', act: 3, kind: 'screen', camera: 'pharmacy', script: '21', title: 'Verify, then dispense' },
  { key: 'board-deductible', act: 3, kind: 'board', camera: 'board', script: '22', title: 'Inside the fill proof: deductible and copay' },
  { key: 'pay', act: 3, kind: 'screen', camera: 'pharmacy', script: '23', title: 'The price, and payment at the counter' },
  { key: 'board-settlement', act: 3, kind: 'board', camera: 'board', script: '24', title: "Credit, settlement, and the engine's check" },
  { key: 'status-update', act: 4, kind: 'status', camera: 'status', script: '25', title: "Meanwhile, on Avery's phone" },
  { key: 'board-update', act: 4, kind: 'board', camera: 'board', script: '26', title: "The phone's update proof" },
  { key: 'status-accepted', act: 4, kind: 'status', camera: 'status', script: '27', title: 'The update is accepted' },
  { key: 'board-ledger', act: 4, kind: 'board', camera: 'board', script: '28', title: 'What the sequencer wrote' },
  { key: 'batch', act: 4, kind: 'screen', camera: 'network', script: '29', title: 'The batch' },
  { key: 'board-batch', act: 4, kind: 'board', camera: 'board', script: '30', title: 'The batch proof' },
  { key: 'audit', act: 4, kind: 'screen', camera: 'insurer', script: '31', title: 'The insurer checks the books' },
  { key: 'pickup', act: 4, kind: 'screen', camera: 'member', script: '32', title: 'Avery sees her claim' }
]);

/** The beats director.mjs calls, per screen and status scene, in order. Board scenes speak all their lines in order. */
export const BEATS = Object.freeze({
  plan: ['intro', 'name', 'cents', 'limits', 'create', 'after'],
  apply: ['plans', 'choose', 'details', 'submit', 'after'],
  docs: ['code', 'asked', 'upload'],
  approve: ['row', 'pdf', 'approve'],
  sign: ['scroll', 'sign', 'activation', 'token'],
  group: ['token', 'form', 'after'],
  codes: ['setup', 'group', 'preview', 'expiry', 'after', 'channels'],
  enroll: ['intro', 'new', 'pin', 'code', 'recovery', 'identity', 'keygen', 'redeem', 'answer'],
  enrolling: ['enroll', 'shares', 'compile'],
  enrolled: ['cards', 'explain', 'enter'],
  'status-registration': ['accepted', 'record'],
  pcp: ['choose', 'set', 'after'],
  prescribe: ['patient', 'pharmacy', 'drug', 'quote', 'directions', 'refills', 'send', 'sent', 'proofs', 'ledger'],
  fill: ['read', 'fill', 'after'],
  attest: ['ask', 'open', 'explain'],
  'verify-dispense': ['pasted', 'verified', 'gate', 'dispense', 'proving', 'checks'],
  pay: ['price', 'question', 'answer', 'card', 'counsel', 'after'],
  'status-update': ['queued'],
  'status-accepted': ['accepted', 'caveat'],
  batch: ['intro', 'batch'],
  audit: ['chain', 'balance', 'after'],
  pickup: ['claim', 'read', 'deductible', 'closing', 'unfinished']
});

// ------------------------------------------------------------------ the cast and its numbers

const cents = (n) => `$${(Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const grouped = (n) => Number(n).toLocaleString('en-US');
const ymd = (d) => d.toISOString().slice(0, 10);
const lastDayOfNextMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Whole dollars the way people say them: 50000 cents -> 'five hundred', 780000 -> 'seventy-eight hundred'. */
const dollarWords = (n) => (Number(n) % 100 === 0 ? sayAmount(Number(n) / 100) : cents(n));

/**
 * The fill circuit's price split (lib/equations.mjs cards 7b-7g, src/fulfillment/accumulator-fulfillment-program.ts
 * 294-464), in integer cents. acc = the member's accumulator before the fill; fam = the family's pooled totals and
 * limits (a member alone: the family totals are her own).
 */
export function priceFill({ ing, fee, c, acc, fam }) {
  const T = ing + fee;
  const { D, d, M, o, B, b } = acc;
  const inDed = D > 0 && !(d >= D);
  const rD = inDed ? D - d : 0;
  const pD = T < rD ? T : rD;
  const a = T - pD;
  const cRem = a < c ? a : c;
  const pNorm = T < c ? T : c;
  const pBase = inDed ? pD + cRem : pNorm;
  const qBase = T - pBase;
  const rB = B > 0 && b >= B ? 0 : B > 0 ? B - b : qBase;
  const qCap = B > 0 && qBase > rB ? rB : qBase;
  const pPost = T - qCap;
  const rM = M > 0 && o >= M ? 0 : M > 0 ? M - o : pPost;
  const pInd = M > 0 && pPost > rM ? rM : pPost;
  const qInd = T - pInd;
  const { Mh = 0, oBar = o, Bh = 0, bBar = b } = fam || {};
  const metFM = Mh > 0 && oBar >= Mh;
  const exhFB = Bh > 0 && bBar >= Bh;
  const rMh = metFM ? 0 : Mh > 0 ? Mh - oBar : pInd;
  const rBh = exhFB ? 0 : Bh > 0 ? Bh - bBar : qInd;
  const capFM = Mh > 0 && !metFM && pInd > rMh;
  const capFB = Bh > 0 && !exhFB && qInd > rBh;
  const P = metFM ? 0 : exhFB ? T : capFM ? rMh : capFB ? T - rBh : pInd;
  const rule = metFM ? 1 : exhFB ? 2 : capFM ? 3 : capFB ? 4 : 0;
  const Q = T - P;
  const kappa = P < pD ? P : pD;
  return { T, inDed, rD, pD, a, cRem, pNorm, pBase, qBase, rB, qCap, pPost, rM, pInd, qInd, P, Q, kappa, rule };
}

/**
 * The pricing rule the lines tell. The engine prices every fill itself: the drug's NADAC per unit times the quantity,
 * plus the plan's dispensing fee; the pharmacy sends no cost. The copay is the plan's: every entry of a plan-bound
 * formulary carries it (src/onboarding/plan-formulary.ts).
 */
export function predictPrice({ plan, drug }) {
  return {
    ingredientCents: nadacIngredientCents(drug.nadacPerUnit, drug.quantity),
    feeCents: plan.dispensingFeeCents,
    copayCents: plan.copayCents
  };
}

/**
 * NADAC x quantity in cents, exactly as the engine computes it (src/fulfillment/nadac-pricing.ts): NADAC held as a whole
 * number of $0.00001 (CMS publishes 5 decimals), quantity in thousandths, half up to the cent, in BigInt. Floating point
 * disagreed with the engine on a few dozen drug-quantity pairs.
 */
export function nadacIngredientCents(nadacPerUnit, quantity) {
  const e5 = (v) => { const [w, f = ''] = String(Number(v).toFixed(5)).split('.'); return BigInt(w) * 100000n + BigInt((f + '00000').slice(0, 5)); };
  const milli = (q) => { const [w, f = ''] = String(Number(q).toFixed(3)).split('.'); return BigInt(w) * 1000n + BigInt((f + '000').slice(0, 3)); };
  return Number((e5(nadacPerUnit) * milli(quantity) + 500000n) / 1000000n);
}

/** The claim amounts a line may say; storyLines() fills each {slot} from c.claim. */
export const CLAIM_SLOTS = Object.freeze(['totalCents', 'total', 'patientPay', 'planPay', 'ingredient', 'fee', 'remainingCents', 'remaining', 'kappaCents']);

/**
 * The claim as the lines tell it: the fill circuit's split of T = ing + fee against her plan and her totals before
 * the fill, the slots, and where it came from ('predicted' by castOf, 'engine' once the director has read the fill
 * result). `answer` is the engine's own T, P, Q and kappa; where the circuit's arithmetic disagrees, `mismatch` says so.
 */
function claimOf(plan, { ingredientCents, feeCents, copayCents, before = {}, answer = null, source = 'predicted' }) {
  const acc = { D: plan.deductibleCents, d: Number(before.d || 0), M: plan.oopCents, o: Number(before.o || 0), B: plan.annualCents, b: Number(before.b || 0) };
  const split = priceFill({ ing: ingredientCents, fee: feeCents, c: copayCents, acc, fam: { Mh: plan.famOopCents, oBar: acc.o, Bh: plan.famBenefitCents, bBar: acc.b } });
  const k = { source, ingredientCents, feeCents, copayCents, before: acc, ...split, mismatch: [] };
  if (answer) {
    for (const f of ['T', 'P', 'Q', 'kappa']) {
      if (answer[f] == null || !Number.isFinite(Number(answer[f]))) continue;
      if (Number(answer[f]) !== k[f]) k.mismatch.push(`${f}: the engine answered ${answer[f]}, the fill circuit's arithmetic gives ${k[f]}`);
      k[f] = Number(answer[f]);
    }
  }
  k.slots = Object.freeze({
    totalCents: grouped(k.T), total: cents(k.T), patientPay: cents(k.P), planPay: cents(k.Q),
    ingredient: cents(k.ingredientCents), fee: cents(k.feeCents), remainingCents: grouped(k.rD), remaining: cents(k.rD), kappaCents: grouped(k.kappa)
  });
  return Object.freeze(k);
}

/** The cast's derived forms (say, pricing) for its claim. */
function withForms(c) {
  const k = c.claim;
  return {
    ...c,
    pricing: { ingredientCents: k.ingredientCents, feeCents: k.feeCents, copayCents: k.copayCents, T: k.T, P: k.P, Q: k.Q, kappa: k.kappa, rD: k.rD, pD: k.pD, a: k.a, cRem: k.cRem, pBase: k.pBase, rule: k.rule, source: k.source },
    say: {
      deductible: cents(c.plan.deductibleCents), oop: cents(c.plan.oopCents), famOop: cents(c.plan.famOopCents), copay: cents(k.copayCents),
      ingredient: cents(k.ingredientCents), fee: cents(k.feeCents), total: cents(k.T), patientPay: cents(k.P), planPay: cents(k.Q), credit: cents(k.kappa)
    }
  };
}

/**
 * The cast as the lines tell it. Every name, value and number the people say or type comes from here.
 * `input` overrides any default (names, plan values, the drug).
 */
export function castOf(input = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const tag = input.tag || now.toISOString().slice(2, 10).replace(/-/g, '') + now.toISOString().slice(11, 16).replace(':', '');
  const plan = {
    name: 'Standard Rx 2026', id: 'PLAN-STD-RX-2026', copayCents: 1000, deductibleCents: 50000, oopCents: 780000, annualCents: 10000000,
    famDedCents: 100000, famOopCents: 1600000, famBenefitCents: 20000000 /* the insurer route's default; the form has no field */, coverage: 'pharmacy',
    dispensingFeeCents: 1300, // the plan's dispensing fee, typed into the insurer's plan form (#plan-dispensing-fee)
    ...(input.plan || {})
  };
  const altPlan = input.altPlan === null ? null : {
    name: 'Low Deductible Rx 2026', id: 'PLAN-LOWDED-RX-2026', copayCents: 2500, deductibleCents: 20000, oopCents: 600000, annualCents: 10000000,
    famDedCents: 40000, famOopCents: 1200000, famBenefitCents: 20000000, coverage: 'pharmacy', dispensingFeeCents: 1300, ...(input.altPlan || {})
  };
  const employer = {
    company: 'Fernhill Test Works LLC', employerId: 'FERNHILL-TW', contact: PEOPLE.hr.name, email: 'hr@fernhill.example.test', phone: '608-555-0142',
    ein: '00-4417321', state: 'WI', industry: 'Materials testing', effective: ymd(now), cap: 25, planType: 'erisa', signerTitle: 'Benefits Director',
    letterFileName: 'sample-ein-letter.pdf', ...(input.employer || {})
  };
  const group = { id: 'GRP-FERNHILL-LAB', effectiveDate: ymd(now), cap: 25, ...(input.group || {}) };
  const member = { firstName: 'Avery', lastName: 'Quillfeather', dob: '19870412', email: 'avery.quillfeather@example.test', ...(input.member || {}) };
  member.employeeId = member.employeeId || `FTW-${tag}-001`;
  member.familyId = member.familyId || `FAM-${tag}-01`;
  member.cardholderId = member.cardholderId || member.employeeId; // the harness uses the employee ID as the cardholder ID
  const others = input.coworkers || [
    ['Rowan', 'Ashgrove', '19921103'], ['Jules', 'Marrowind', '19850921'], ['Sasha', 'Penhallow', '19900317'],
    ['Imogen', 'Strayhorn', '19780629'], ['Bastian', 'Wrenfield', '19951208']
  ];
  const roster = [
    { employeeId: member.employeeId, familyId: member.familyId, firstName: member.firstName, lastName: member.lastName, dob: member.dob, email: member.email },
    ...others.map(([f, l, dob], i) => ({ employeeId: `FTW-${tag}-${String(i + 2).padStart(3, '0')}`, familyId: `FAM-${tag}-${String(i + 2).padStart(2, '0')}`, firstName: f, lastName: l, dob, email: '' }))
  ];
  roster.fileName = 'fernhill-roster.csv';
  const codes = { validUntil: ymd(lastDayOfNextMonth(now)), ...(input.codes || {}) };
  // match strings for the provider lists: row 0 of the fictional src/data/prescribers.json and pharmacies.json (3f2a192)
  const prescriber = { display: PEOPLE.prescriber.name, lastName: 'Fallowmere', match: 'Fallowmere', ...(input.prescriber || {}) };
  const pharmacy = { display: 'Kettleby Pharmacy', short: "Kettleby's", match: 'Kettleby', ...(input.pharmacy || {}) };
  const drug = {
    // src/data/formulary-100.json: NDC 00378013701, tier 1, no prior authorization or step therapy, at most 90 a fill
    name: 'Allopurinol 100 mg tablet', match: 'ALLOPURINOL', strengthMatch: '100', ndc: '00378-0137-01', quantity: 30, daysSupply: 30, refills: 0,
    directions: 'Take 1 tablet by mouth daily after a meal', diagnosis: 'Gout', nadacPerUnit: 0.0394,
    ...(input.drug || {})
  };
  // the batch interval the batch scene says; the director checks it against l2_getStatus before a take
  const network = { batchSeconds: 30, ...(input.network || {}) };
  const claim = claimOf(plan, { ...predictPrice({ plan, drug }), source: 'predicted' });
  return withForms({ tag, now: now.toISOString(), plan, altPlan, employer, group, member, roster, codes, prescriber, pharmacy, drug, network, claim });
}

/**
 * The cast with the engine's own claim, once the fill proof is done (director.mjs): `fill` is the fill result the
 * pharmacy node receives ({ adjudication: { ingredientCostCents, dispensingFeeCents, totalCostCents, patientPayCents,
 * planPayCents }, accumulator: { before, after } }, src/adjudication/interactive-service.ts dispensePrescription).
 * Every line spoken after it comes from this claim.
 */
export function withClaim(c, fill) {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const adj = (fill && fill.adjudication) || {};
  const acc = (fill && fill.accumulator) || {};
  const before = acc.before || {};
  const after = acc.after || {};
  const ing = num(adj.ingredientCostCents);
  const fee = num(adj.dispensingFeeCents);
  if (ing == null || fee == null) throw new Error('the fill result carries no ingredient cost or dispensing fee');
  const dBefore = num(before.deductiblePaidCents) ?? 0;
  const answer = {
    T: num(adj.totalCostCents) ?? ing + fee,
    P: num(adj.patientPayCents),
    Q: num(adj.planPayCents),
    kappa: num(after.deductiblePaidCents) == null ? null : num(after.deductiblePaidCents) - dBefore
  };
  const claim = claimOf(c.plan, {
    ingredientCents: ing, feeCents: fee, copayCents: c.claim.copayCents,
    before: { d: dBefore, o: num(before.oopPaidCents) ?? 0, b: num(before.benefitUsedCents) ?? 0 }, answer, source: 'engine'
  });
  return withForms({ ...c, claim });
}

/** The slots that say something different for the two claims (the lines that would need new voices). */
export function claimDiffs(a, b) {
  return CLAIM_SLOTS.filter((s) => a.claim.slots[s] !== b.claim.slots[s]).map((s) => `${s}: ${a.claim.slots[s]} -> ${b.claim.slots[s]}`);
}

/**
 * What the lines assume about the claim (the script's angle): Avery's first fill of the year, inside the $500
 * deductible and above the copay, so P = T, Q = 0 and kappa = T, and the counter exchange ("I thought it was a
 * ten-dollar copay") is true. Returns the broken assumptions, [] when the lines hold.
 */
export function storyChecks(c) {
  const k = c.claim;
  const out = [];
  if (!k.inDed) out.push('the fill is not inside the deductible (the board and the counter say it is)');
  else if (!(k.T < k.rD)) out.push(`T = ${k.T} cents does not fit inside the remaining deductible of ${k.rD} (the board says a = 0)`);
  if (!(k.T > k.copayCents)) out.push(`T = ${k.T} cents is not above the ${k.copayCents}-cent copay (Avery expects the copay and is told more)`);
  if (k.P !== k.T || k.Q !== 0) out.push(`P = ${k.P}, Q = ${k.Q} (the lines say P = T and Q = 0)`);
  if (k.kappa !== k.T) out.push(`kappa = ${k.kappa} (the lines say all of it counts toward the deductible)`);
  return out.concat(k.mismatch);
}

// ------------------------------------------------------------------ what the screen says (lower-thirds, never spoken)

/**
 * The on-screen cards the director shows (lib/stage.mjs card(): the "behind this click" lower-third), including the
 * seven LEARNS / NEVER LEARNS cards, which are never spoken. color: the card's edge.
 */
export function screenCards(c) {
  const learns = '#34d399';
  return Object.freeze({
    disclosure: { title: 'About this film', lines: ['The people, the employer, the doctor and the pharmacy are fictional. The voices are synthetic.', 'Every screen is the real software; long waits are sped up and marked.'] },
    planBehind: { title: 'Behind this click', lines: ['POST /plans', 'The insurer node stores the plan on the sequencer, then publishes it with a request signed by its node key.'] },
    activationCode: { title: 'On this screen', lines: ['A one-time activation code, shown once on this page. Redacted in this film.', 'It collects the employer node’s admin credentials after activation.'] },
    learnsEmployerCodes: { title: 'Fernhill’s node learns', color: learns, lines: ['An employee-ID hash, a family-ID hash and a hash of code and PIN for each person.', 'Never learns: names, birth dates, employee IDs, PINs.'] },
    blurred: { title: 'On this screen', lines: ['Typed on the phone. Blurred here.'] },
    redeemBehind: { title: 'Behind this', lines: ['The code and one hash of code and PIN: phone → insurer → (signed) → Fernhill’s node.', 'Group, plan and family hashes come back to the insurer; the group and plan hashes go on to the phone.'] },
    learnsEmployerRedeem: { title: 'Fernhill’s node learns', color: learns, lines: ['The code was used.', 'Never learns: a wallet ID.'] },
    enrollBehind: { title: 'Behind this click', lines: ['Phone → insurer (wallet ID, recovery deposits) → engine (signed approval).'] },
    learnsInsurer: { title: 'The insurer learns', color: learns, lines: ['The wallet ID and the group, plan and family hashes.', 'Holds: the salt, g, the plan hash and one key share per card.', 'Never learns: the identity fields, or the cards’ shares.'] },
    learnsEngine: { title: 'The engine learns', color: learns, lines: ['That the phone knows the six values behind W.', 'Never learns: the values.'] },
    learnsPrescriber: { title: 'The prescriber sees', color: learns, lines: ['A wallet ID on her patient list.', 'Never sees: a name.'] },
    prescribeProofs: { title: 'While it proves', lines: ['Proven inside the engine, then discarded.', 'No outside verifier yet (audit finding A-22).'] },
    simulatedTap: { title: 'Simulated tap', lines: ['Copied from the phone, pasted at the counter.'] },
    dispenseBehind: {
      title: 'Behind this click',
      lines: [
        `The pharmacy node sends the prescription and quantity ${c.drug.quantity}, and no cost.`,
        'The engine prices the fill (NADAC × quantity + the plan’s dispensing fee) and makes three proofs.'
      ]
    },
    learnsPharmacy: { title: 'The pharmacy learns', color: learns, lines: ['What Avery pays, what the plan pays, and her running totals.', 'Never learns: her name.'] },
    learnsLedger: { title: 'The ledger keeps', color: learns, lines: ['Wallet IDs, the drug-code hash, the date and the amounts.', 'Beside them, in plain text: the drug’s code and name, tier, quantity and NADAC price.', 'Never: her name.'] },
    endCard: { title: 'About this film', lines: ['Voices are synthetic.', 'The people, the employer, the doctor and the pharmacy are fictional.'] }
  });
}

// ------------------------------------------------------------------ the lines

const L = (who, text, extra = {}) => ({ who, text, ...extra });
const N = (text, extra = {}) => L('narrator', text, { mood: MOOD.precise, ...extra });

/** The cues lib/narrate.mjs performs ({chuckle}); any other {name} is a claim slot and must be filled. */
const CUES = new Set(['laugh', 'chuckle', 'sigh', 'gasp', 'giggle', 'cough', 'excited', 'sarcastic', 'whisper', 'curious', 'exhale']);
function fillSlots(text, slots) {
  return String(text).replace(/\{([A-Za-z]+)\}/g, (m, name) => {
    if (CUES.has(name)) return m;
    if (!Object.prototype.hasOwnProperty.call(slots, name)) throw new Error(`a line carries {${name}}, which is not a claim slot (${CLAIM_SLOTS.join(', ')})`);
    return slots[name];
  });
}

/** The story, beat by beat. Every claim amount is a {slot}, filled from c.claim at the end. */
export function storyLines(c) {
  const k = c.claim;
  const D = c.plan.deductibleCents;
  const company = c.employer.company.replace(/,?\s+(LLC|Inc\.?|Corp\.?)$/i, '');
  const planName = c.plan.name.replace(/\s+(\d{4})$/, ', $1');
  const planWord = c.plan.name.split(/\s+/)[0];
  const qty = sayNumber(c.drug.quantity);
  const S = {
    plan: {
      intro: [N('One prescription claim, start to finish, on the real dashboards. It starts with a plan. Theo Brandvold builds plans for the insurer.')],
      name: [L('analyst', `${planName}.`)],
      cents: [N('Amounts on this form are in cents.')],
      limits: [L('analyst', `${capital(dollarWords(D))} deductible. ${capital(dollarWords(c.plan.oopCents))} out-of-pocket. ${capital(dollarWords(c.plan.famOopCents))} for a family.`)],
      create: [L('analyst', 'Create.')],
      after: [N("His node stores the plan on the sequencer, the network's ledger, and publishes it with a signed request. When a member enrolls, the claims engine copies her limits from this copy and binds her to this plan's formulary, copay and dispensing fee.", { pricing: true })]
    },
    apply: {
      plans: [L('hr', c.altPlan ? 'Two plans.' : 'One plan.')],
      choose: [L('hr', `${planWord}. ${capital(dollarWords(D))} deductible, ${dollarWords(c.plan.oopCents)} out-of-pocket, ${dollarWords(c.plan.copayCents)}-dollar base copay. That's the one we budgeted.`, { pricing: true })],
      details: [L('hr', `Effective today. Cap of ${sayNumber(c.employer.cap)}.`)],
      submit: [L('hr', 'Submit.')],
      after: [N("When she submitted, her browser made an Ed25519 key pair and kept the private half in page memory. The insurer got the public half with the application. That key will sign Fernhill's agreement later.")]
    },
    docs: {
      code: [L('hr', 'Activation code. Copied, and saved.')],
      asked: [L('hr', 'They want our CP 575.')],
      upload: [L('hr', 'I have it. Uploading.')]
    },
    approve: {
      row: [L('analyst', `${company}. Letter's on file.`)],
      pdf: [L('analyst', 'Name and EIN match the application.')],
      approve: [L('analyst', 'Approved.')]
    },
    sign: {
      scroll: [L('hr', "It won't let me sign until I scroll to the end. Fine.")],
      sign: [L('hr', `${c.employer.signerTitle}. Attest. Sign.`)],
      activation: [N("Her key signs the agreement, and the insurer checks it against her application's public key and adds its own signature. The sequencer checks both, the insurer's against a key pinned in its own configuration, not one carried in the document. Then the insurer starts a separate employer node for Fernhill.")],
      token: [L('hr', 'Node address. Admin token, shown once. Copying it now.')]
    },
    group: {
      token: [L('hr', "Token's in.")],
      form: [L('hr', `One group for the lab staff. ${planWord} plan, effective today.`)],
      after: [N('This node serves Fernhill alone. It accepts a group only on a plan Fernhill bought. The group ID stays here; only its hash ever leaves.')]
    },
    codes: {
      setup: [L('hr', 'Node address. Token. Passphrase, twice.')],
      group: [L('hr', 'Lab staff.')],
      preview: [L('hr', `${capital(sayNumber(c.roster.length))} rows. Same as the roster.`)],
      expiry: [L('hr', 'Codes expire end of next month.')],
      after: [N("This tool is meant for Fernhill's own computer. It hashes each employee ID and family ID with a secret seed it keeps for this group, and sends Fernhill's node only those hashes. The node issues one code per person. The tool adds an eight-digit PIN; the node gets only a hash of code and PIN together.")],
      channels: [L('hr', 'Codes go in the welcome letters. PINs by text.')]
    },
    enroll: {
      intro: [N('A few days later, Avery Quillfeather, a lab technician at Fernhill, has a letter with a code and a text with a PIN. Here the member node on port 4001 plays her phone.')],
      new: [L('member', 'Okay. New enrollment.', { mood: MOOD.anxious })],
      pin: [L('member', 'A PIN for the phone first.', { mood: MOOD.anxious })],
      code: [L('member', 'Code from the letter. PIN from the text.', { mood: MOOD.anxious })],
      recovery: [L('member', "And a recovery PIN. Something I won't forget.", { mood: MOOD.anxious })],
      identity: [L('member', 'Cardholder ID, from the card. Name. Birthday.', { mood: MOOD.anxious })],
      keygen: [N('First the phone makes a random enrollment key. It never leaves the phone in one piece.')],
      redeem: [N('Then it redeems the code: the code and one hash of code and PIN go to the insurer, which forwards them, signed, to the node that issued the code.')],
      answer: [N("Fernhill's node checks the hash, marks the code used, and answers with group, plan and family hashes. The insurer keeps the family hash and passes the other two to the phone.")]
    },
    'board-wallet': {
      lines: [
        N('Here is what the phone just computed.', { board: [{ do: 'clear' }, { do: 'title', text: 'From identity to wallet ID' }] }),
        N('One function does all the hashing. H is Poseidon, a hash that is cheap inside a proof, working modulo p, a prime just above two to the two hundred fifty-four. enc packs text into field elements, thirty-one bytes each; hs hashes a string.', {
          board: [
            { do: 'write', card: '0', size: 36 },
            { do: 'annotate', text: 'one hash for everything', near: { card: '0', find: 'Poseidon' }, side: 'below', color: 'blue', when: 0.85 }
          ]
        }),
        N('The phone draws a salt, two hundred fifty-six random bits; sigma is its hash. Each identity field is hashed with sigma: f-zero the cardholder ID, f-two and f-three the names, f-four the enrollment key, K. The birth date, f-one, goes in as one number. f-five is g, the group hash from the redeemed code, with no salt.', {
          board: [{ do: 'write', card: '2', size: 40 }]
        }),
        N('Seven field elements go in, a zero that tags a member wallet, then f-zero through f-five. One comes out: W, the wallet ID.', {
          board: [{ do: 'write', card: '2b', size: 52, color: 'blue' }]
        }),
        N('f-zero to f-four never leave the phone; f-five came from the insurer at redemption. W goes out, and Fernhill never sees it.', {
          board: [
            { do: 'circle', target: { card: '2b', find: 'f0,f1,f2,f3,f4' }, color: 'blue' },
            { do: 'annotate', text: 'stays on the phone', near: { card: '2b', find: 'f0,f1,f2,f3,f4' }, side: 'below', color: 'blue' },
            { do: 'circle', target: { card: '2b', find: 'f5' }, color: 'red', when: 0.4 },
            { do: 'annotate', text: 'plain hash, no salt', near: { card: '2b', find: 'f5' }, side: 'right', color: 'red' },
            { do: 'box', target: { card: '2b', find: 'W' }, color: 'green', when: 0.7 },
            { do: 'annotate', text: 'leaves the phone', near: { card: '2b', find: 'W' }, side: 'below', color: 'green' }
          ]
        })
      ]
    },
    enrolling: {
      enroll: [N('Enrolling sends the insurer the wallet ID. The insurer checks that the code was redeemed and no other wallet used it, then sends the engine a signed approval: the wallet, its plan, its group and family hashes.')],
      shares: [N('The same call splits the enrollment key, once per recovery card, into two random-looking shares. The card gets one. The insurer gets the other, beside a slow hash of the recovery PIN, the salt, and the group and plan hashes.')],
      compile: [N('Then the phone compiles its circuits and starts the registration proof.')]
    },
    'board-registration': {
      lines: [
        N('While the phone proves, here is what it proves.', { board: [{ do: 'clear' }, { do: 'title', text: 'What the registration proof says' }] }),
        N("First, the tool every tree here uses. MR is a Merkle path root: start at a leaf, ell, and at each level hash it with one sibling, s-i. The bit b-i says which side. z-zero is zero, and each z-k hashes two copies of the one below, so an empty tree's root is known in advance.", {
          board: [
            { do: 'write', card: '5', size: 36 },
            { do: 'annotate', text: 'which side? the bit decides', near: { card: '5', find: 'bi=1' }, side: 'right', color: 'blue', when: { word: 'side', at: 0.5 } }
          ]
        }),
        N("Now the proof. t is the domain tag; zero means member, so the circuit rebuilds W from the six private values. The wallet registry and the lifecycle tree each have height eleven, a thousand and twenty-four slots. Line two: a zero at W's slot hashes up to today's roots, so the slot is empty. Line three writes W with an empty inventory and a nonce of zero, and W with state one, registered. Only x is public: W and four roots.", {
          board: [
            { do: 'write', card: '4b', size: 34 },
            { do: 'annotate', text: 'private: f0..f5', near: { card: '4b', line: 1 }, side: 'right', color: 'blue', when: 0.2 },
            { do: 'underline', target: { card: '4b', line: 2 }, color: 'blue', when: { word: 'two', at: 0.5 } },
            { do: 'annotate', text: 'slot is empty', near: { card: '4b', line: 2 }, side: 'right', color: 'blue' },
            { do: 'underline', target: { card: '4b', line: 3 }, color: 'blue', when: { word: 'three', at: 0.7 } },
            { do: 'annotate', text: 'new leaves', near: { card: '4b', line: 3 }, side: 'right', color: 'blue' },
            { do: 'box', target: { card: '4b', line: 4 }, color: 'green', when: 0.88 },
            { do: 'annotate', text: 'all the sequencer sees', near: { card: '4b', line: 4 }, side: 'right', color: 'green' }
          ]
        })
      ]
    },
    'board-gate': {
      lines: [
        N("The sequencer checks every proof at one gate. At boot it compiled this program itself, in a separate verifier process, and checked the key's hash against a pinned value; this take pins one, and without a pin it only warns. A proof passes only if it verifies, its old roots are the ledger's current roots, and its new roots match the sequencer's own recomputation: the next free slot for a registration, or the wallet's own slot, nonce plus one, for an update.", {
          board: [{ do: 'clear' }, { do: 'title', text: "The sequencer's gate" }, { do: 'write', card: '4c', size: 28 }]
        }),
        N('Only then does anything change. And while the phone proved, it held the proving lease, so nothing else could move those roots.', {
          board: [
            { do: 'box', target: { card: '4c', line: 2 }, color: 'green' },
            { do: 'annotate', text: 'accept', near: { card: '4c', line: 2 }, side: 'above', color: 'green' }
          ]
        })
      ]
    },
    enrolled: {
      cards: [L('member', 'Write your two recovery cards now. Keep one at home. Okay.', { mood: MOOD.anxious })],
      explain: [N('Each card holds one share of her enrollment key and a random ID, and no wallet ID. The wallet ID on screen is an address, not a secret.')],
      enter: [L('member', 'Done.', { mood: MOOD.relieved })]
    },
    'status-registration': {
      accepted: [N("No product screen shows this part, so this card is drawn from the network's own answers. The registration proof was accepted. Then the phone sent the engine a second proof: that it knows the six values behind W, without sending them.")],
      record: [N("The engine opens a record only for a wallet the insurer approved and the ledger shows registered. It took Avery's limits from her plan, marked her eligible with an admin write, not a proof, and queued her first credential, which the phone proved too.")]
    },
    'board-record': {
      lines: [
        N("Two equations hold the engine's record for Avery.", { board: [{ do: 'clear' }, { do: 'title', text: "Avery's record" }] }),
        N('A is the accumulator commitment, one hash over seven numbers: y, the plan year; D, the deductible, and d, paid toward it; M, the out-of-pocket maximum, and o, paid; B, the annual benefit maximum, and b, what the plan has paid. All in cents. On day one, everything paid is zero.', {
          board: [
            { do: 'write', card: '5b', size: 40 },
            { do: 'value', target: { card: '5b', find: 'D', nth: 0 }, text: grouped(D), when: 0.55 },
            { do: 'value', target: { card: '5b', find: 'M', nth: 0 }, text: grouped(c.plan.oopCents), when: 0.68 },
            { do: 'value', target: { card: '5b', find: 'B', nth: 0 }, text: grouped(c.plan.annualCents), when: 0.8 }
          ]
        }),
        N('A credential carries one number for its data, a forest root: the hash of six tree roots, each of height eight. At registration only access control has leaves. Leaf zero is her eligibility record, which binds her to her plan: its copay and the root of its formulary. Leaf one twenty-seven is A. The other trees are empty: z-seven.', {
          pricing: true,
          board: [
            { do: 'write', card: '5c', size: 36 },
            { do: 'annotate', text: 'her plan: copay, formulary', near: { card: '5c', find: 'Eelig' }, side: 'below', color: 'blue', when: 0.62 },
            { do: 'circle', target: { card: '5c', findRe: '127[^A,]*A' }, color: 'blue', when: 0.8 },
            { do: 'annotate', text: 'her accumulator', near: { card: '5c', findRe: '127[^A,]*A' }, side: 'below', color: 'blue' }
          ]
        }),
        N('In the wallet registry, this whole credential is one number: the inventory root inside her leaf.')
      ]
    },
    pcp: {
      choose: [L('member', `Providers. Dr. ${c.prescriber.lastName}. That's who I saw.`, { mood: MOOD.warm })],
      set: [L('member', 'Primary care. Done.', { mood: MOOD.relieved })],
      after: [N(`The engine checks that Dr. ${c.prescriber.lastName} is a credentialed, active prescriber and records her in Avery's credential, as leaf zero of the member tree. The phone proves that update, then posts the link to the sequencer, signed with its wallet key. Avery joins the doctor's list as a wallet ID, with no name.`)]
    },
    prescribe: {
      patient: [L('prescriber', "New patient on my list. That's her.")],
      pharmacy: [L('prescriber', `${c.pharmacy.short}. Her usual.`)],
      drug: [L('prescriber', 'Allopurinol, a hundred milligrams. Start low.')],
      quote: [N("Before she writes it, her node asks the network what Avery would pay today. It may: Avery named her as primary care. The answer comes from the same arithmetic the fill will prove. She would pay {total}, all of it toward the deductible, and the drug is covered on her plan with no prior authorization.", { pricing: true })],
      directions: [L('prescriber', `One a day, after a meal. ${capital(qty)}.`)],
      refills: [L('prescriber', 'No refills until I see her uric acid.')],
      send: [L('prescriber', 'Send.')],
      sent: [N("Her node never received a name. It encrypts the e-script twice, for the pharmacy and for Avery's phone, then asks the engine, which runs inside the sequencer's process, to record it.")],
      proofs: [N("The engine accepts: Avery named her as primary care, both providers are in network, and the drug needs no prior authorization or step therapy. Then it makes four proofs: the doctor's identity, made with a key it still holds for her; eligibility; formulary access; and the message. It throws them away; nobody verifies them yet.")],
      ledger: [N('The ledger gets only a messaging audit event.')]
    },
    fill: {
      read: [L('pharmacist', `Allopurinol, hundred milligram, ${qty}.`)],
      fill: [L('pharmacist', 'Filled. Now we wait for her.')],
      after: [N('Fill is a status change. No proof, no money. This page keeps Dispense disabled until the member is verified.')]
    },
    attest: {
      ask: [L('pharmacist', 'Go ahead and tap your phone.')],
      open: [L('member', 'One sec.', { mood: MOOD.warm })],
      explain: [N('The phone asks the sequencer for an attestation, signed with its wallet key. The sequencer signs one line with its Ed25519 key: the wallet ID, the registry root, the lifecycle state, a global-state field that is zero for now, the time, a one-day expiry and a random nonce. It is meant to travel by NFC tap; here, by clipboard.')]
    },
    'verify-dispense': {
      pasted: [N('The tap is simulated: copied from the phone, pasted here.')],
      verified: [L('pharmacist', 'There you are. One ready to go.')],
      gate: [N("The node checked the sequencer's signature against a key it already holds, and the expiry. With that attestation, not a bare wallet ID, it may read her claim history, which is empty. Dispense unlocks, but that gate lives in this page; the server doesn't ask for the tap.")],
      dispense: [L('pharmacist', 'Running it through.')],
      proving: [N("Dispense sends the engine the prescription and the quantity, and no price. The engine prices the fill itself: the drug's NADAC price times the quantity, plus her plan's dispensing fee. It refuses a terminated member or a same-day repeat of this drug at this pharmacy, then makes three proofs: one for the pharmacy's identity, one for the script's move to dispensed, and one for the fill.", { pricing: true })],
      checks: [N("Before any money, the fill circuit checks the pharmacy, finds the prescription and its filled status, matches the drug to the script and formulary, checks the quantity and that the accumulator is Avery's. For now, the engine still holds the pharmacy's key for that first check.")]
    },
    'board-deductible': {
      lines: [
        N('Inside that proof, the money starts from her record, A.', { board: [{ do: 'clear' }, { do: 'title', text: 'Inside the fill proof: deductible and copay' }] }),
        N("T is the total: the drug's NADAC price times the quantity, plus her plan's dispensing fee. Here, {total}, so on the board T is {totalCents}. inDed, the in-deductible flag, is true while a deductible is unmet. r-D is what is left of it: all of it, {remaining}. p-D, this fill's deductible portion, is T or r-D, whichever is smaller. The whole total fits, so the rest, a, is zero.", {
          pricing: true,
          board: [
            { do: 'write', card: '7b', size: 34 },
            { do: 'value', target: { card: '7b', find: 'T=', nth: 0 }, text: grouped(k.T), side: 'above', when: 0.3 },
            { do: 'value', target: { card: '7b', find: 'rD=', nth: 0 }, text: grouped(k.rD), when: 0.5 },
            { do: 'value', target: { card: '7b', find: 'pD=', nth: 0 }, text: grouped(k.pD), when: 0.7 },
            { do: 'value', target: { card: '7b', find: 'a=T' }, text: grouped(k.a), when: 0.88 }
          ]
        }),
        N(`c is the copay, and it comes from her plan: ${dollarWords(k.copayCents)} dollars. c-rem is the copay on what remains, so zero. p-norm is the usual copay, after the deductible. She is still in it, so her base pay is p-D plus zero: the whole total.`, {
          pricing: true,
          board: [
            { do: 'write', card: '7c', size: 34 },
            { do: 'annotate', text: `c = ${grouped(k.copayCents)}, her plan's copay`, near: { card: '7c', find: 'a<c' }, side: 'above', color: 'blue', when: 0.2 },
            { do: 'value', target: { card: '7c', find: 'crem=', nth: 0 }, text: grouped(k.cRem), when: 0.45 },
            { do: 'circle', target: { card: '7c', find: 'pD+crem' }, color: 'red', when: 0.85 },
            { do: 'value', target: { card: '7c', find: 'pD+crem' }, text: grouped(k.pBase), color: 'red' }
          ]
        }),
        N('Then the benefit cap, the out-of-pocket cap and the family rules. None binds today. So P, what she pays, is the total; Q, what the plan pays, is zero.', {
          pricing: true,
          board: [{ do: 'annotate', text: 'caps: benefit, out-of-pocket, family. None binds.', color: 'blue', size: 26 }]
        })
      ]
    },
    pay: {
      price: [L('pharmacist', "That's {patientPay} today.", { pricing: true })],
      question: [L('member', `Oh. I thought it was a ${dollarWords(k.copayCents)}-dollar copay.`, { mood: MOOD.anxious, pricing: true })],
      answer: [L('pharmacist', `It will be, once you've met your deductible. Until then you pay what the drug costs, and this one's a generic. All of it counts toward your ${dollarWords(D)}.`, { pricing: true })],
      card: [L('member', 'Okay. Here you go.', { mood: MOOD.relieved })],
      counsel: [L('pharmacist', 'Take it after a meal, with plenty of water.', { mood: MOOD.kind })],
      after: [N("The badge says Settlement Complete. More exactly: the fill proof stayed in the engine, and it takes one more proof, from Avery's phone, to put the claim on the ledger. Payment Received is the pharmacy's own note that she paid; it changes nothing on the network.")]
    },
    'board-settlement': {
      lines: [
        N('Walt was right about the deductible. Here is where the proof says so.', { board: [{ do: 'clear' }, { do: 'title', text: "Credit, settlement, and the engine's check" }] }),
        N('Kappa, the deductible credit, is the smaller of what she pays and the deductible portion. Both are the whole total, so all of it counts.', {
          pricing: true,
          board: [
            { do: 'write', card: '7g', size: 40 },
            { do: 'value', target: { card: '7g', find: 'P', nth: 0 }, text: grouped(k.P), when: 0.5 },
            { do: 'value', target: { card: '7g', find: 'κ', nth: 0 }, text: grouped(k.kappa), when: 0.75 }
          ]
        }),
        N("fc hashes the facts of the fill: prescription hash, pharmacy wallet, drug-code hash, quantity times a thousand, ingredient cost, fee and date of service. S hashes fc with the money, P, Q and kappa. That settlement commitment goes into the prescription's own transaction tree.", {
          board: [
            { do: 'write', card: '7h', size: 34 },
            { do: 'value', target: { card: '7h', find: 'Q', nth: 0 }, text: grouped(k.Q), when: 0.62 },
            { do: 'circle', target: { card: '7h', find: 'S=' }, color: 'red', when: 0.8 },
            { do: 'annotate', text: "into the prescription's transaction tree", near: { card: '7h', find: 'S=' }, side: 'below', color: 'red' },
            { do: 'annotate', text: 'engine only (A-22)', near: { card: '7h', line: 1 }, side: 'right', color: 'red', when: 0.92 }
          ]
        }),
        N('The proof also outputs F-prime, her new eligibility forest root. Before recording anything, the engine rebuilds it from her own year and limits, with kappa, P and Q added to what she has paid, along the same path at leaf one twenty-seven. If it does not equal F-prime, the engine throws and records nothing.', {
          board: [
            { do: 'write', card: '7j', size: 28 },
            { do: 'circle', target: { card: '7j', find: 'd+κ' }, color: 'blue', when: 0.55 },
            { do: 'circle', target: { card: '7j', find: 'o+P' }, color: 'blue', when: 0.62 },
            { do: 'circle', target: { card: '7j', find: 'b+Q' }, color: 'blue', when: 0.69 }
          ]
        }),
        N('Then it keeps the outputs and drops the proof. Nobody outside the engine verifies a fill proof yet.', {
          board: [{ do: 'check', target: { card: '7j' }, label: 'rebuilt: match' }]
        })
      ]
    },
    'status-update': {
      queued: [N('No screen shows the next part either. The engine queued a wallet update for Avery and parked the claim against it. Her phone checks for work every twenty seconds.')]
    },
    'board-update': {
      lines: [
        N('The claim reaches the ledger through a proof the phone makes.', { board: [{ do: 'clear' }, { do: 'title', text: "The phone's update proof" }] }),
        N("First the phone checks the engine's work: it rebuilds the credential from the leaves it was sent, F-star being their forest root, in slot zero of a fresh inventory, and refuses unless that gives C-new. The update carries no amounts; this checks only that the root adds up. Then the proof: W from the six private values, a lifecycle state, ell, that is not four, which means revoked, and her leaf moving from C-old and nonce n to C-new and n plus one.", {
          board: [
            { do: 'write', card: '8', size: 26 },
            { do: 'box', target: { card: '8', line: 1 }, color: 'blue', when: 0.42 },
            { do: 'annotate', text: 'no amounts: only the root', near: { card: '8', line: 1 }, side: 'below', color: 'blue' },
            { do: 'circle', target: { card: '8', findRe: 'l\\W{1,3}4' }, color: 'red', when: { word: 'revoked', at: 0.78 } }
          ]
        })
      ]
    },
    'status-accepted': {
      accepted: [N('Accepted, at the same gate as her registration. The sequencer attached the claim the engine parked for exactly this wallet and this root.')],
      caveat: [N('One caveat: the amounts ride along from the engine, and nothing outside the engine checks them against the fill proof yet. The engine did check its own record against that proof first.')]
    },
    'board-ledger': {
      lines: [
        N('Accepting that proof, the sequencer wrote two records.', { board: [{ do: 'clear' }, { do: 'title', text: 'What the sequencer wrote' }] }),
        N("First, the audit event. E-k hashes eleven values: the wallet, four roots, the sequence number k, a registration flag, the drug-code hash, P, Q, and op, one for a fill. Chi-k hashes the previous link with E-k, from the hash of zero. Change any past event's hash and every later link stops matching.", {
          board: [
            { do: 'write', card: '9', size: 32 },
            { do: 'circle', target: { card: '9', find: 'P,Q' }, color: 'red', when: 0.45 },
            { do: 'annotate', text: "from the engine's parked claim", near: { card: '9', find: 'P,Q' }, side: 'below', color: 'red' },
            { do: 'arrow', from: { card: '9', find: 'χprev' }, to: { card: '9', find: 'χk=' }, color: 'blue', bend: -0.35, when: 0.75 }
          ]
        }),
        N("Second, the claim leaf. L-j hashes nine values: Avery's wallet, the drug-code hash, both providers' wallets, the hashed date, P, Q, op and kappa. It is appended at the next free leaf of a tree twenty-four levels deep, with room for more than eight million claims, whose root is stored with every batch.", {
          board: [
            { do: 'write', card: '10', size: 34 },
            { do: 'circle', target: { card: '10', find: 'H(dos)' }, color: 'red', when: 0.5 },
            { do: 'annotate', text: 'append-only, height 24', near: { card: '10', line: 2 }, side: 'right', color: 'blue', when: 0.8 }
          ]
        }),
        N('Neither record holds her name. Both hold the money. And the drug is not hidden, by design: beside both records, the sequencer keeps its code and name in plain text, so the plan can track what it spends on each drug.', {
          board: [{ do: 'annotate', text: 'no member names', color: 'green', size: 30 }]
        })
      ]
    },
    batch: {
      intro: [N(`This is the sequencer's own dashboard. In this boot it builds a batch every ${sayNumber(c.network.batchSeconds)} seconds, from at most two accepted proofs.`)],
      batch: [N("This batch holds Avery's update. Its record carries the claims root. Two replicas copy the sequencer's receipt and new roots for every accepted proof; they don't re-check the proofs yet.")]
    },
    'board-batch': {
      lines: [
        N("The batch proof re-verifies accepted proofs inside a circuit. wrapSingle wraps one proof and outputs its roots and counts. wrapPair takes two and checks they chain: the first one's new roots are the second one's old roots. mergeBatches would join batches the same way, but at two proofs per batch it never runs, and no chain proof runs above it yet.", {
          board: [
            { do: 'clear' }, { do: 'title', text: 'The batch proof' },
            { do: 'write', card: '11', size: 24 },
            { do: 'underline', target: { card: '11', line: 2 }, color: 'blue', when: { word: 'chain', at: 0.5 } },
            { do: 'box', target: { card: '11', find: 'mergeBatches' }, color: 'red', when: 0.78 },
            { do: 'annotate', text: 'does not run at two per batch', near: { card: '11', find: 'mergeBatches' }, side: 'below', color: 'red' }
          ]
        }),
        N('Anyone can check a batch proof against a key they compile themselves.')
      ]
    },
    audit: {
      chain: [L('analyst', 'Daily checks. Chain integrity.')],
      balance: [L('analyst', 'Financial balance. Good.')],
      after: [N("Chain integrity re-walks the chain from the hash of zero, recomputing each link from the stored event hashes. Financial balance checks, fill by fill, that patient pay plus plan pay equals cost plus fee. The sequencer's own version also compares the chain's totals with the claim ledger's; this tab doesn't call it.")]
    },
    pickup: {
      claim: [L('member', 'There it is.', { mood: MOOD.relieved })],
      read: [N('The phone reads its claims from the sequencer, signed with its wallet key. The card shows the drug, the split, and the pharmacy as a wallet hash.')],
      deductible: [L('member', 'So that went toward my deductible.', { mood: MOOD.relieved })],
      closing: [N('These totals are sums over her claim leaves. All along, her name, birth date and cardholder ID stayed on her phone. Fernhill never learned her wallet ID. The doctor saw a short hash, the pharmacy a wallet ID inside a signed attestation. The insurer holds the salt and one key share per card, released only for the right recovery PIN.')],
      unfinished: [N("Two parts are unfinished. Nobody outside the engine verifies the fill proof yet, and the amounts on the ledger are the engine's word, tied to the phone's proof but not to the fill proof. That is the claim, as the code runs it today.")]
    }
  };
  // every claim amount is a slot: fill them all from this cast's claim (predicted, or the engine's once it is known)
  for (const beats of Object.values(S)) for (const lines of Object.values(beats)) for (const l of lines) l.text = fillSlots(l.text, k.slots);
  return S;
}

/** Every line of the script, flattened (voice-check, voice-audition and the director's pre-render use it). */
export function allLines(c, { upTo } = {}) {
  const S = storyLines(c);
  const out = [];
  for (const sc of SCENES) {
    const beats = S[sc.key] || {};
    for (const [beat, lines] of Object.entries(beats)) for (const l of lines) out.push({ scene: sc.key, beat, ...l });
    if (upTo && sc.key === upTo) break;
  }
  return out;
}
