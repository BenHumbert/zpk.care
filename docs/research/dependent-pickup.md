# Prescribing for a dependent, and pickup by someone else

Research for the owner's question of 2026-10-18: "The prescriber would be able to indicate a dependent. How do you identify a second degree relationship without revealing the relationship and be able to pick up meds?"

Method: three research agents (this codebase; US law and pharmacy practice; cryptography and o1js), then three independent designs, each attacked by its own red team. The full findings with every citation are in `dependent-pickup-research.json` beside this file. Nothing here is built.

## The answer

Nobody identifies the relationship. The law does not ask for it, and nothing in this system could verify it.

Under HIPAA, a pharmacist may hand a filled prescription to anyone the patient identifies, or anyone the patient's personal representative identifies, and may use professional judgment for a family member or friend who asks (45 CFR 164.510(b), HHS FAQs 263 and 535). A parent of a minor is the personal representative and "is treated as the individual" (164.502(g)). Kinship degree plays no part. So the counter needs one fact: this person holds authority for this prescription. A grandparent collecting on the parent's authority is a two-hop chain (child, parent, grandparent), and the chain collapses to one grant when the parent issues it. The network never sees that a parent was involved.

The prescriber indicates a dependent by writing the prescription to the dependent's own wallet. Every person keeps their own wallet, because accumulators, drug-interaction checks, age rules and prior authorizations are per person. The prescriber never names or learns the parent or the grandparent.

## Recommended design: a pickup ticket bound to one prescription

This was the one design of the three whose red team did not break it. With the fixes below, the core holds.

1. **The dependent has a wallet.** A child without a phone has a custodial wallet held on the parent's phone, enrolled from the child's own employer code (which carries the family hash since B8). Today a phone holds exactly one wallet, so this needs multi-wallet support on the device.
2. **Pairing, once per helper.** The grandparent installs the app; she does not need to be enrolled. Her phone makes a holder secret and shows a QR code with a commitment to it. The parent's phone scans it.
3. **Prescribing.** The prescriber writes to the child's wallet as today. The prescription can carry a pickup policy: patient only, guardian allowed, delegate allowed, confidential (a minor's own consent), controlled.
4. **Tickets.** When the prescription arrives, the parent's phone builds a small set of salted ticket commitments bound to this prescription: one for itself, one for the grandparent, and random dummies, shuffled. It registers the set with the engine, signed by the child's wallet key. The engine sees commitments only. No relationship, label or holder identity is recorded anywhere.
5. **At the counter.** The holder proves she can open one ticket in the set and signs the pharmacy's challenge. The pharmacy learns that an authorized holder is present. It cannot tell the parent from the grandparent from the patient, or one hop from two. The fill state stops a second pickup.
6. **Revocation.** The parent re-registers the set without that holder. Sets expire with the prescription or after 30 days.

What each party learns:

| Party | Learns | Does not learn |
|---|---|---|
| Prescriber | the child's wallet, what happens in the room | the parent, the grandparent, any relationship |
| Pharmacy | an authorized holder is at the counter | who authorized it, the relationship, the number of hops |
| Engine and sequencer | a ticket set exists for a prescription; one ticket was spent | which holder, which relationship |
| Insurer | nothing new from pickup | holders, relationships |
| Employer | nothing | anything about pickup |

## What the red teams found, which must be solved first

These apply to any design, not only this one.

