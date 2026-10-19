/**
 * The whiteboard's equations, in story order: all 32 cards of the math preparation ("prepare:math"), copied verbatim
 * (LaTeX, terms, plain words, who computes it, who sees the result, and the file:line source of each). Generated from
 * the preparation file, never retyped; do not edit the LaTeX here by hand. The board finds the parts it circles by
 * glyph search ({ eq, find }), so the LaTeX never needs editing for the camera.
 *
 * Keys are the card numbers: eq('2b') is the wallet ID, eq('7b') the deductible phase, eq('10') the claim leaf.
 * Line numbers in src/adjudication/interactive-service.ts and interactive-routes.ts are cited at HEAD baa34db, except on
 * cards 5c, 7, 7b and 7c and in notes 3 and 4 and the worked numbers, which were brought up to date by hand for
 * plan-bound formularies and NADAC pricing (owner decisions 2026-10-18) and cite the commits that brought them. Their
 * LaTeX is unchanged: only where the copay, the ingredient cost and the fee come from changed.
 *
 * MATH_NOTES is the preparation's summary: the notation and the points that must be said correctly on camera.
 */

export const MATH_NOTES = "32 whiteboard cards, in story order. Every equation is taken from the code and cited by file:line. Notation: H is o1js Poseidon over the Pallas field. enc is Encoding.stringToFields, hs is hashString, MR is the o1js Merkle path root, and root_eta{i -> v} is a whole tree's root.\n\nLine numbers: another session is editing src/adjudication/interactive-service.ts and interactive-routes.ts right now (git status shows them modified). So those two files are cited at HEAD baa34db. Every other cited file matches HEAD. The edits in progress (ledger billability, provider key slots, rx ID reuse, reversal order) change none of these equations.\n\nGet these right on camera:\n1. The fill proof is made and used only inside the engine, which runs inside the Leviathan sequencer process. Nothing outside the engine verifies it yet (A-22). The sequencer verifies only the phone's wallet-update proof. It attaches the engine's parked claim amounts without checking them against any proof (l2-rpc-server.ts:899-908).\n2. The family deductible inputs are committed in familyCommitment but never change the price. Only the family out-of-pocket and family benefit rules apply (accumulator-fulfillment-program.ts:150,153,448,451).\n3. The formulary root is a private input supplied by the engine. The circuit does not tie it to the member's credential; the engine does, before it proves: the entry and its witness come from the formulary the member's credential names, which for a member with a device is its plan's published formulary (interactive-service.ts:1173-1202, formularyEntryFor).\n4. A member with a device has its own eligibility leaf (ACCESS_CONTROL leaf 0): the hash of the plan the insurer approved, the group hash, the plan's published copay, and the roots of the plan's published formulary and provider network (interactive-service.ts:1113-1130 and 2175-2177). Only fixture members share the record built from the literals PLAN-GOLD-2026 and ACME-CORP, with copay 3000 (interactive-service.ts:4967-4980), and only they still pay the catalog's tier copays.\n5. One salt covers all five salted inputs, not one salt per field. The date of birth is hashed as an integer. The gender code is not in the wallet ID. The insurer holds the salt inside the recovery deposit.\n6. The group hash g is a plain, unsalted hash of the group ID. The per-group seed protects only the employee and family hashes. The family hash the engine sees is HR's hash, hashed again.\n7. A batch holds at most two proofs (MAX_TRANSITIONS_PER_BATCH = 2). So the live batch proof is one wrapSingle or one wrapPair. mergeBatches and ChainProgram exist but do not run, because nothing in production calls setAdminState. That is why the attestation's fr field is 0. Its cc field is the registry root.\n8. The verification key is pinned only if ZKTRIDENT_TRANSITION_VK_HASH is set. If it is unset, the boot prints a warning and keeps going.\n9. Some comments disagree with the code. Use the code:\n   - The hashTokenPIN docstring drops the 0 separator (hr-tool-core.ts:296 vs 310).\n   - The audit docstring says 10 fields, but the code hashes 11 (audit-service.ts:59 vs 65-77).\n   - The claim tree comment says 2^24 leaves, but a height-24 o1js tree holds 2^23 (claim-accumulator-types.ts:33).\n   - ClaimLeaf calls the date a hash. In fact the leaf stores the plain date and the leaf hash applies H to it (claim-accumulator-types.ts:56 vs 80).\n   - The engine console prints 'Public Output (10 Fields)' and '18 witnesses'. The circuit has 12 outputs and 24 private inputs.\n   - The fill result's limits block hard-codes benefit max 0 and family limits 100000 and 1600000 (interactive-service.ts:3539-3545 at HEAD).\n\nWorked numbers for the harness plan: run.ts:269 sets D = 50,000, M = 780,000, B = 0, family OOP max 1,600,000, the plan copay c = 1,500 and the plan's dispensing fee 1,250. The claims are the named drugs at run.ts:242-247, 30 of each, priced by the engine at NADAC x quantity plus the fee.\n- Claim 1, ABACAVIR 300 MG at $0.60042: ing = 1,801 and T = 3,051, so P = 3,051, Q = 0 and kappa = 3,051.\n- Claim 2, ADEFOVIR DIPIVOXIL 10 MG at $23.69832: ing = 71,095, T = 72,345 and r_D = 46,949, so P = 46,949 + 1,500 = 48,449, Q = 23,896 and kappa = 46,949.\n- Claim 3, ABILIFY 10 MG (tier 2) at $18.68756: ing = 56,063 and T = 57,313 with the deductible met, so P = c = 1,500, Q = 55,813 and kappa = 0.\nc is the plan's copay at every tier (run.ts:269), not the drug's tier copay.\n\nI wrote one temporary copy of a HEAD file to the scratchpad by mistake and deleted it at once. No project file was touched.";

