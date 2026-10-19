/**
 * What the walkthrough says, scene by scene, and the cast it says it about. THE LINES HERE ARE PLACEHOLDERS: the
 * final script is being written separately and drops into storyLines() with the same shape. Everything else in this
 * file (the people, the acts, the scene order, the cast's numbers and the board actions' structure) is what
 * director.mjs, voice-check.mjs, voice-audition.mjs and whiteboard-preview.mjs rely on.
 *
 * Shape (keep it when the final script lands):
 *   storyLines(c)[sceneKey][beatName] = [ line, ... ]
 *   line = { who, text, mood?, estMs?, board? }
 *     who     a PEOPLE key (narrator, analyst, hr, member, prescriber, pharmacist)
 *     text    what is said; captions show it as written, lib/narrate.mjs toSpeech() makes the spoken form
 *     mood    a lib/narrate.mjs MOODS key (delivery hints for the engines that use them)
 *     estMs   a rehearsal's stand-in length when no voice is rendered (otherwise ~2.6 words a second)
 *     board   whiteboard actions run while this line plays (director.mjs runBoard):
 *             { do: 'clear' | 'title' | 'write' | 'annotate' | 'value' | 'circle' | 'underline' | 'box' | 'arrow' | 'check' | 'erase' | 'pen',
 *               when: 'start' | 0.4 (a fraction of the clip) | { word: 'group' } (from saved word times) | 'end',
 *               card: '2b'  (write: an equation key from lib/equations.mjs; its board id is 'eq-2b'),
 *               target: { card: '2b', find: 'f5' } | { card, line: 2 } | 'eq-2b' | { x, y, w, h },
 *               text, color: 'ink' | 'blue' | 'red' | 'green', size, side, ms, ... }
 * The director calls the beats it knows for each scene (see BEATS) at the matching moment of the real UI flow; a
 * beat the script leaves out is skipped with a warning, so the script can grow or shrink without code changes.
 *
 * Every number the people say comes from castOf(c), which takes it from the published plan and prices the fill with
 * the same arithmetic as the fill circuit (lib/equations.mjs cards 7b to 7g), before any voice is rendered.
 * Every person here is fictional. Provider names were checked against NPPES by the script preparation; web-search
 * every name (the employer too) again before publishing.
 */

export const SCRIPT_STATUS = 'placeholder';

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

export const ACTS = Object.freeze({ 1: 'The plan and the employer', 2: 'The member enrolls', 3: 'The prescription and the fill', 4: 'The ledger' });

/**
 * The scenes in the order the UI enforces (prepare:screens): the recovery PIN is typed with the code; the group is
 * created in the Employer Dashboard; at the pharmacy it is Fill, then the attestation and Verify, then Dispense, then
 * Payment Received; the claim shows on the phone only after the phone's background proof.
 * camera: the shot director.mjs cuts to. kind: screen | board | status.
 */