- **The custodial wallet leaks the household.** A child's wallet riding on the parent's phone shares its node key, network address and timing, so the sequencer can see which adult holds which child's wallet. Each wallet needs its own network identity and a relay the sequencer cannot link.
- **Custody is self-attested.** Whoever redeems a dependent's code becomes its controller, so a policyholder could capture an adult child or a spouse. The employer already holds dates of birth. It should sign a coarse "custodial until" field into each dependent's code, and a yearly proof should show the child is still a minor without revealing the birth date.
- **Turning 18, and co-parents.** Majority is 18 in most states, 19 in Alabama and Nebraska, 21 in Mississippi. At majority the parent's authority must end automatically, and the hand-over must need something the parent does not hold. Each co-parent needs their own revocable key under the child's wallet, not a shared copy.
- **A minor's confidential care.** Where a minor consents alone (contraception in 23 states plus DC, STI care in all states, some mental health and substance use care), the parent is not the personal representative. Those prescriptions must stay off the custodial wallet's views and updates, and only a key the minor holds can authorize pickup. Over-hiding is also a risk: an HHS Office for Civil Rights letter of 3 Dec 2025 made parents' access to minors' records an enforcement priority.
- **Adult dependents, 18 to 26.** The parent has no authority over an adult child, even as policyholder. The adult child must issue tickets from their own key.
- **Power of attorney and guardianship.** Someone must check the paper once. If the insurer does it, it should sign a blind credential so the engine records only that a co-controller key was added.
- **Cards for people without phones.** A passive NFC tag (NTAG216) cannot hold a proof (22 KB against 888 bytes) or keep a secret, and the PIN-encrypted card format the program retired must not come back. Extra family cards need a secure element (JavaCard or a FIDO2 NFC key) that signs a challenge, or the split-share pattern of the current recovery cards with an attempt-limited PIN at the engine.
- **Controlled substances.** Several states require the picker's photo ID and some report it to the state monitoring program (Delaware for all controlled substances; North Carolina, West Virginia, Georgia, New Mexico, Massachusetts, Indiana, Wisconsin, Utah in various forms). Every state's program also receives the patient's own name, birth date and address. The relationship becomes inferable from those records, and rule I2 cannot hold there. This supports the existing decision to keep controlled substances out of release one.
- **The pharmacist decides.** The law leaves the final call to the pharmacist. The pharmacy screen should show "authorized: yes or no" and, for a controlled substance, "photo ID required in this state", and never a relationship.
- **Smaller fixes in the ticket design.** Enforce single-fill at the engine; have the pharmacy check the parent's signature over the ticket set so an insider cannot inject tickets; check revocation synchronously before handing over the bag; give the parent a narrow ticket-issuing key that works while the app is locked; one issuing device per dependent; replace phone proving at the counter with one-time prekeys, which keeps the privacy and needs no proof on the holder's phone.

## The two designs that broke

- **Family policy proof** (authority derived inside one circuit from the bound family and role flags): the custodial wallet exposed a minor's confidential care to the parent, the pharmacy could probe the circuit's public inputs to learn the path, and one device spoke for several wallets.
- **Chained credentials** (a two-hop path proof over committed delegation edges): any registered prescriber could mint authority over any patient, the custodial holder could not be revoked, and the pharmacy and engine could rebuild the family graph from linkage.

Both kept the same core idea the surviving design uses: prove authority, never kinship.

## What exists in the code today

The delegation registry and the appointment-of-representative code in `src/messaging/` should not be reused as they stand. Leaves are unsalted Poseidon hashes of guessable fields; the tree holds 128 delegations for the whole network; the delegation proof makes the relationship code public, takes its own date as a private input and is discarded; delegations are not persisted; creation is operator-only. The CMS-1696 form covers Medicare claims and appeals, not pickup, and its 48-hour pickup cool-down is not a legal requirement.

Today's B8 family binding helps (every phone-enrolled member has a bound family), but pickup does not use the family hash at all.

## Decisions for the owner

1. Accept "authority for this prescription, never kinship" as the model, with prescription-bound tickets as the base design.
2. Custodial wallets for children without phones, and at what age a child holds their own key.
3. Who checks power-of-attorney and guardianship paperwork once.
4. Card hardware for people without phones: secure-element cards (cost per family) or phone-only first.
5. Controlled substances stay out until the PDMP and photo-ID rules have a design (already decided for release one).

Your idea of adding family members to the enrollment hash would change the wallet ID at every life event and merge per-person records. The ticket design gets the family behaviour you want with one wallet per person.

## Effort

The red team's estimate for the core ticket design is 25 to 35 engineer-days, about six to eight sessions at this program's pace. The custody, majority and confidential-minor work above comes on top, and depends on decisions 2 and 3.

## Side findings for the audit

- The engine's console stream, `GET /interactive/console`, is open and prints a registering member's display name next to its wallet ID prefix. The device sends a configured display name, "Member" by default.
- The pharmacy's `/nfc/scan` accepts a bare wallet ID with no attestation and answers with the pharmacy's records for it.
- `createDelegation` prints delegator and delegate names and the relationship label on that same open console stream.