export const EQUATIONS = Object.freeze([
  Object.freeze({
    key: "0",
    moment: "0. Notation (first board)",
    latex: "\\begin{gathered}\\mathsf{H}(x_1,\\dots,x_n)=\\mathrm{Poseidon}(x_1,\\dots,x_n)\\in\\mathbb{F}_p,\\qquad p=2^{254}+45560315531419706090280762371685220353\\\\ \\mathsf{enc}(s)=(e_1,\\dots,e_k),\\qquad \\mathsf{hs}(s)=\\mathsf{H}(\\mathsf{enc}(s)),\\qquad \\mathsf{H}(a,\\ \\mathsf{enc}(s))=\\mathsf{H}(a,e_1,\\dots,e_k)\\end{gathered}",
    terms: Object.freeze([
      "H(...) = o1js Poseidon.hash: a sponge over the Pallas base field, width 3, rate 2, 55 full rounds, S-box x^7. The input is zero-padded to an even length, and the output is the first state element. One consequence of the padding: H(x) = H(x, 0).",
      "p = the field modulus 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001.",
      "enc(s) = Encoding.stringToFields(s): the UTF-8 bytes of s packed 31 per field element, little-endian, with a 0x01 stop byte after the last byte.",
      "hs(s) = hashString(s) = H(enc(s)).",
      "A comma before enc(s) splices its elements into the same hash input, as the spread operator does in the code.",
      "dec(x) = the decimal string of a field element (Field.toString()). Integers such as CCYYMMDD dates and cents enter as single field elements."
    ]),
    plain: "Every hash on the board is the same function, Poseidon, over one prime field. Strings go in as packed bytes, and numbers go in as field elements.",
    who_computes: "Every party that hashes: the HR Tool, the employer node, the phone, the engine and the sequencer.",
    who_sees_result: "Not applicable; this card defines the notation.",
    source: "node_modules/o1js/dist/node/bindings/crypto/constants.js:790-795; node_modules/o1js/dist/node/bindings/crypto/poseidon.js:41-63; node_modules/o1js/dist/node/bindings/lib/encoding.js:15-48; node_modules/o1js/dist/node/bindings/lib/encoding.js:80; src/zkp/hash-utils.ts:31-34"
  }),
  Object.freeze({
    key: "1",
    moment: "1. HR imports the employee list (HR Tool on the employer's admin workstation)",
    latex: "\\begin{gathered}s=\\mathsf{H}\\big(3,\\ \\mathsf{enc}(\\mathrm{hex}(\\mathit{seed}_G))\\big)\\\\ e_E=\\mathsf{H}\\big(1,\\ s,\\ \\mathsf{H}(1,\\ \\mathsf{enc}(\\mathit{employeeID}))\\big)\\\\ e_F=\\mathsf{H}\\big(2,\\ s,\\ \\mathsf{H}(2,\\ \\mathsf{enc}(\\mathit{familyID}))\\big)\\end{gathered}",
    terms: Object.freeze([
      "seed_G = the group's 32 random bytes. Only the HR Tool holds it, encrypted at rest under the HR passphrase (scrypt, AES-256-GCM). Private.",
      "hex(seed_G) = its 64-character hex text. The text is what gets encoded, not the raw bytes.",
      "3 = DOMAIN_TAG_SEED; s = the seed field.",
      "1 = DOMAIN_TAG_EMPLOYEE and 2 = DOMAIN_TAG_FAMILY. Each tag is used twice: as the first element of the inner hash and of the outer hash.",
      "employeeID, familyID = the plaintext IDs from HR's CSV. They stay private to the HR Tool.",
      "e_E = employeeIdHash and e_F = familyIdHash, kept as decimal strings."
    ]),
    plain: "The HR Tool hashes each employee ID and family ID together with a secret seed for the group, so the same person gets a different hash in another group. The tags keep an employee hash from ever colliding with a family hash.",
    who_computes: "The HR Tool on the employer's admin workstation (hashEmployeeRecords during CSV import).",
    who_sees_result: "e_E and e_F go to the employer node in POST /tokens/generate and key its roster. The plaintext-to-hash table stays in the HR Tool's encrypted file. The insurer, the phone and the engine never see e_E or e_F; they see only phi, a second hash of e_F (next card).",
    source: "src/tools/hr-tool-core.ts:53-55; src/tools/hr-tool-core.ts:259-277; src/tools/hr-tool-core.ts:454-456; src/tools/hr-tool-server.ts:762; src/tools/hr-tool-server.ts:834-839"
  }),
  Object.freeze({
    key: "1b",
    moment: "1b. The employer node issues the enrollment code",
    latex: "\\begin{gathered}\\mathsf{code}=\\mathrm{b32}\\big(\\mathrm{SHA256}(D_{\\mathrm{route}}\\,\\|\\,\\mathit{employerID})\\big)_{1..4}\\ \\|\\ \\mathrm{b32}(r),\\qquad r\\xleftarrow{\\$}\\{0,1\\}^{80}\\\\ g=\\mathsf{hs}(\\mathit{groupID}),\\quad h_{\\mathrm{plan}}=\\mathsf{hs}(\\mathit{planID}),\\quad \\phi=\\mathsf{hs}(\\mathrm{dec}(e_F)),\\quad \\varepsilon=\\mathsf{hs}(\\mathrm{dec}(e_E)),\\quad \\tau=\\mathsf{hs}(\\mathsf{code})\\end{gathered}",
    terms: Object.freeze([
      "D_route = the text 'zpk.care/enrollment-code/routing/v1' followed by a newline. b32 = Crockford base32 (no I, L, O or U).",
      "The first 4 characters route the code to its issuer. r = 10 random bytes = 16 characters = 80 bits. The code is written PPPP-XXXX-XXXX-XXXX-XXXX.",
      "groupID, planID = the employer group and its plan, as plain strings on the employer node.",
      "g = groupIdHash, a plain hash with no seed. It later becomes the sixth wallet input.",
      "h_plan = planIdHash.",
      "phi = the token's familyIdHash: HR's e_F hashed again as a decimal string. If HR sends no family hash, the employee hash is used instead (employer-routes.ts:221).",
      "epsilon = the token's employeeIdHash, the same double hash of e_E.",
      "tau = tokenIdHash."
    ]),
    plain: "The node makes a random code whose first block names the issuing employer, and it keeps only hashes in the token. The group and plan hashes are plain hashes of their IDs, and the family hash from HR is hashed a second time.",
    who_computes: "The employer node (TokenAuthority.generateToken and buildGroupEnrollmentToken).",
    who_sees_result: "The code goes back to the HR Tool and reaches the employee by letter. At redemption the node answers g, h_plan and phi to the insurer only. The insurer gives g and h_plan to the phone and puts phi in its signed approval to the engine, which groups families by phi.",
    source: "src/onboarding/enrollment-code.ts:49-55; src/onboarding/enrollment-code.ts:86-105; src/onboarding/token-authority.ts:139-170; src/onboarding/group-enrollment-token.ts:113-124; src/nodes/routes/employer-routes.ts:221; src/nodes/routes/insurer-routes.ts:429-439; src/nodes/routes/insurer-routes.ts:488-494"
  }),
  Object.freeze({
    key: "1c",
    moment: "1c. HR's PIN, checked when the phone redeems the code",
    latex: "\\begin{gathered}\\mathit{PIN}\\xleftarrow{\\$}\\{0,\\dots,10^8-1\\}\\ \\text{(8 digits)}\\\\ h_{\\mathrm{PIN}}=\\mathsf{H}\\big(\\mathsf{enc}(\\mathsf{code}),\\ 0,\\ \\mathsf{enc}(\\mathit{PIN})\\big)\\\\ \\text{redeem}\\iff h_{\\mathrm{PIN}}^{\\mathrm{phone}}=h_{\\mathrm{PIN}}^{\\mathrm{HR}}\\quad(\\text{locked after 5 failures})\\end{gathered}",
    terms: Object.freeze([
      "PIN = 8 digits as text, with leading zeros, uniform by rejection sampling below 4,200,000,000.",
      "code = the canonical dashed enrollment code.",
      "0 = a separator field between the two encoded strings.",
      "h_PIN = tokenPinHash, a decimal string. The employer compares the two hashes in constant time and consumes the code on a match."
    ]),
    plain: "The HR Tool hashes the code and the PIN together and sends only that hash to the employer node. At redemption the phone computes the same hash from what the member types, and the employer compares the two.",
    who_computes: "The HR Tool at import and the member's phone at redemption. The employer node does the comparison.",
    who_sees_result: "The employer node stores h_PIN. The phone sends the code and h_PIN to the insurer, which forwards them in a signed request to the issuing employer and keeps h_PIN to answer an identical repeat. The PIN itself is seen only by the HR Tool (once), the employee and the phone.",
    source: "src/tools/hr-tool-core.ts:285-293; src/tools/hr-tool-core.ts:307-313; src/tools/hr-tool-server.ts:828; src/tools/hr-tool-server.ts:863-867; src/nodes/routes/member-routes.ts:396-400; src/nodes/routes/insurer-routes.ts:409-437; src/nodes/routes/employer-routes.ts:303-373; src/onboarding/token-authority.ts:264; src/onboarding/token-authority.ts:301-307; src/onboarding/token-authority.ts:340-355"
  }),
  Object.freeze({
    key: "2",
    moment: "2. The phone hashes each identity field with the member's salt",
    latex: "\\begin{gathered}\\mathit{salt}\\xleftarrow{\\$}\\{0,1\\}^{256},\\qquad \\sigma=\\mathsf{hs}(\\mathit{salt})\\\\ h_\\sigma(v)=\\mathsf{H}\\big(\\sigma,\\ \\mathsf{enc}(v)\\big),\\qquad h^{\\mathrm{date}}_\\sigma(d)=\\mathsf{H}(\\sigma,\\ d)\\\\ f_0=h_\\sigma(\\mathit{cardholderID}),\\ f_1=h^{\\mathrm{date}}_\\sigma(\\mathit{DOB}),\\ f_2=h_\\sigma(\\mathit{firstName}),\\ f_3=h_\\sigma(\\mathit{lastName}),\\ f_4=h_\\sigma(K),\\ f_5=g\\end{gathered}",
    terms: Object.freeze([
      "salt = identitySalt: 32 random bytes as 64 hex characters, one per member, made on the phone. The same salt is used for all five salted fields.",
      "sigma = saltField = hs(salt), the hash of the hex text.",
      "cardholderID, firstName, lastName = typed into the phone. Private.",
      "DOB = the date of birth as the integer CCYYMMDD, entered as one field element rather than as text. Private.",
      "K = the enrollment key: 32 random bytes in base64url (43 characters), made on the phone. Private.",
      "g = the group hash the insurer answered at redemption, used as the sixth input.",
      "f_0..f_5 = the wallet preimage, saved on the phone as decimal strings."
    ]),
    plain: "The phone mixes one random salt into every identity hash, so a name or birth date cannot be found by guessing. The enrollment key is hashed the same way, and the group hash is the sixth input.",
    who_computes: "The member's phone (the derive-wallet route of the member node).",
    who_sees_result: "f_0 to f_5 never leave the phone; they are private inputs to its proofs. The salt also sits in the insurer's recovery deposit. The form accepts a gender code, but it is not used.",
    source: "src/zkp/hash-utils.ts:113-126; src/wallets/wallet-derivation.ts:63-74; src/wallets/wallet-derivation.ts:140-150; src/nodes/routes/member-routes.ts:518-528; src/security/secure-context.ts:68-76"
  }),
  Object.freeze({
    key: "2b",
    moment: "2b. The phone derives the wallet ID",
    latex: "W=\\mathsf{H}\\big(0,\\ f_0,\\ f_1,\\ f_2,\\ f_3,\\ f_4,\\ f_5\\big)",
    terms: Object.freeze([
      "0 = DOMAIN_TAG_MEMBER (prescriber 1, pharmacy 2, representative 3).",
      "f_0..f_5 = the six fields from the previous card.",
      "W = walletId, the wallet's address. There is no private key behind it."
    ]),
    plain: "Seven field elements go in and one comes out: the wallet ID. It is the only identity value that leaves the phone.",
    who_computes: "The member's phone.",
    who_sees_result: "The insurer, the sequencer and the engine, and later the prescriber's patient list and the pharmacy. The employer never sees it.",
    source: "src/wallets/wallet-derivation.ts:110; src/wallets/wallet-derivation.ts:129-132; src/nodes/routes/member-routes.ts:526-549"
  }),
  Object.freeze({
    key: "3",
    moment: "3. Recovery cards are issued",
    latex: "\\begin{gathered}K_b=\\mathrm{UTF8}(K),\\quad s_1\\xleftarrow{\\$}\\{0,1\\}^{8|K_b|},\\quad s_2=K_b\\oplus s_1,\\quad \\mathit{id}\\xleftarrow{\\$}\\{0,1\\}^{64}\\\\ v_{\\mathrm{PIN}}=\\mathrm{scrypt}\\big(\\mathit{rPIN},\\ D_{\\mathrm{pin}}\\,\\|\\,\\mathit{id};\\ N=2^{15},\\ r=8,\\ p=1,\\ 32\\big)\\\\ \\mathrm{card}=(3,\\ \\mathit{id},\\ s_1),\\qquad \\mathrm{deposit}=(\\mathit{id},\\ s_2,\\ v_{\\mathrm{PIN}},\\ \\mathit{salt},\\ g,\\ h_{\\mathrm{plan}},\\ 0)\\\\ \\text{recovery: release } s_2\\iff v'_{\\mathrm{PIN}}=v_{\\mathrm{PIN}},\\qquad K_b=s_1\\oplus s_2\\end{gathered}",
    terms: Object.freeze([
      "K_b = the enrollment key's 43 UTF-8 bytes.",
      "s_1 = a fresh random pad as long as K_b, written on the card as hex.",
      "s_2 = K_b XOR s_1, the share deposited with the insurer.",
      "id = 8 random bytes (16 hex characters), the card's handle.",
      "rPIN = the recovery PIN, 6 to 32 characters, typed on the phone. Private.",
      "D_pin = the text 'zpk.care/recovery-pin/v1' followed by a newline. The scrypt cost is N = 2^15, r = 8, p = 1 (here p is scrypt's parallelism, not the field modulus), with a 32-byte output, v_PIN.",
      "card = {v: 3, id, s}; deposit = {cardId, share2Hex, pinVerifier, identitySalt, groupIdHash, planIdHash, domainTag 0}. Two cards are issued per enrollment, each with its own id and pad.",
      "v'_PIN = the value a recovering phone computes from the card id and the typed PIN. Ten wrong tries revoke that card's deposit."
    ]),
    plain: "The phone splits the enrollment key into two random-looking shares: one goes on the card, the other goes to the insurer beside a slow hash of the recovery PIN. Neither share alone says anything about the key.",
    who_computes: "The member's phone, for both cards at once. A recovering phone recomputes v'_PIN and XORs the two shares.",
    who_sees_result: "The card holds (3, id, s_1). The insurer holds the deposit, including the salt, and releases s_2, the salt, g, h_plan and the tag only to a matching verifier. The PIN never leaves the phone.",
    source: "src/security/recovery-card.ts:52-55; src/security/recovery-card.ts:272-273; src/security/recovery-card.ts:291-353; src/nodes/routes/member-routes.ts:600-609; src/nodes/routes/member-routes.ts:759-786; src/nodes/routes/insurer-routes.ts:547-591"
  }),
  Object.freeze({
    key: "4",
    moment: "4. The phone's keys, and how every write is signed",
    latex: "\\begin{gathered}\\mathit{seed}^{\\mathrm{sig}}_W=\\mathrm{HKDF}_{\\mathrm{SHA256}}\\big(K,\\ \\texttt{zpk.care},\\ \\texttt{zpk.care wallet signing key v1},\\ 32\\big)\\\\ \\mathit{sk}^{\\mathrm{enc}}_W=\\mathrm{SHA256}(K)\\\\ \\mathrm{sig}=\\mathrm{Ed25519.Sign}\\big(\\mathit{sk},\\ \\mathit{METHOD}\\texttt{:}\\mathit{path}\\texttt{|}\\mathit{ts}\\texttt{|}\\mathrm{SHA256}(\\mathit{body})\\big)\\end{gathered}",
    terms: Object.freeze([
      "K = the enrollment key, used as the input keying material.",
      "zpk.care = the HKDF salt; 'zpk.care wallet signing key v1' = the HKDF info. The 32-byte output is the Ed25519 seed for signing as the wallet.",
      "sk^enc_W = the SHA-256 of K, used as the X25519 private key for messages.",
      "The signed bytes are METHOD:path|ts|SHA256(body), with ts in milliseconds and an empty hash for no body. The header is X-Admin-Signature: signerId:ts:hex(sig).",
      "The verifier recomputes the body hash, allows a clock difference of 30 s either way and refuses a signature it has already seen."
    ]),
    plain: "Both of the phone's keys come from the enrollment key by different routes, so neither public key reveals the other. Each request is signed over its method, path, time and body hash.",
    who_computes: "The phone derives its keys when it needs them and stores neither. Each node signs its own requests; the insurer's code check to the employer is signed with the insurer's node key.",
    who_sees_result: "The public halves are registered on the sequencer, and verifiers check signatures against them.",
    source: "src/security/wallet-key.ts:44-56; src/messaging/encryption.ts:45-50; src/security/signed-request.ts:52; src/security/signed-request.ts:58-66; src/security/signed-request.ts:79-98; src/nodes/routes/employer-routes.ts:345-355"
  }),
  Object.freeze({
    key: "4b",
    moment: "4b. The phone proves registration (StateTransitionProgram.proveRegistration)",
    latex: "\\begin{aligned}&t\\in\\{0,1,2\\},\\qquad W=\\mathsf{H}(0,f_0,f_1,f_2,f_3,f_4,f_5)\\ \\ (t=0)\\\\ &\\mathrm{MR}_{11}(0;\\,w_{\\mathrm{reg}})=R_{\\mathrm{reg}},\\qquad \\mathrm{MR}_{11}(0;\\,w_{\\mathrm{lc}})=R_{\\mathrm{lc}}\\\\ &R'_{\\mathrm{reg}}=\\mathrm{MR}_{11}\\big(\\mathsf{H}(W,\\ C_\\varnothing,\\ 0);\\,w_{\\mathrm{reg}}\\big),\\qquad R'_{\\mathrm{lc}}=\\mathrm{MR}_{11}\\big(\\mathsf{H}(W,\\ 1);\\,w_{\\mathrm{lc}}\\big)\\\\ &x=(W,\\ R_{\\mathrm{reg}},\\ R'_{\\mathrm{reg}},\\ R_{\\mathrm{lc}},\\ R'_{\\mathrm{lc}})\\end{aligned}",
    terms: Object.freeze([
      "t = the domain tag. The circuit computes all three wallet formulas and selects one by t: member H(0, f_0..f_5), prescriber H(1, f_0, f_1, f_2), pharmacy H(2, f_0, f_1, f_2).",
      "f_0..f_5 = private inputs, never revealed.",
      "w_reg, w_lc = Merkle witnesses into the wallet registry and lifecycle trees (height 11, 1,024 slots), fetched from the sequencer.",
      "R_reg, R_lc = the ledger's current roots. MR(0; w) = R asserts that the slot is empty.",
      "H(W, C_empty, 0) = the registry leaf WalletState(walletId, credentialInventoryRoot, nonce).",
      "C_empty = z_6, the root of an empty height-7 credential inventory.",
      "H(W, 1) = the lifecycle leaf, where 1 = REGISTERED.",
      "x = TransitionOutput, the only public part of the proof."
    ]),
    plain: "The proof says: I know six values that hash to this wallet ID, and this wallet goes into an empty slot in both trees. It reveals the wallet ID and the roots, not the six values.",
    who_computes: "The member's phone, after it takes the proving lease.",
    who_sees_result: "The sequencer verifies it and applies it. x is public in the receipt and in the audit chain.",
    source: "src/engine/state-transition.ts:39; src/engine/state-transition.ts:84-104; src/engine/state-transition.ts:147-218; src/engine/lifecycle.ts:35-38; src/engine/lifecycle.ts:48-50; src/wallets/wallet-state.ts:33-39; src/wallets/wallet-state.ts:58-75; src/nodes/routes/member-routes.ts:927-953"
  }),
  Object.freeze({
    key: "4c",
    moment: "4c. The sequencer's acceptance gate (A1), for registration and for every wallet update",
    latex: "\\begin{aligned}&\\text{boot: }\\mathit{vk}_{\\mathrm{ST}}=\\mathrm{compile}(\\mathrm{StateTransitionProgram}),\\qquad \\mathrm{vkHash}(\\mathit{vk}_{\\mathrm{ST}})=h_{\\mathrm{pinned}}\\\\ &\\mathrm{accept}(\\pi)\\iff\\mathrm{Verify}(\\mathit{vk}_{\\mathrm{ST}},\\ x,\\ \\pi)=1\\ \\wedge\\ x.R_{\\mathrm{reg}}=R^{\\mathrm{ledger}}_{\\mathrm{reg}}\\ \\wedge\\ x.R_{\\mathrm{lc}}=R^{\\mathrm{ledger}}_{\\mathrm{lc}}\\ \\wedge\\ (x.R'_{\\mathrm{reg}},\\,x.R'_{\\mathrm{lc}})=(\\widehat{R}'_{\\mathrm{reg}},\\,\\widehat{R}'_{\\mathrm{lc}})\\\\ &(\\widehat{R}'_{\\mathrm{reg}},\\,\\widehat{R}'_{\\mathrm{lc}})=\\begin{cases}\\big(\\mathrm{MR}_{11}(\\mathsf{H}(W,C_\\varnothing,0);\\,i),\\ \\mathrm{MR}_{11}(\\mathsf{H}(W,1);\\,i)\\big), & \\text{registration, } i=\\text{next free slot}\\\\ \\big(\\mathrm{MR}_{11}(\\mathsf{H}(W,C_{\\mathrm{new}},n+1);\\,i_W),\\ R_{\\mathrm{lc}}\\big), & \\text{wallet update}\\end{cases}\\end{aligned}",
    terms: Object.freeze([
      "vk_ST = the StateTransitionProgram verification key, compiled in a separate verifier process that has its own o1js context.",
      "h_pinned = ZKTRIDENT_TRANSITION_VK_HASH. On a mismatch the sequencer refuses to start. If the variable is unset, the boot only warns and prints the hash to pin.",
      "Verify = o1js verify(proof, vk), run on the proof exactly as it was sent, with a 20 s timeout. The program has no public input; x is its public output.",
      "R^ledger = the sequencer's current roots.",
      "R-hat' = the new roots the sequencer computes in its own trees before it changes anything. i = the next free slot (the wallet count); i_W = W's slot; n = the ledger's nonce for W; C_new = the newCredentialInventoryRoot sent beside the proof.",
      "A fingerprint of W and the four roots refuses an identical replay."
    ]),
    plain: "Before it looks at anything else, the sequencer checks the proof against a key it compiled itself. It then requires the proof's old roots to be its current roots and its new roots to match its own recomputation, and only after every check passes do the trees, the log and the audit chain change.",
    who_computes: "The sequencer (the Leviathan leader). Verification runs in a child process.",
    who_sees_result: "The submitter gets a receipt, or a refusal with the reason. An accepted proof enters the audit chain and the batch pool.",
    source: "src/l2/l2-sequencer-service.ts:302-321; src/l2/l2-sequencer-service.ts:340-344; src/l2/l2-sequencer-service.ts:366-386; src/l2/l2-sequencer-service.ts:1579-1634; src/l2/l2-verify-worker.ts:57-99; src/l2/l2-verify-pool.ts:102; src/l2/l2-proof-verifier.ts:54; src/nodes/start-leviathan.ts:245-288"
  }),
  Object.freeze({
    key: "4d",
    moment: "4d. The phone proves wallet ownership to the engine (ProofGate.verifyMember)",
    latex: "\\begin{gathered}\\text{public } W;\\ \\text{private } f_0,\\dots,f_5:\\qquad \\mathsf{H}(0,\\ f_0,\\ f_1,\\ f_2,\\ f_3,\\ f_4,\\ f_5)=W\\\\ \\text{engine accepts}\\iff \\pi_{\\mathrm{own}}.\\mathit{publicInput}=W\\ \\wedge\\ \\mathrm{Verify}(\\mathit{vk}_{\\mathrm{PG}},\\ W,\\ \\pi_{\\mathrm{own}})=1\\end{gathered}",
    terms: Object.freeze([
      "verifyMember: the public input is W. The private inputs are the six fields: the cardholder, date-of-birth, first-name, last-name and enrollment-key hashes, plus the group hash.",
      "vk_PG = the ProofGate key the engine compiles at startup. It is not pinned to a hash.",
      "pi_own = the ownershipProofJson made on the phone."
    ]),
    plain: "The phone proves it knows what is behind its wallet ID without sending it. The engine checks that the proof names this wallet and that it verifies.",
    who_computes: "The member's phone makes the proof; the engine verifies it.",
    who_sees_result: "The engine. It keeps the proof for the portable credential and opens a record only for a wallet the insurer approved.",
    source: "src/wallets/proof-gate.ts:49-81; src/nodes/member-node.ts:122-131; src/nodes/routes/member-routes.ts:989; src/adjudication/interactive-routes.ts:237-265 (HEAD baa34db); src/adjudication/interactive-service.ts:1704-1721 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "5",
    moment: "5. Merkle path root (used by every tree)",
    latex: "\\begin{gathered}\\mathrm{MR}_\\eta(\\ell;\\,w):\\quad u_0=\\ell,\\qquad u_{i+1}=\\begin{cases}\\mathsf{H}(u_i,\\ s_i), & b_i=1\\\\ \\mathsf{H}(s_i,\\ u_i), & b_i=0\\end{cases}\\quad (i=0,\\dots,\\eta-2),\\qquad \\mathrm{root}=u_{\\eta-1}\\\\ z_0=0,\\qquad z_k=\\mathsf{H}(z_{k-1},\\ z_{k-1}),\\qquad \\text{an empty tree of height }\\eta\\text{ has root }z_{\\eta-1}\\end{gathered}",
    terms: Object.freeze([
      "ell = the leaf value, used as is (not hashed again).",
      "w = the witness: one sibling s_i and one bit b_i per level. b_i = 1 means the running node is the left child.",
      "eta = the tree height. A tree of height eta holds 2^(eta-1) leaves. root_eta{i -> v} means the root of a height-eta tree with those leaves and zeros everywhere else.",
      "z_k = the root of an all-zero subtree.",
      "Heights in this system: forest domain trees 8 (128 leaves), credential inventory 7 (64), wallet registry and lifecycle 11 (1,024), formulary 16 (32,768), audit index 20 (524,288), claims 24 (8,388,608)."
    ]),
    plain: "A leaf is in a tree if hashing it with one sibling per level, in the order its position sets, lands on the published root.",
    who_computes: "The circuits, the sequencer, the phone, the engine, and any reader who has a witness.",
    who_sees_result: "The roots are published, and the sequencer hands out the witnesses.",
    source: "node_modules/o1js/dist/node/lib/provable/merkle-tree.js:28-36; node_modules/o1js/dist/node/lib/provable/merkle-tree.js:140-142; node_modules/o1js/dist/node/lib/provable/merkle-tree.js:170-179; node_modules/o1js/dist/node/lib/provable/merkle-tree.js:210-215; src/zkp/merkle-forest.ts:35; src/wallets/wallet-state.ts:33-39; src/access-control/formulary-registry.ts:31; src/audit/audit-merkle-index.ts:40; src/l2/claim-accumulator-types.ts:34"
  }),
  Object.freeze({
    key: "5b",
    moment: "5b. The engine opens the member record: the accumulator commitment",
    latex: "A=\\mathsf{H}\\big(y,\\ D,\\ d,\\ M,\\ o,\\ B,\\ b\\big),\\qquad A_{\\mathrm{start}}=\\mathsf{H}\\big(20260101,\\ D,\\ 0,\\ M,\\ 0,\\ B,\\ 0\\big)",
    terms: Object.freeze([
      "y = the plan-year start CCYY0101 as an integer; 20260101 at registration.",
      "D = the deductible limit and d = the deductible paid, in cents.",
      "M = the out-of-pocket maximum and o = the out-of-pocket paid.",
      "B = the annual benefit maximum and b = the benefit used. A limit of 0 means none.",
      "D, M and B come from the plan the insurer approved, read from the sequencer's plan store (bindPlan).",
      "A is leaf 127 of the ACCESS_CONTROL tree of the member's eligibility credential."
    ]),
    plain: "The member's limits and running totals are seven numbers, and their hash is one leaf in the member's credential.",
    who_computes: "The engine (inside the sequencer process), at registration and after every fill.",
    who_sees_result: "The engine holds the seven values. The phone receives only the leaf A, among the forest leaves of each wallet update.",
    source: "src/access-control/accumulator-data.ts:21; src/access-control/accumulator-data.ts:39-69; src/adjudication/interactive-service.ts:1940-1958 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "5c",
    moment: "5c. The credential's forest root",
    latex: "\\begin{gathered}F_{\\mathrm{elig}}=\\mathsf{H}\\big(r_{\\mathrm{mem}},\\ r_{\\mathrm{pres}},\\ r_{\\mathrm{phar}},\\ r_{\\mathrm{med}},\\ r_{\\mathrm{ac}},\\ r_{\\mathrm{tx}}\\big)\\\\ r_{\\mathrm{ac}}=\\mathrm{root}_8\\{0\\mapsto E_{\\mathrm{elig}},\\ 127\\mapsto A\\},\\qquad r_{\\mathrm{mem}}=r_{\\mathrm{pres}}=r_{\\mathrm{phar}}=r_{\\mathrm{med}}=r_{\\mathrm{tx}}=z_7\\end{gathered}",
    terms: Object.freeze([
      "The domain order is fixed: MEMBER 0, PRESCRIBER 1, PHARMACY 2, MEDICATION 3, ACCESS_CONTROL 4, TRANSACTION 5. Each tree has height 8.",
      "E_elig = the EligibilityData commitment H(planIdHash, groupIdHash, effectiveDate, terminationDate, copay, coverageType, formularyRoot, networkRoot). A member with a device gets its own plan's record: hs(planID) of the plan the insurer approved, the approval's group hash g, the plan's published copay, the root of the plan's published formulary (every entry at that copay) and the root of its provider list (0 when it lists none), with the demo plan year 20260101. A fixture member keeps the shared record built from the literals PLAN-GOLD-2026 and ACME-CORP, with copay 3000.",
      "A = the accumulator commitment at leaf 127.",
      "z_7 = the root of an empty height-8 tree.",
      "F_elig = the forestRoot of the eligibility credential."
    ]),
    plain: "A credential holds a single number for its data, the forest root, which is the hash of six tree roots. In the eligibility credential only the access-control tree is filled, and its last leaf is the accumulator.",
    who_computes: "The engine. The phone rebuilds it from the leaves it is sent, and the fill circuit recomputes it from the six roots.",
    who_sees_result: "The engine and the phone. The ledger stores only the inventory root built on top of it.",
    source: "src/zkp/merkle-forest.ts:35-48; src/zkp/merkle-forest.ts:109-117; src/eligibility/forest-roots.ts:49-58; src/eligibility/eligibility-data.ts:65-76; src/eligibility/eligibility-data.ts:106-119; src/adjudication/interactive-service.ts:1113-1130 (planEligibilityData); src/adjudication/interactive-service.ts:2175-2177 (registerMemberFromEnrollment); src/adjudication/interactive-service.ts:2191-2193; src/onboarding/plan-formulary.ts:76-135; src/adjudication/interactive-service.ts:4967-4980 (fixtures)"
  }),
  Object.freeze({
    key: "5d",
    moment: "5d. The credential, the inventory root, and the move to ELIGIBLE",
    latex: "\\begin{gathered}\\mathit{cc}=\\mathsf{H}\\big(1,\\ F_{\\mathrm{elig}},\\ W_{\\mathrm{ins}},\\ W,\\ 20260201,\\ 0,\\ 0\\big),\\qquad C=\\mathrm{root}_7\\{0\\mapsto \\mathit{cc}\\}\\\\ \\text{lifecycle leaf at }W\\text{'s slot: }\\mathsf{H}(W,1)\\to\\mathsf{H}(W,2)\\ \\ \\text{(insurer admin write, no proof)}\\end{gathered}",
    terms: Object.freeze([
      "1 = CREDENTIAL_TYPE_ELIGIBILITY (2 = PRESCRIPTION).",
      "W_ins = issuerWalletId, the engine's admin wallet. W = subjectWalletId, the member.",
      "20260201 = issuedAt. It is followed by expiresAt 0 (never expires) and revoked 0 (active).",
      "cc = the credential commitment. C = credentialInventoryRoot, the root of the wallet's height-7 inventory with cc in slot 0.",
      "Lifecycle values: 1 REGISTERED, 2 ELIGIBLE, 3 ACTIVE, 4 REVOKED."
    ]),
    plain: "The credential's seven fields hash to one leaf in slot 0 of the wallet's own small tree, and the root C of that tree is what the ledger keeps for the wallet. Separately, an admin write, not a proof, marks the wallet ELIGIBLE.",
    who_computes: "The engine; the phone rebuilds C before it proves the update.",
    who_sees_result: "C reaches the ledger with the phone's wallet-update proof, inside the wallet's registry leaf H(W, C, n). The first such update is the credential mint, C_empty to C, nonce 0 to 1.",
    source: "src/credentials/credential-data.ts:27-28; src/credentials/credential-data.ts:64-74; src/credentials/credential-inventory.ts:68-81; src/engine/lifecycle.ts:35-38; src/l2/l2-sequencer-service.ts:1505-1551; src/adjudication/interactive-service.ts:1961-1982 (HEAD baa34db); src/adjudication/interactive-service.ts:2043 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "6",
    moment: "6. The prescriber writes the prescription",
    latex: "\\begin{gathered}h_{\\mathrm{rx}}=\\mathsf{H}\\big(h_{\\mathrm{ndc}},\\ W_{\\mathrm{pr}},\\ W,\\ \\mathit{written},\\ \\mathit{expires},\\ q_{\\mathrm{rx}},\\ \\mathit{refills}\\big),\\qquad h_{\\mathrm{ndc}}=\\mathsf{hs}(\\mathit{NDC})\\\\ \\mathit{st}_0=\\mathsf{H}\\big(h_{\\mathrm{rx}},\\ 1,\\ W_{\\mathrm{pr}},\\ 20260201,\\ W_{\\mathrm{ph}},\\ 0,\\ 0\\big)\\\\ F_{\\mathrm{rx}}=\\mathsf{H}\\big(z_7,\\ z_7,\\ z_7,\\ \\mathrm{root}_8\\{0\\mapsto h_{\\mathrm{rx}}\\},\\ z_7,\\ \\mathrm{root}_8\\{0\\mapsto \\mathit{st}_0\\}\\big),\\qquad \\mathit{cc}_{\\mathrm{rx}}=\\mathsf{H}\\big(2,\\ F_{\\mathrm{rx}},\\ W_{\\mathrm{pr}},\\ W_{\\mathrm{ph}},\\ 20260201,\\ 0,\\ 0\\big)\\end{gathered}",
    terms: Object.freeze([
      "h_ndc = hs(NDC), the hash of the 11-digit drug code.",
      "W_pr = the prescriber's wallet, W = the member's wallet, W_ph = the chosen pharmacy's wallet.",
      "written, expires = CCYYMMDD integers. The engine uses the literals 20260201 and 20270201 today.",
      "q_rx = the quantity prescribed x1000; refills = the number of refills authorized.",
      "st_0 = the first status leaf: status 1 = ADJUDICATED, updated by the prescriber, fill quantity 0, notes 0.",
      "F_rx = the prescription credential's forest root: MEDICATION leaf 0 = h_rx and TRANSACTION leaf 0 = st_0.",
      "cc_rx = the prescription credential: type 2, issued by the prescriber, held by the pharmacy."
    ]),
    plain: "The prescription is seven values hashed into one leaf, and its status history starts with one more leaf. Both sit in the prescription credential's forest, which names the prescriber as issuer and the pharmacy as holder.",
    who_computes: "The engine, at the prescriber's request.",
    who_sees_result: "The engine keeps the credential. The pharmacy and the phone each get the eScript encrypted to them. The ledger records only a messaging audit event, none of these hashes.",
    source: "src/prescription/prescription-data.ts:55-81; src/prescription/prescription-data.ts:131-157; src/adjudication/interactive-service.ts:2594-2628 (HEAD baa34db); src/adjudication/interactive-service.ts:2814 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "7",
    moment: "7. The fill proof (AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator): what it checks before pricing",
    latex: "\\begin{aligned}&\\mathsf{H}\\big(2,\\ q_{\\mathrm{ph}},\\ \\mathsf{hs}(\\mathit{spID}),\\ \\mathsf{hs}(K_{\\mathrm{ph}})\\big)=W_{\\mathrm{ph}},\\qquad \\mathit{type}_{\\mathrm{rx}}=2,\\ \\mathit{revoked}_{\\mathrm{rx}}=0\\\\ &F_{\\mathrm{rx}}=\\mathsf{H}(r^{\\mathrm{rx}}_{\\mathrm{mem}},\\dots,r^{\\mathrm{rx}}_{\\mathrm{tx}}),\\quad \\mathrm{MR}_8(h_{\\mathrm{rx}};\\,w_{\\mathrm{med}})=r^{\\mathrm{rx}}_{\\mathrm{med}},\\quad \\mathrm{MR}_8(\\mathit{st};\\,w_{\\mathrm{st}})=r^{\\mathrm{rx}}_{\\mathrm{tx}},\\quad \\mathit{st}.\\mathit{status}\\in\\{2,3\\},\\quad \\mathrm{MR}_8(0;\\,w_{\\mathrm{new}})=r^{\\mathrm{rx}}_{\\mathrm{tx}}\\\\ &\\mathit{fd}.\\mathit{rxHash}=h_{\\mathrm{rx}},\\quad \\mathit{fd}.h_{\\mathrm{ndc}}=h_{\\mathrm{ndc}}=\\mathit{fe}.h_{\\mathrm{ndc}},\\quad q\\le\\mathit{fe}.q_{\\max},\\quad q\\le q_{\\mathrm{rx}},\\quad \\mathrm{MR}_{16}(\\mathit{fe};\\,w_{\\mathrm{form}})=R_{\\mathrm{form}}\\\\ &\\mathit{type}_E=1,\\ \\mathit{revoked}_E=0,\\ \\mathit{subject}_E=W,\\quad F_{\\mathrm{elig}}=\\mathsf{H}(r^{E}_{\\mathrm{mem}},\\dots,r^{E}_{\\mathrm{tx}}),\\quad \\mathrm{MR}_8(A;\\,w_{\\mathrm{acc}})=r^{E}_{\\mathrm{ac}}\\end{aligned}",
    terms: Object.freeze([
      "q_ph, spID, K_ph = the pharmacy's qualifier, service provider ID (NPI) and enrollment key, hashed with plain hs (no salt). Today the engine holds these for the demo pharmacies (B4 pending).",
      "W_ph = the pharmacy wallet named in the fill data.",
      "type_rx = 2 (PRESCRIPTION) and type_E = 1 (ELIGIBILITY); revoked must be 0 on both.",
      "r^rx_* and r^E_* = the six domain roots of the prescription credential and of the eligibility credential, passed in as private inputs and checked against each forest root.",
      "st = the latest status leaf H(rxHash, status, updatedBy, updatedAt, pharmacy, fillQty, notesHash). Status 2 = PARTIALLY_FILLED, 3 = FILLED.",
      "w_new = the witness of the next empty TRANSACTION slot, where S will go.",
      "fd = FulfillmentData (rxHash, W_ph, h_ndc, q, ing, fee, dos); q = the quantity dispensed x1000.",
      "fe = the FormularyEntry commitment H(h_ndc, tier, copay, priorAuth, maxQty, maxDays, stepTherapy), a leaf of a height-16 tree: the member's own formulary, for a member with a device its plan's, where every entry carries the plan's copay.",
      "R_form = the formulary root, a private input supplied by the engine. Nothing in the circuit ties it to the member's credential; the engine does before it proves: formularyEntryFor takes the entry and its witness from the formulary the member's EligibilityData names, refuses a drug that is not on it (403), and refuses a tree whose root is not the credential's.",
      "subject_E = W: the eligibility credential's subject must be the prescription's member."
    ]),
    plain: "Before any money is computed, the circuit checks the pharmacy's identity and finds the prescription and its FILLED status in the prescription's trees. It then checks that the drug matches the script and the formulary, that the quantity is allowed, and that the accumulator is the member's own.",
    who_computes: "The engine, in its proof pool, when the pharmacy reports the dispense.",
    who_sees_result: "Only the engine. The fill proof is not sent to or verified by the sequencer or anyone else yet (A-22).",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:104-284; src/fulfillment/fulfillment-data.ts:48-58; src/prescription/prescription-data.ts:147-157; src/access-control/formulary-entry.ts:62-72; src/access-control/formulary-registry.ts:31; src/adjudication/interactive-service.ts:1173-1202 (formularyEntryFor); src/adjudication/interactive-service.ts:3351 (the fill resolves the member's entry); src/adjudication/interactive-service.ts:3516; src/adjudication/interactive-service.ts:3546-3549; docs/AUDIT.md:47"
  }),
  Object.freeze({
    key: "7b",
    moment: "7b. Inside the fill proof: the total and the deductible phase",
    latex: "\\begin{gathered}T=\\mathit{ing}+\\mathit{fee},\\qquad \\mathit{inDed}=(D>0)\\wedge\\neg(d\\ge D)\\\\ r_D=\\begin{cases}D-d, & \\mathit{inDed}\\\\ 0, & \\text{otherwise}\\end{cases}\\qquad p_D=\\begin{cases}T, & T<r_D\\\\ r_D, & \\text{otherwise}\\end{cases}\\qquad a=T-p_D\\end{gathered}",
    terms: Object.freeze([
      "ing = ingredientCostCents = NADAC x quantity, rounded half up to the cent in exact integers: floor((nu x q + 500,000) / 1,000,000), with nu the drug's NADAC per unit in whole $0.00001 and q the quantity x1000. fee = dispensingFeeCents = the dispensing fee of the member's plan as published, or the $10.00 network default when it sets none (a fixture's PLAN-GOLD-2026 has no plan record, so fixtures pay the default). The engine computes both; the pharmacy sends no cost, and a cost it states that differs is refused with 409 before any proof.",
      "D, d = the deductible limit and the deductible paid, from the accumulator A.",
      "inDed = true while the member is still in the deductible phase.",
      "r_D = the deductible remaining; p_D = deductiblePay = min(T, r_D); a = afterDeductible.",
      "Each case row is a Provable.if select. Comparisons are integer comparisons of field elements, and the selects keep every subtraction non-negative."
    ]),
    plain: "The total is the drug's NADAC price times the quantity plus the plan's dispensing fee, both computed by the engine, never by the pharmacy. If deductible is still owed, the deductible portion is the smaller of the total and the deductible left.",
    who_computes: "The engine's fill circuit.",
    who_sees_result: "It stays inside the proof; p_D appears later as the deductible credit.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:294-319; src/fulfillment/nadac-pricing.ts:79-86; src/fulfillment/nadac-pricing.ts:98-136; src/adjudication/interactive-service.ts:994-998 (quoteFill); src/adjudication/interactive-service.ts:3388-3391; src/l2/plan-terms.ts:75-104"
  }),
  Object.freeze({
    key: "7c",
    moment: "7c. Inside the fill proof: the copay",
    latex: "c_{\\mathrm{rem}}=\\begin{cases}a, & a<c\\\\ c, & \\text{otherwise}\\end{cases}\\qquad p_{\\mathrm{norm}}=\\begin{cases}T, & T<c\\\\ c, & \\text{otherwise}\\end{cases}\\qquad p_{\\mathrm{base}}=\\begin{cases}p_D+c_{\\mathrm{rem}}, & \\mathit{inDed}\\\\ p_{\\mathrm{norm}}, & \\text{otherwise}\\end{cases}",
    terms: Object.freeze([
      "c = copayAmountCents from the formulary entry the circuit proves. For a member with a device that is its plan's published formulary, where every entry carries the plan's copay, so c is the plan's copay whatever the drug's tier. A fixture member (PLAN-GOLD-2026) still pays the catalog's tier copay ($10, $35, $75 or $150).",
      "c_rem = the copay on what is left after the deductible = min(a, c).",
      "p_norm = min(T, c), the normal copay.",
      "p_base = the patient's base pay before any cap."
    ]),
    plain: "In the deductible phase the patient pays the deductible portion plus the copay on the rest. Otherwise the patient pays the copay, or the total if that is smaller.",
    who_computes: "The engine's fill circuit.",
    who_sees_result: "It stays inside the proof.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:297; src/fulfillment/accumulator-fulfillment-program.ts:323-339; src/onboarding/plan-formulary.ts:76-114; src/adjudication/interactive-service.ts:3546-3549"
  }),
  Object.freeze({
    key: "7d",
    moment: "7d. Inside the fill proof: the member's benefit cap, then the out-of-pocket cap",
    latex: "\\begin{gathered}q_{\\mathrm{base}}=T-p_{\\mathrm{base}},\\qquad r_B=\\begin{cases}0, & (B>0)\\wedge(b\\ge B)\\\\ B-b, & B>0\\\\ q_{\\mathrm{base}}, & \\text{otherwise}\\end{cases}\\qquad q_{\\mathrm{cap}}=\\begin{cases}r_B, & (B>0)\\wedge(q_{\\mathrm{base}}>r_B)\\\\ q_{\\mathrm{base}}, & \\text{otherwise}\\end{cases}\\\\ p_{\\mathrm{post}}=T-q_{\\mathrm{cap}},\\qquad r_M=\\begin{cases}0, & (M>0)\\wedge(o\\ge M)\\\\ M-o, & M>0\\\\ p_{\\mathrm{post}}, & \\text{otherwise}\\end{cases}\\qquad p_{\\mathrm{ind}}=\\begin{cases}r_M, & (M>0)\\wedge(p_{\\mathrm{post}}>r_M)\\\\ p_{\\mathrm{post}}, & \\text{otherwise}\\end{cases}\\\\ q_{\\mathrm{ind}}=T-p_{\\mathrm{ind}}\\end{gathered}",
    terms: Object.freeze([
      "B, b = the annual benefit maximum and the benefit used; M, o = the out-of-pocket maximum and the out-of-pocket paid. A limit of 0 means none.",
      "r_B = the benefit remaining; q_cap = the plan's pay after the benefit cap; p_post = what the patient picks up.",
      "r_M = the out-of-pocket remaining; p_ind = the patient's pay after the OOP cap; q_ind = the individual plan pay.",
      "Case rows are read top to bottom and the first true row wins, as in the nested Provable.if."
    ]),
    plain: "First the plan's share is capped at the member's remaining annual benefit, and then the member's share is capped at the remaining out-of-pocket maximum. The out-of-pocket cap comes last, so it wins.",
    who_computes: "The engine's fill circuit.",
    who_sees_result: "It stays inside the proof.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:342-395"
  }),
  Object.freeze({
    key: "7e",
    moment: "7e. Inside the fill proof: the family rules (B8)",
    latex: "\\begin{gathered}\\bar d=\\textstyle\\sum_{m\\in\\mathcal{F}}d_m,\\quad \\bar o=\\sum_{m\\in\\mathcal{F}}o_m,\\quad \\bar b=\\sum_{m\\in\\mathcal{F}}b_m\\\\ \\mathit{metFM}=(\\hat M>0)\\wedge(\\bar o\\ge\\hat M),\\qquad \\mathit{exhFB}=(\\hat B>0)\\wedge(\\bar b\\ge\\hat B)\\\\ r_{\\hat M}=\\begin{cases}0, & \\mathit{metFM}\\\\ \\hat M-\\bar o, & \\hat M>0\\\\ p_{\\mathrm{ind}}, & \\text{otherwise}\\end{cases}\\qquad r_{\\hat B}=\\begin{cases}0, & \\mathit{exhFB}\\\\ \\hat B-\\bar b, & \\hat B>0\\\\ q_{\\mathrm{ind}}, & \\text{otherwise}\\end{cases}\\\\ \\mathit{capFM}=(\\hat M>0)\\wedge\\neg\\mathit{metFM}\\wedge(p_{\\mathrm{ind}}>r_{\\hat M}),\\qquad \\mathit{capFB}=(\\hat B>0)\\wedge\\neg\\mathit{exhFB}\\wedge(q_{\\mathrm{ind}}>r_{\\hat B})\\\\ P=\\begin{cases}0, & \\mathit{metFM}\\\\ T, & \\mathit{exhFB}\\\\ r_{\\hat M}, & \\mathit{capFM}\\\\ T-r_{\\hat B}, & \\mathit{capFB}\\\\ p_{\\mathrm{ind}}, & \\text{otherwise}\\end{cases}\\qquad \\mathit{rule}=\\begin{cases}1, & \\mathit{metFM}\\\\ 2, & \\mathit{exhFB}\\\\ 3, & \\mathit{capFM}\\\\ 4, & \\mathit{capFB}\\\\ 0, & \\text{otherwise}\\end{cases}\\qquad Q=T-P\\end{gathered}",
    terms: Object.freeze([
      "F = the family: enrolled members with the same family hash phi, the same group hash and the same plan, including the patient. A member with no bound family is alone and has family limits of 0.",
      "d-bar, o-bar, b-bar = the family's deductible paid, OOP paid and benefit used before this fill. The engine sums them and passes them in as private inputs.",
      "D-hat, M-hat, B-hat = the plan's family deductible, family OOP maximum and family benefit maximum. 0 means none.",
      "metFM = the family OOP maximum is met; exhFB = the family benefit is exhausted; capFM, capFB = a family cap binds.",
      "P = patientPayCents and Q = planPayCents (public outputs).",
      "rule = familyRule: 0 none, 1 family OOP max met, 2 family benefit exhausted, 3 patient pay capped at the family OOP remaining, 4 plan pay capped at the family benefit remaining.",
      "D-hat and d-bar never enter P or Q; they are only committed (next card)."
    ]),
    plain: "After the member's own rules, the family's pooled totals apply in a fixed order. If the family OOP maximum is met the patient pays nothing, if the family benefit is used up the patient pays everything, and otherwise each share is capped at what the family has left; the proof also outputs which rule fired.",
    who_computes: "The engine sums the family totals, and the circuit applies the rules.",
    who_sees_result: "P and Q go to the pharmacy, to the member and onto the ledger. rule stays in the proof output; the engine uses it for the fill's phase label.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:397-446; src/adjudication/interactive-service.ts:516-536 (HEAD baa34db); src/adjudication/interactive-service.ts:3230-3240 (HEAD baa34db); src/onboarding/family-accumulator-service.ts:87-104"
  }),
  Object.freeze({
    key: "7f",
    moment: "7f. Inside the fill proof: the familyCommitment",
    latex: "h_{\\mathrm{fam}}=\\mathsf{H}\\big(\\bar d,\\ \\bar o,\\ \\bar b,\\ \\hat D,\\ \\hat M,\\ \\hat B\\big)",
    terms: Object.freeze([
      "The six family inputs, in exactly this order: family deductible paid, family OOP paid, family benefit used, family deductible amount, family OOP maximum, family benefit maximum.",
      "h_fam = familyCommitment, a public output (0 for a reversal)."
    ]),
    plain: "The six family numbers the split was computed against are hashed into the proof's output, so anyone who holds them can check them later.",
    who_computes: "The engine's fill circuit.",
    who_sees_result: "The engine, in the proof output. It is not sent onward or recorded on the ledger today.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:447-454; src/fulfillment/accumulator-fulfillment-program.ts:63-66"
  }),
  Object.freeze({
    key: "7g",
    moment: "7g. Inside the fill proof: the deductible credit",
    latex: "\\kappa=\\begin{cases}P, & P<p_D\\\\ p_D, & \\text{otherwise}\\end{cases}",
    terms: Object.freeze([
      "kappa = deductibleCreditCents = min(P, p_D).",
      "p_D = the deductible portion from card 7b; P = the final patient pay from card 7e."
    ]),
    plain: "Only the deductible part of what the patient pays counts toward the deductible. If a cap cut the patient's pay below that part, the credit is cut too.",
    who_computes: "The engine's fill circuit.",
    who_sees_result: "It is a public output, and it goes into the settlement commitment and the claim leaf.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:460-464"
  }),
  Object.freeze({
    key: "7h",
    moment: "7h. Inside the fill proof: the fulfillment and settlement commitments",
    latex: "\\begin{gathered}\\mathit{fc}=\\mathsf{H}\\big(h_{\\mathrm{rx}},\\ W_{\\mathrm{ph}},\\ h_{\\mathrm{ndc}},\\ q,\\ \\mathit{ing},\\ \\mathit{fee},\\ \\mathit{dos}\\big)\\\\ S=\\mathsf{H}\\big(\\mathit{fc},\\ P,\\ Q,\\ \\kappa\\big)\\end{gathered}",
    terms: Object.freeze([
      "q = the quantity dispensed x1000; dos = the date of service as the integer CCYYMMDD, taken from the engine's clock.",
      "fc = the FulfillmentData commitment = entryCommitment (a public output).",
      "S = settlementCommitment. It is written into the next empty TRANSACTION slot of the prescription credential."
    ]),
    plain: "The facts of the fill hash to one number, and the money is hashed on top of it. That settlement hash goes into the prescription's transaction tree.",
    who_computes: "The engine's fill circuit. The engine recomputes S for its own copy of the prescription forest.",
    who_sees_result: "The pharmacy node gets fc, S, P and Q in the fill result. The ledger does not store S.",
    source: "src/fulfillment/fulfillment-data.ts:48-58; src/fulfillment/accumulator-fulfillment-program.ts:468-474; src/adjudication/interactive-service.ts:3373-3379 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "7i",
    moment: "7i. Inside the fill proof: the new accumulator, the new roots, and the public output",
    latex: "\\begin{aligned}&A'=\\mathsf{H}\\big(y,\\ D,\\ d+\\kappa,\\ M,\\ o+P,\\ B,\\ b+Q\\big)\\\\ &F'_{\\mathrm{elig}}=\\mathsf{H}\\big(r^{E}_{\\mathrm{mem}},\\ r^{E}_{\\mathrm{pres}},\\ r^{E}_{\\mathrm{phar}},\\ r^{E}_{\\mathrm{med}},\\ \\mathrm{MR}_8(A';\\,w_{\\mathrm{acc}}),\\ r^{E}_{\\mathrm{tx}}\\big)\\\\ &F'_{\\mathrm{rx}}=\\mathsf{H}\\big(r^{\\mathrm{rx}}_{\\mathrm{mem}},\\ r^{\\mathrm{rx}}_{\\mathrm{pres}},\\ r^{\\mathrm{rx}}_{\\mathrm{phar}},\\ r^{\\mathrm{rx}}_{\\mathrm{med}},\\ r^{\\mathrm{rx}}_{\\mathrm{ac}},\\ \\mathrm{MR}_8(S;\\,w_{\\mathrm{new}})\\big)\\\\ &\\mathrm{out}=\\big(h_{\\mathrm{rx}},\\ F_{\\mathrm{rx}},\\ F'_{\\mathrm{rx}},\\ \\mathit{fc},\\ P,\\ Q,\\ 1,\\ F'_{\\mathrm{elig}},\\ \\kappa,\\ h_{\\mathrm{ndc}},\\ h_{\\mathrm{fam}},\\ \\mathit{rule}\\big)\\end{aligned}",
    terms: Object.freeze([
      "A' = the new accumulator. The plan year and limits are unchanged; deductible paid goes up by kappa, OOP paid by P and benefit used by Q.",
      "w_acc = the same leaf-127 witness that checked A, now carrying A'.",
      "F'_elig = newEligibilityForestRoot; F'_rx = the newForestRoot of the prescription credential.",
      "out = the 12 public outputs, in order: prescriptionHash, oldForestRoot, newForestRoot, entryCommitment, patientPayCents, planPayCents, operationType (1 = fill), newEligibilityForestRoot, deductibleCreditCents, ndcHash, familyCommitment, familyRule."
    ]),
    plain: "The proof ends by writing the new totals into the member's credential and the settlement into the prescription. It outputs the old and new roots and the amounts, but not the member's running totals.",
    who_computes: "The engine's fill circuit.",
    who_sees_result: "The engine, which then queues the change to the member's credential for the phone to prove.",
    source: "src/fulfillment/accumulator-fulfillment-program.ts:478-531; src/fulfillment/accumulator-fulfillment-program.ts:42-67"
  }),
  Object.freeze({
    key: "7j",
    moment: "7j. The engine checks its own update against the proof (A-35)",
    latex: "\\mathsf{H}\\Big(r^{E}_{\\mathrm{mem}},\\ r^{E}_{\\mathrm{pres}},\\ r^{E}_{\\mathrm{phar}},\\ r^{E}_{\\mathrm{med}},\\ \\mathrm{MR}_8\\big(\\mathsf{H}(y,D,d+\\kappa,M,o+P,B,b+Q);\\,w_{\\mathrm{acc}}\\big),\\ r^{E}_{\\mathrm{tx}}\\Big)\\overset{?}{=}F'_{\\mathrm{elig}}",
    terms: Object.freeze([
      "P, Q, kappa and F'_elig = taken from the proof's output.",
      "y, D, M, B = the member's own plan year and limits, which withAmountsPaid keeps unchanged.",
      "On a mismatch the engine throws and records nothing."
    ]),
    plain: "The engine rebuilds the new accumulator from the proof's amounts and the member's own limits. It records the claim only if that rebuild reaches the same root the proof produced.",
    who_computes: "The engine, outside the circuit.",
    who_sees_result: "The engine.",
    source: "src/access-control/accumulator-data.ts:100-113; src/eligibility/forest-roots.ts:81-90; src/adjudication/interactive-service.ts:3300-3310 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "8",
    moment: "8. The phone checks and proves the claim update (StateTransitionProgram.proveWalletUpdate)",
    latex: "\\begin{aligned}&\\text{phone check: }\\mathrm{root}_7\\big\\{0\\mapsto\\mathsf{H}(\\mathit{type},\\ F^\\ast,\\ \\mathit{issuer},\\ \\mathit{subject},\\ \\mathit{issuedAt},\\ \\mathit{expiresAt},\\ \\mathit{revoked})\\big\\}\\overset{?}{=}C_{\\mathrm{new}},\\quad F^\\ast=\\text{forest root of the sent leaves}\\\\ &W=\\mathsf{H}(0,f_0,\\dots,f_5),\\qquad \\mathrm{MR}_{11}\\big(\\mathsf{H}(W,\\ell);\\,w_{\\mathrm{lc}}\\big)=R_{\\mathrm{lc}},\\qquad \\ell\\neq 4\\\\ &\\mathrm{MR}_{11}\\big(\\mathsf{H}(W,\\ C_{\\mathrm{old}},\\ n);\\,w_{\\mathrm{reg}}\\big)=R_{\\mathrm{reg}}\\\\ &R'_{\\mathrm{reg}}=\\mathrm{MR}_{11}\\big(\\mathsf{H}(W,\\ C_{\\mathrm{new}},\\ n+1);\\,w_{\\mathrm{reg}}\\big),\\qquad R'_{\\mathrm{lc}}=R_{\\mathrm{lc}}\\\\ &x=(W,\\ R_{\\mathrm{reg}},\\ R'_{\\mathrm{reg}},\\ R_{\\mathrm{lc}},\\ R_{\\mathrm{lc}})\\end{aligned}",
    terms: Object.freeze([
      "Phone check: the phone rebuilds the forest from the engine's leaves (domain, index, leaf), the credential from the engine's fields and that root, and slot 0 of a fresh height-7 inventory. It refuses unless the result equals C_new, and unless the ledger's current root equals C_old.",
      "f_0..f_5 = the phone's private preimage; the tag is 0.",
      "ell = the wallet's lifecycle state on the ledger (2 = ELIGIBLE in this story). 4 = REVOKED is refused.",
      "C_old, n = the ledger's inventory root and nonce for W; C_new = the inventory root after the fill.",
      "R'_lc = R_lc: a wallet update never touches the lifecycle tree.",
      "x = the public output."
    ]),
    plain: "The phone rebuilds the engine's new root from the parts it was sent and refuses if it does not match. Then it proves, with secrets only it holds, that its wallet leaf moves from the old root to the new one with the nonce up by one.",
    who_computes: "The member's phone, during its 20-second check, after it takes the proving lease.",
    who_sees_result: "The sequencer verifies it through the A1 gate, checks it against its own tree, and attaches the claim the engine parked for this wallet and this root. The phone then reports the receipt to the engine.",
    source: "src/credentials/wallet-update.ts:111-157; src/nodes/routes/member-routes.ts:118-163; src/engine/state-transition.ts:231-309; src/l2/l2-sequencer-service.ts:1611-1627; src/l2/l2-rpc-server.ts:884-908; src/nodes/start-member-nautilus.ts:123-129; src/adjudication/interactive-service.ts:1741-1767 (HEAD baa34db)"
  }),
  Object.freeze({
    key: "9",
    moment: "9. The sequencer records the claim: the audit event and the hash chain",
    latex: "\\begin{gathered}E_k=\\mathsf{H}\\big(W,\\ R_{\\mathrm{reg}},\\ R'_{\\mathrm{reg}},\\ R_{\\mathrm{lc}},\\ R'_{\\mathrm{lc}},\\ k,\\ \\mathit{isReg},\\ h_{\\mathrm{ndc}},\\ P,\\ Q,\\ \\mathit{op}\\big)\\\\ \\chi_{\\mathrm{gen}}=\\mathsf{H}(0),\\qquad \\chi_k=\\mathsf{H}\\big(\\chi_{\\mathrm{prev}},\\ E_k\\big)\\end{gathered}",
    terms: Object.freeze([
      "W, R, R' = the accepted proof's public output x.",
      "k = the sequence number, shared by every accepted proof and every messaging audit event.",
      "isReg = 1 for a registration and 0 for a wallet update.",
      "h_ndc, P, Q, op = the claim the engine parked for this wallet and root; op 1 = fill, 2 = reversal. All four are 0 for an event with no claim.",
      "For this claim: W = the member, R'_lc = R_lc, isReg = 0 and op = 1.",
      "chi_gen = H(0); chi_prev = the previous event's chain hash. E_k is also leaf k of an audit Merkle index of height 20."
    ]),
    plain: "Every accepted proof becomes an audit event whose hash covers the wallet, the roots, the drug and both amounts, and each chain hash covers the one before it. The amounts come from the engine's parked claim; the sequencer does not check them against the fill proof yet.",
    who_computes: "The sequencer, when it accepts the proof.",
    who_sees_result: "The phone gets chi_k in its receipt as auditEventHash. The insurer re-walks the chain with l2_verifyChainIntegrity.",
    source: "src/audit/audit-service.ts:54; src/audit/audit-service.ts:64-86; src/audit/audit-service.ts:96-127; src/l2/l2-sequencer-service.ts:278; src/l2/l2-sequencer-service.ts:416-493; src/audit/audit-merkle-index.ts:40; src/audit/audit-merkle-index.ts:109-112"
  }),
  Object.freeze({
    key: "10",
    moment: "10. The claim ledger leaf and the claims root",
    latex: "\\begin{gathered}L_j=\\mathsf{H}\\big(W,\\ h_{\\mathrm{ndc}},\\ W_{\\mathrm{ph}},\\ W_{\\mathrm{pr}},\\ \\mathsf{H}(\\mathit{dos}),\\ P,\\ Q,\\ \\mathit{op},\\ \\kappa\\big)\\\\ R_{\\mathrm{claims}}=\\mathrm{root}_{24}\\{0\\mapsto L_0,\\ \\dots,\\ j\\mapsto L_j\\}\\end{gathered}",
    terms: Object.freeze([
      "W = the member's wallet, W_ph = the pharmacy's wallet, W_pr = the prescriber's wallet; h_ndc = hs(NDC).",
      "dos = the date of service, CCYYMMDD. The leaf record holds the plain date, and the leaf hash uses H(dos).",
      "P, Q, kappa = patient pay, plan pay and the deductible credit; op = 1 for a fill, 2 for a reversal.",
      "j = the next free leaf (the tree is append-only). A second fill with the same member, drug, pharmacy, date and fill number is refused before anything is written.",
      "R_claims = the claim accumulator root: height 24, 2^23 leaves. It is stored on every batch record."
    ]),
    plain: "Each claim is one leaf of nine values, appended to one large tree. A reader with access can fetch a leaf and its path and recompute the root.",
    who_computes: "The sequencer, right after the audit event, from the engine's parked claim.",
    who_sees_result: "Readers of the sequencer's claim RPCs, such as the insurer. The harness recomputes each leaf and the root, and the root travels with each batch.",
    source: "src/l2/claim-accumulator-types.ts:34; src/l2/claim-accumulator-types.ts:79-91; src/l2/claim-accumulator-service.ts:121-136; src/l2/l2-sequencer-service.ts:499-510; src/l2/l2-sequencer-service.ts:707; scripts/e2e-verify/run.ts:739-764"
  }),
  Object.freeze({
    key: "11",
    moment: "11. The batch proof rolls the accepted proofs together",
    latex: "\\begin{aligned}&\\mathrm{wrapSingle}(\\pi,\\pi):\\ \\beta=\\big(x.R_{\\mathrm{reg}},\\ x.R'_{\\mathrm{reg}},\\ x.R_{\\mathrm{lc}},\\ x.R'_{\\mathrm{lc}},\\ [x.R_{\\mathrm{reg}}\\neq x.R'_{\\mathrm{reg}}\\wedge x.R_{\\mathrm{lc}}\\neq x.R'_{\\mathrm{lc}}],\\ 1\\big)\\\\ &\\mathrm{wrapPair}(\\pi_a,\\pi_b):\\ x_a.R'_{\\mathrm{reg}}=x_b.R_{\\mathrm{reg}},\\ x_a.R'_{\\mathrm{lc}}=x_b.R_{\\mathrm{lc}};\\quad \\beta=\\big(x_a.R_{\\mathrm{reg}},\\ x_b.R'_{\\mathrm{reg}},\\ x_a.R_{\\mathrm{lc}},\\ x_b.R'_{\\mathrm{lc}},\\ \\mathit{reg}_a+\\mathit{reg}_b,\\ 2\\big)\\\\ &\\mathrm{mergeBatches}(\\beta_L,\\beta_R):\\ \\beta_L.R'_{\\mathrm{reg}}=\\beta_R.R_{\\mathrm{reg}},\\ \\beta_L.R'_{\\mathrm{lc}}=\\beta_R.R_{\\mathrm{lc}};\\quad \\beta=\\big(\\beta_L.R_{\\mathrm{reg}},\\ \\beta_R.R'_{\\mathrm{reg}},\\ \\beta_L.R_{\\mathrm{lc}},\\ \\beta_R.R'_{\\mathrm{lc}},\\ \\beta_L.\\mathit{reg}+\\beta_R.\\mathit{reg},\\ \\beta_L.n+\\beta_R.n\\big)\\end{aligned}",
    terms: Object.freeze([
      "pi = an accepted StateTransition proof with output x. Every method verifies its two input proofs inside its own circuit.",
      "beta = BatchOutput: old and new registry roots, old and new lifecycle roots, registrationCount and transitionCount.",
      "[.] = 1 if true, else 0. A registration is a proof that changes both roots.",
      "wrapPair and mergeBatches assert that the roots chain: the left side's new roots equal the right side's old roots.",
      "MAX_TRANSITIONS_PER_BATCH = 2, so a live batch is one wrapSingle or one wrapPair, and mergeBatches does not run at this cap. A batch is built every 180 s by default, or on force-batch, from the longest chainable run at the head of the pool.",
      "ChainProgram would fold each batch into G = H(R_reg, walletCount, adminPKHash, R_lc, benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash, messagingRoot, auditChainHash, blockHeight). But nothing in production calls setAdminState, so no chain proof is made."
    ]),
    plain: "The sequencer wraps one or two accepted proofs into a batch proof, which re-verifies them inside a circuit and checks that each one starts where the last one ended. The batch proof outputs only the first and last roots and two counts.",
    who_computes: "The sequencer, either in its own process or in its proving worker.",
    who_sees_result: "The batch record carries the batch proof and its roots, with the claims root beside them. Anyone can verify the batch proof with a locally compiled key (harness step 11).",
    source: "src/l2/batch-program.ts:85-219; src/l2/l2-sequencer-service.ts:60-69; src/l2/l2-sequencer-service.ts:534; src/l2/l2-sequencer-service.ts:604-717; src/l2/chain-program.ts:60-178; src/l2/global-state.ts:45-68; src/l2/l2-node.ts:836-838; scripts/e2e-verify/run.ts:789-812"
  }),
  Object.freeze({
    key: "12",
    moment: "12. The insurer checks the money and rebuilds the totals",
    latex: "\\begin{gathered}\\forall\\ \\text{fill}:\\ P+Q=\\mathit{ing}+\\mathit{fee}\\\\ o^{\\mathrm{rebuilt}}=\\textstyle\\sum P,\\qquad b^{\\mathrm{rebuilt}}=\\sum Q,\\qquad d^{\\mathrm{rebuilt}}=\\sum \\kappa\\qquad(\\text{a reversal subtracts, floored at }0)\\end{gathered}",
    terms: Object.freeze([
      "P, Q = the amounts in each audit event; ing, fee = the costs carried beside the event (claimContext).",
      "The sums replay the member's claim leaves in order (reconstructAccumulator), optionally only the leaves with a given plan hash.",
      "l2_verifyFinancialBalance is valid only when every fill balances and the chain's totals agree with the ledger's."
    ]),
    plain: "For every fill, patient pay plus plan pay must equal the cost. A member's totals can be rebuilt from the claim leaves alone.",
    who_computes: "The sequencer's audit RPCs, at the insurer's request.",
    who_sees_result: "The insurer.",
    source: "src/audit/audit-service.ts:140-178; src/l2/l2-sequencer-service.ts:2350-2401; scripts/e2e-verify/run.ts:767-787"
  }),
  Object.freeze({
    key: "13",
    moment: "13. Pickup at the counter: the signed attestation",
    latex: "\\begin{gathered}m=\\texttt{zkpcare-attestation-v2|}W\\texttt{|}R_{\\mathrm{reg}}\\texttt{|}\\ell\\texttt{|}\\mathit{fr}\\texttt{|}\\mathit{ts}\\texttt{|}\\mathit{exp}\\texttt{|}n\\\\ \\mathrm{sig}=\\mathrm{Ed25519.Sign}(\\mathit{sk}_{\\mathrm{seq}},\\ m)\\\\ \\text{valid}\\iff \\mathit{pk}=\\mathit{pk}_{\\mathrm{trusted}}\\wedge\\mathrm{Ed25519.Verify}(\\mathit{pk},\\ m,\\ \\mathrm{sig}),\\qquad \\text{expired}\\iff \\mathit{now}>\\mathit{exp}\\end{gathered}",
    terms: Object.freeze([
      "W = the member's wallet ID.",
      "R_reg = the ledger's current registry root. It travels in the field named cc ('credential commitment'), but it is not a per-credential commitment.",
      "ell = the wallet's lifecycle state on the ledger. A revoked wallet gets no attestation.",
      "fr = the global state root. It stays 0 until chain proofs are switched on, so fr = 0 today.",
      "ts, exp = Unix seconds. By default exp = ts + 86,400; at most 7 days when the member asks for longer.",
      "n = 16 random bytes in hex, used as a revocation handle.",
      "sk_seq, pk_seq = the sequencer's Ed25519 attestation key pair; pk_trusted = the key the pharmacy already holds."
    ]),
    plain: "At the phone's signed request, the sequencer signs one line naming the wallet, its ledger state and an expiry, and the pharmacy checks that signature against a key it already trusts. Handing over the medicine does not depend on this check today.",
    who_computes: "The sequencer signs it, the phone carries it, and the pharmacy verifies it.",
    who_sees_result: "The pharmacy, from the tap. Anyone can read what is on the tag; the security rests on the signature.",
    source: "src/credentials/nfc-attestation.ts:99-110; src/credentials/nfc-attestation.ts:206-238; src/credentials/nfc-attestation.ts:262-300; src/l2/l2-node.ts:358-383; src/l2/l2-sequencer-service.ts:152; src/nodes/routes/member-routes.ts:1574-1595"
  })
]);

export const BY_KEY = Object.freeze(Object.fromEntries(EQUATIONS.map((e) => [e.key, e])));

/** One card by its key ('2b'); throws on an unknown key so a typo in the script fails before T0. */
export function eq(key) {
  const e = BY_KEY[String(key)];
  if (!e) throw new Error(`no equation card "${key}" (known: ${Object.keys(BY_KEY).join(', ')})`);
  return e;
}