export const SCENES = Object.freeze([
  { key: 'plan', act: 1, kind: 'screen', camera: 'insurer', title: 'The insurer publishes a plan' },
  { key: 'apply', act: 1, kind: 'screen', camera: 'employer:marketplace', title: 'HR picks the plan and applies' },
  { key: 'review', act: 1, kind: 'screen', camera: 'insurer', title: 'The insurer asks for the EIN letter' },
  { key: 'docs', act: 1, kind: 'screen', camera: 'employer:marketplace', title: 'HR uploads the letter' },
  { key: 'approve', act: 1, kind: 'screen', camera: 'insurer', title: 'The insurer approves' },
  { key: 'sign', act: 1, kind: 'screen', camera: 'employer:marketplace', title: 'HR signs; the employer node starts' },
  { key: 'group', act: 1, kind: 'screen', camera: 'employer:node', title: 'HR creates the benefit group' },
  { key: 'codes', act: 1, kind: 'screen', camera: 'employer:hrtool', title: 'HR issues enrollment codes' },
  { key: 'enroll', act: 2, kind: 'screen', camera: 'member', title: 'The member enrolls on her phone' },
  { key: 'board-wallet', act: 2, kind: 'board', camera: 'board', title: 'From identity to wallet ID' },
  { key: 'board-registration', act: 2, kind: 'board', camera: 'board', title: 'What the registration proof says' },
  { key: 'enrolled', act: 2, kind: 'screen', camera: 'member', title: 'Enrollment complete' },
  { key: 'status-registration', act: 2, kind: 'status', camera: 'status', title: 'Registration, behind the screen' },
  { key: 'pcp', act: 2, kind: 'screen', camera: 'member', title: 'The member picks her doctor' },
  { key: 'prescribe', act: 3, kind: 'screen', camera: 'prescriber', title: 'The doctor writes the prescription' },
  { key: 'fill', act: 3, kind: 'screen', camera: 'pharmacy', title: 'The pharmacy fills it' },
  { key: 'attest', act: 3, kind: 'screen', camera: 'member', title: 'At the counter: the phone’s attestation' },
  { key: 'verify-dispense', act: 3, kind: 'screen', camera: 'pharmacy', title: 'Verify, then dispense' },
  { key: 'board-deductible', act: 3, kind: 'board', camera: 'board', title: 'Inside the fill proof: the deductible' },
  { key: 'board-settlement', act: 3, kind: 'board', camera: 'board', title: 'Copay, credit, settlement' },
  { key: 'pay', act: 3, kind: 'screen', camera: 'pharmacy', title: 'The price, and payment at the register' },
  { key: 'status-update', act: 4, kind: 'status', camera: 'status', title: 'The phone proves the claim update' },
  { key: 'board-ledger', act: 4, kind: 'board', camera: 'board', title: 'What the ledger keeps' },
  { key: 'batch', act: 4, kind: 'screen', camera: 'network', title: 'The batch' },
  { key: 'audit', act: 4, kind: 'screen', camera: 'insurer', title: 'The insurer checks the books' },
  { key: 'pickup', act: 4, kind: 'screen', camera: 'member', title: 'The member sees her claim' }
]);

/** The beats director.mjs calls, per scene, in order. Board and status scenes speak all their beats in order. */
export const BEATS = Object.freeze({
  plan: ['intro', 'name', 'cents', 'limits', 'create', 'after'],
  apply: ['plans', 'choose', 'details', 'submit', 'after'],
  review: ['row', 'request'],
  docs: ['asked', 'upload'],
  approve: ['check', 'approve'],
  sign: ['scroll', 'sign', 'activation', 'token'],
  group: ['token', 'form', 'after'],
  codes: ['setup', 'group', 'import', 'preview', 'expiry', 'channels', 'after'],
  enroll: ['intro', 'new', 'pin', 'code', 'recovery', 'identity', 'redeem'],
  enrolled: ['cards', 'explain', 'enter'],
  pcp: ['choose', 'set', 'after'],
  prescribe: ['patient', 'pharmacy', 'drug', 'directions', 'refills', 'send', 'proof'],
  fill: ['read', 'fill', 'after'],
  attest: ['ask', 'copy', 'explain'],
  'verify-dispense': ['verified', 'dispense', 'proving'],
  pay: ['price', 'question', 'answer', 'relief', 'counsel', 'after'],
  batch: ['intro', 'batch'],
  audit: ['chain', 'balance', 'after'],
  pickup: ['claim', 'dashboard', 'closing']
});

// ------------------------------------------------------------------ the cast and its numbers

const cents = (n) => `$${(Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymd = (d) => d.toISOString().slice(0, 10);
const lastDayOfNextMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));

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
 * The cast as the lines tell it. Every name, value and number the people say or type comes from here.
 * `input` overrides any default (the final script may change names, plan values or the drug).
 */
export function castOf(input = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const tag = input.tag || now.toISOString().slice(2, 10).replace(/-/g, '') + now.toISOString().slice(11, 16).replace(':', '');
  const plan = { name: 'Standard Rx 2026', id: 'PLAN-STD-RX-2026', copayCents: 1000, deductibleCents: 50000, oopCents: 780000, annualCents: 10000000, famDedCents: 100000, famOopCents: 1600000, coverage: 'pharmacy', ...(input.plan || {}) };
  const altPlan = input.altPlan === null ? null : { name: 'Low Deductible Rx 2026', id: 'PLAN-LOWDED-RX-2026', copayCents: 2500, deductibleCents: 20000, oopCents: 600000, annualCents: 10000000, famDedCents: 40000, famOopCents: 1200000, coverage: 'pharmacy', ...(input.altPlan || {}) };
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
  // match strings for the provider lists: the fictional providers.json rows the take boots with
  const prescriber = { display: PEOPLE.prescriber.name, match: 'Fallowmere', ...(input.prescriber || {}) };
  const pharmacy = { display: 'Kettleby Pharmacy', match: 'Kettleby', ...(input.pharmacy || {}) };
  const drug = {
    name: 'Allopurinol 100 mg tablet', match: 'ALLOPURINOL', strengthMatch: '100', ndc: '00378-0137-01', quantity: 30, daysSupply: 30, refills: 0,
    directions: 'Take 1 tablet by mouth daily after a meal', diagnosis: 'Gout', nadacPerUnit: 0.0394, feeCents: 1300, formularyCopayCents: 1000,
    ...(input.drug || {})
  };
  const ing = Math.round(drug.nadacPerUnit * drug.quantity * 100);
  const accStart = { D: plan.deductibleCents, d: 0, M: plan.oopCents, o: 0, B: plan.annualCents, b: 0 };
  const price = priceFill({ ing, fee: drug.feeCents, c: drug.formularyCopayCents, acc: accStart, fam: { Mh: plan.famOopCents, oBar: 0, Bh: 0, bBar: 0 } });
  return {
    tag, now: now.toISOString(), plan, altPlan, employer, group, member, roster, codes, prescriber, pharmacy, drug,
    pricing: { ingredientCents: ing, feeCents: drug.feeCents, ...price },
    say: {
      deductible: cents(plan.deductibleCents), oop: cents(plan.oopCents), famOop: cents(plan.famOopCents), copay: cents(plan.copayCents),
      ingredient: cents(ing), fee: cents(drug.feeCents), total: cents(price.T), patientPay: cents(price.P), planPay: cents(price.Q),
      credit: cents(price.kappa)
    }
  };
}

// ------------------------------------------------------------------ the lines (placeholders)

const P = (who, text, extra = {}) => ({ who, text, ...extra });
const N = (text, extra = {}) => P('narrator', text, { mood: MOOD.precise, ...extra });

/** The story, beat by beat. Placeholder wording; the final script keeps this shape. */
export function storyLines(c) {
  return {
    plan: {
      intro: [N('[placeholder] One claim, start to finish, on the real dashboards. It starts with a plan, built by the insurer\'s analyst.')],
      name: [P('analyst', `[placeholder] ${c.plan.name}.`, { mood: MOOD.dry })],
      cents: [P('analyst', '[placeholder] Everything on this form is in cents.', { mood: MOOD.dry })],
      limits: [P('analyst', `[placeholder] ${c.say.deductible} deductible, ${c.say.oop} out-of-pocket.`, { mood: MOOD.dry })],
      create: [P('analyst', '[placeholder] Create.', { mood: MOOD.dry })],
      after: [N('[placeholder] The insurer node publishes the plan to the sequencer network, signed with the insurer key.')]
    },
    apply: {
      plans: [P('hr', '[placeholder] Two plans.', { mood: MOOD.brisk })],
      choose: [P('hr', `[placeholder] ${c.plan.name}. That's the one we budgeted.`, { mood: MOOD.brisk })],
      details: [P('hr', `[placeholder] Effective today. Cap of ${c.employer.cap}.`, { mood: MOOD.brisk })],
      submit: [P('hr', '[placeholder] Submit.', { mood: MOOD.brisk })],
      after: [N('[placeholder] Her browser made an Ed25519 key pair and kept the private half in page memory.')]
    },
    review: {
      row: [P('analyst', `[placeholder] ${c.employer.company}. No IRS letter attached.`, { mood: MOOD.dry })],
      request: [P('analyst', '[placeholder] Request docs.', { mood: MOOD.dry })]
    },
    docs: {
      asked: [P('hr', '[placeholder] They want our CP 575.', { mood: MOOD.brisk })],
      upload: [P('hr', '[placeholder] I have it. Uploading.', { mood: MOOD.brisk })]
    },
    approve: {
      check: [P('analyst', '[placeholder] Letter is in. Name and EIN match.', { mood: MOOD.dry })],
      approve: [P('analyst', '[placeholder] Approved.', { mood: MOOD.dry })]
    },
    sign: {
      scroll: [P('hr', '[placeholder] It will not let me sign until I scroll to the end.', { mood: MOOD.brisk })],
      sign: [P('hr', `[placeholder] ${c.employer.signerTitle}. Attest. Sign.`, { mood: MOOD.brisk })],
      activation: [N('[placeholder] Her key signs the agreement; the insurer counter-signs; the sequencer registers the employer; a separate employer node starts.')],
      token: [P('hr', '[placeholder] Node address. Admin token, shown once. Copying it now.', { mood: MOOD.brisk })]
    },
    group: {
      token: [P('hr', '[placeholder] Token is in.', { mood: MOOD.brisk })],
      form: [P('hr', '[placeholder] One group for the lab staff, on the standard plan.', { mood: MOOD.brisk })],
      after: [N('[placeholder] This node belongs to the employer alone and accepts a group only on a plan the employer bought.')]
    },
    codes: {
      setup: [P('hr', '[placeholder] Node address. Token. Passphrase, twice.', { mood: MOOD.brisk })],
      group: [P('hr', '[placeholder] Lab staff.', { mood: MOOD.brisk })],
      import: [P('hr', '[placeholder] The roster.', { mood: MOOD.brisk })],
      preview: [P('hr', `[placeholder] ${c.roster.length} rows. Same as the roster.`, { mood: MOOD.brisk })],
      expiry: [P('hr', '[placeholder] Codes expire at the end of next month.', { mood: MOOD.brisk })],
      channels: [P('hr', '[placeholder] Codes go in the letters. PINs go by text. Never together.', { mood: MOOD.brisk })],
      after: [N('[placeholder] The tool hashes each employee and family ID with a secret seed for the group and sends only hashes.')]
    },
    enroll: {
      intro: [N('[placeholder] Days later the member has a letter with a code and a text with a PIN. The member node on port 4001 plays her phone.')],
      new: [P('member', '[placeholder] Okay. New enrollment.', { mood: MOOD.anxious })],
      pin: [P('member', '[placeholder] A PIN for the phone first.', { mood: MOOD.anxious })],
      code: [P('member', '[placeholder] Code from the letter. PIN from the text.', { mood: MOOD.anxious })],
      recovery: [P('member', '[placeholder] And a recovery PIN.', { mood: MOOD.anxious })],
      identity: [P('member', '[placeholder] Cardholder ID, from the card. Name. Birthday.', { mood: MOOD.anxious })],
      redeem: [N('[placeholder] The phone makes an enrollment key, then redeems the code through the insurer with the employer node that issued it.')]
    },
    'board-wallet': {
      lines: [
        N('[placeholder] Here is what the phone just computed.', { board: [{ do: 'clear' }, { do: 'title', text: 'From identity to wallet ID' }] }),
        N('[placeholder] The narrator defines the salt and sigma, then each salted field f0 to f4, and f5, the plain group hash, while card 2 is written.', {
          estMs: 26000,
          board: [{ do: 'write', card: '2', size: 34 }]
        }),
        N('[placeholder] Seven field elements go in: a zero, then f0 to f5. One comes out: W, the wallet ID.', {
          estMs: 9000,
          board: [{ do: 'write', card: '2b', size: 48 }]
        }),
        N('[placeholder] The six inputs stay on the phone. W is the only identity value that leaves it.', {
          estMs: 7000,
          board: [
            { do: 'circle', target: { card: '2b', find: 'f0,f1,f2,f3,f4' }, color: 'blue' },
            { do: 'annotate', text: 'stays on the phone', near: { card: '2b', find: 'f0,f1,f2,f3,f4' }, side: 'below', color: 'blue' },
            { do: 'circle', target: { card: '2b', find: 'f5' }, color: 'red', when: 0.45 },
            { do: 'annotate', text: 'plain hash, no salt', near: { card: '2b', find: 'f5' }, side: 'right', color: 'red' },
            { do: 'box', target: { card: '2b', find: 'W' }, color: 'green', when: 0.75 },
            { do: 'annotate', text: 'leaves the phone', near: { card: '2b', find: 'W' }, side: 'below', color: 'green' }
          ]
        })
      ]
    },
    'board-registration': {
      lines: [
        N('[placeholder] Next, the phone proves W is real without showing what is behind it.', { board: [{ do: 'clear' }, { do: 'title', text: 'What the registration proof says' }] }),
        N('[placeholder] The narrator walks card 4b line by line: the domain tag, the empty slots in both trees, the new leaves, and the public output x.', {
          estMs: 30000,
          board: [
            { do: 'write', card: '4b', size: 34 },
            { do: 'underline', target: { card: '4b', line: 2 }, color: 'blue' },
            { do: 'annotate', text: 'slot is empty', near: { card: '4b', line: 2 }, side: 'right', color: 'blue' },
            { do: 'underline', target: { card: '4b', line: 3 }, color: 'blue' },
            { do: 'box', target: { card: '4b', line: 4 }, color: 'green' },
            { do: 'annotate', text: 'public', near: { card: '4b', line: 4 }, side: 'right', color: 'green' }
          ]
        }),
        N('[placeholder] The sequencer verifies this proof against a key it compiled itself, and checks the roots, before anything changes.', {
          estMs: 9000,
          board: [{ do: 'check', target: { card: '4b', line: 4 }, label: 'verified at the gate' }]
        })
      ]
    },
    enrolled: {
      cards: [P('member', '[placeholder] Write your two recovery cards now. Keep one at home. Okay.', { mood: MOOD.anxious })],
      explain: [N('[placeholder] Each card holds one share of her enrollment key and no wallet ID; the insurer holds the other share.')],
      enter: [P('member', '[placeholder] Done.', { mood: MOOD.relieved })]
    },
    'status-registration': {
      lines: [N('[placeholder] No product screen shows this part, so this card is drawn from the network\'s own answers.', { estMs: 6000 }),
        N('[placeholder] The narrator explains the receipt, the engine record with her plan\'s limits, and the first credential update.', { estMs: 14000 })]
    },
    pcp: {
      choose: [P('member', `[placeholder] Providers. ${c.prescriber.display}. That's who I saw.`, { mood: MOOD.warm })],
      set: [P('member', '[placeholder] Primary care. Done.', { mood: MOOD.relieved })],
      after: [N('[placeholder] The engine checks the doctor is credentialed and active; the phone proves the update and posts a signed link.')]
    },
    prescribe: {
      patient: [P('prescriber', '[placeholder] New patient on my list. That is her.', { mood: MOOD.kind })],
      pharmacy: [P('prescriber', `[placeholder] ${c.pharmacy.display}. Her usual.`, { mood: MOOD.kind })],
      drug: [P('prescriber', '[placeholder] Generic, then. Allopurinol, a hundred milligrams.', { mood: MOOD.kind })],
      directions: [P('prescriber', '[placeholder] One a day, after a meal. Thirty.', { mood: MOOD.kind })],
      refills: [P('prescriber', '[placeholder] No refills until I see her labs.', { mood: MOOD.kind })],
      send: [P('prescriber', '[placeholder] Send.', { mood: MOOD.kind })],
      proof: [N('[placeholder] On her screen the patient is a short hash. The doctor\'s node encrypts the e-script for the pharmacy and the phone.')]
    },
    fill: {
      read: [P('pharmacist', `[placeholder] Allopurinol, hundred milligram, ${c.drug.quantity}.`, { mood: MOOD.wry })],
      fill: [P('pharmacist', '[placeholder] Filled. Now we wait for her.', { mood: MOOD.wry })],
      after: [N('[placeholder] Fill only marks the script filled. Nothing is priced yet.')]
    },
    attest: {
      ask: [P('pharmacist', '[placeholder] Can you pull up your pharmacy credential? It is under Backup.', { mood: MOOD.wry })],
      copy: [P('member', '[placeholder] Request attestation. Okay, copied.', { mood: MOOD.warm })],
      explain: [N('[placeholder] The sequencer signed one line with its Ed25519 key. In the product it travels by NFC tap; here, by clipboard.')]
    },
    'verify-dispense': {
      verified: [P('pharmacist', '[placeholder] Signature is good. One script ready.', { mood: MOOD.wry })],
      dispense: [P('pharmacist', '[placeholder] Dispense.', { mood: MOOD.wry })],
      proving: [N(`[placeholder] Dispense sends the quantity, the ingredient cost of ${c.say.ingredient} and the fee of ${c.say.fee}; the engine builds the fill proof.`)]
    },
    'board-deductible': {
      lines: [
        N('[placeholder] Inside that proof, the money starts from her record.', { board: [{ do: 'clear' }, { do: 'title', text: 'Inside the fill proof: the deductible' }] }),
        N('[placeholder] The narrator defines A, the accumulator commitment, over its seven numbers, and A-start.', {
          estMs: 22000,
          board: [
            { do: 'write', card: '5b', size: 40 },
            { do: 'value', target: { card: '5b', find: 'D', nth: 0 }, text: c.plan.deductibleCents.toLocaleString('en-US') },
            { do: 'value', target: { card: '5b', find: 'M', nth: 0 }, text: c.plan.oopCents.toLocaleString('en-US') },
            { do: 'value', target: { card: '5b', find: 'B', nth: 0 }, text: c.plan.annualCents.toLocaleString('en-US') }
          ]
        }),
        N(`[placeholder] The narrator walks card 7b: T is ${c.pricing.T} cents, the whole total fits inside the deductible, so a is zero.`, {
          estMs: 22000,
          board: [
            { do: 'write', card: '7b', size: 36 },
            { do: 'value', target: { card: '7b', find: 'T=', nth: 0 }, text: c.pricing.T.toLocaleString('en-US'), side: 'above' },
            { do: 'value', target: { card: '7b', find: 'a=T' }, text: String(c.pricing.a), side: 'above' }
          ]
        })
      ]
    },
    'board-settlement': {
      lines: [
        N('[placeholder] Then the copay.', { board: [{ do: 'clear' }, { do: 'title', text: 'Copay, credit, settlement' }] }),
        N(`[placeholder] The narrator walks card 7c: still in the deductible, so her base pay is ${c.pricing.pBase} cents.`, {
          estMs: 16000,
          board: [{ do: 'write', card: '7c', size: 34 }]
        }),
        N('[placeholder] The benefit, out-of-pocket and family caps come next; none of them binds today.', {
          estMs: 8000,
          board: [{ do: 'annotate', text: 'caps: benefit, out-of-pocket, family. None binds.', color: 'blue', size: 26 }]
        }),
        N(`[placeholder] Kappa, the deductible credit: ${c.pricing.kappa} cents.`, { estMs: 7000, board: [{ do: 'write', card: '7g', size: 34 }] }),
        N('[placeholder] Two commitments: fc over the facts of the fill, and S, the settlement, into the prescription\'s transaction tree.', {
          estMs: 16000,
          board: [{ do: 'write', card: '7h', size: 36 }, { do: 'circle', target: { card: '7h', find: 'S=' }, color: 'red' }]
        })
      ]
    },
    pay: {
      price: [P('pharmacist', `[placeholder] ${c.say.patientPay} today.`, { mood: MOOD.wry })],
      question: [P('member', `[placeholder] Oh. I thought it was a ${c.say.copay} copay.`, { mood: MOOD.anxious })],
      answer: [P('pharmacist', `[placeholder] It will be, once you have met your deductible. All of it counts toward your ${c.say.deductible}.`, { mood: MOOD.wry })],
      relief: [P('member', '[placeholder] Okay. That is less than I was bracing for.', { mood: MOOD.relieved })],
      counsel: [P('pharmacist', '[placeholder] Take it after a meal, with plenty of water.', { mood: MOOD.kind })],
      after: [N('[placeholder] Payment Received is the pharmacy\'s own note. The claim is parked on the sequencer, waiting for one more proof, from her phone.')]
    },
    'status-update': {
      lines: [N('[placeholder] Her phone checks for work every twenty seconds, rebuilds the new root from the parts it was sent, and proves the update.', { estMs: 14000 }),
        N('[placeholder] One caveat: the amounts ride along from the engine; nothing outside the engine checks them against the fill proof yet (A-22).', { estMs: 10000 })]
    },
    'board-ledger': {
      lines: [
        N('[placeholder] When the sequencer accepts that proof, it writes two records.', { board: [{ do: 'clear' }, { do: 'title', text: 'What the ledger keeps' }] }),
        N('[placeholder] The narrator walks card 9: the audit event over eleven values, and the hash chain.', {
          estMs: 20000,
          board: [
            { do: 'write', card: '9', size: 36 },
            { do: 'circle', target: { card: '9', find: 'P,Q' }, color: 'red' },
            { do: 'arrow', from: { card: '9', find: 'χprev' }, to: { card: '9', find: 'χk=' }, color: 'blue', bend: -0.35 }
          ]
        }),
        N('[placeholder] The narrator walks card 10: the claim leaf over nine values, appended to a tree of height 24.', {
          estMs: 18000,
          board: [
            { do: 'write', card: '10', size: 36 },
            { do: 'circle', target: { card: '10', find: 'H(dos)' }, color: 'red' },
            { do: 'annotate', text: 'append-only, height 24', near: { card: '10', line: 2 }, side: 'right', color: 'blue' }
          ]
        }),
        N('[placeholder] Neither record holds a name. Both hold the money.', { estMs: 4000, board: [{ do: 'annotate', text: 'no names', color: 'green', size: 30 }] })
      ]
    },
    batch: {
      intro: [N('[placeholder] This is the sequencer\'s own dashboard; it builds a batch on a timer from at most two accepted proofs.')],
      batch: [N('[placeholder] The batch proof re-verifies those proofs in a circuit and outputs the first and last roots; the claims root is stored beside it.')]
    },
    audit: {
      chain: [P('analyst', '[placeholder] End of day. Chain integrity.', { mood: MOOD.dry })],
      balance: [P('analyst', '[placeholder] Financial balance. Good.', { mood: MOOD.dry })],
      after: [N('[placeholder] Chain integrity re-walks every audit hash; financial balance checks that patient pay plus plan pay equals cost on every fill.')]
    },
    pickup: {
      claim: [P('member', `[placeholder] There it is. ${c.say.patientPay}.`, { mood: MOOD.relieved })],
      dashboard: [P('member', `[placeholder] ${c.say.patientPay} of ${c.say.deductible}. At least I can see where I am.`, { mood: MOOD.relieved })],
      closing: [N('[placeholder] Her name, birth date and cardholder ID stayed on her phone all day. One claim, end to end.')]
    }
  };
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
