/**
 * Wallet Migration Program
 *
 * A ZkProgram that proves identity continuity between an old and new wallet
 * during wallet migration. This is needed when a user regenerates their
 * enrollment key on a new device — the underlying identity (PHI fields)
 * remains the same, but the enrollment key changes, producing a new wallet ID.
 *
 * The proof takes both padded preimages (7 Fields each) as private inputs and
 * outputs only the domain tag and the two wallet IDs. Zero PHI is revealed.
 *
 * Entity-type-aware field matching:
 *   Members (tag=0):     f0-f3 are identity fields, f4 is enrollment key, f5 is groupIdHash
 *   Prescribers (tag=1): f0-f1 are identity fields, f2 is enrollment key, f3-f5 are zero padding
 *   Pharmacies (tag=2):  f0-f1 are identity fields, f2 is enrollment key, f3-f5 are zero padding
 *
 * The program enforces:
 *   - Domain tags match between old and new preimages
 *   - All identity fields match (same person)
 *   - groupIdHash matches (same employer group — migration within same group only)
 *   - The enrollment key field differs (key was actually regenerated)
 *   - Resulting wallet IDs are different (sanity check)
 */

import { Field, Struct, ZkProgram, Poseidon, Provable } from 'o1js';

// ─── Domain Tags ────────────────────────────────────────

const DOMAIN_TAG_MEMBER = Field(0);
const DOMAIN_TAG_PRESCRIBER = Field(1);
const DOMAIN_TAG_PHARMACY = Field(2);

// ─── Public Output ──────────────────────────────────────

/**
 * MigrationOutput — public output of the WalletMigrationProgram.
 * Contains ONLY the domain tag and both wallet IDs — zero PHI revealed.
 */
export class MigrationOutput extends Struct({
  domainTag: Field,
  oldWalletId: Field,
  newWalletId: Field,
}) {}

// ─── ZkProgram ──────────────────────────────────────────

/**
 * WalletMigrationProgram — ZkProgram proving identity continuity.
 *
 * Proves that two wallet IDs share the same identity fields but differ
 * in enrollment key. This proves the person is the same — they just
 * regenerated their enrollment key on a new device.
 *
 * Private inputs: old padded preimage (7 Fields) + new padded preimage (7 Fields)
 * Public output: { domainTag, oldWalletId, newWalletId }
 *
 * maxProofsVerified defaults to 0 (standalone, no recursive proof verification).
 */
export const WalletMigrationProgram = ZkProgram({
  name: 'WalletMigrationProgram',
  publicOutput: MigrationOutput,

  methods: {
    proveIdentityContinuity: {
      privateInputs: [Field, Field, Field, Field, Field, Field, Field, Field, Field, Field, Field, Field, Field, Field],
      async method(
        // Old preimage: [domainTag, f0, f1, f2, f3, f4, f5]
        oldDomainTag: Field, oldF0: Field, oldF1: Field, oldF2: Field, oldF3: Field, oldF4: Field, oldF5: Field,
        // New preimage: [domainTag, f0, f1, f2, f3, f4, f5]
        newDomainTag: Field, newF0: Field, newF1: Field, newF2: Field, newF3: Field, newF4: Field, newF5: Field,
      ): Promise<{ publicOutput: MigrationOutput }> {
        // 1. Domain tags must match
        oldDomainTag.assertEquals(newDomainTag);

        // 2. Determine entity type for field-level assertions
        const isMember = oldDomainTag.equals(DOMAIN_TAG_MEMBER);
        const isPrescriber = oldDomainTag.equals(DOMAIN_TAG_PRESCRIBER);
        const isPharmacy = oldDomainTag.equals(DOMAIN_TAG_PHARMACY);

        // At least one entity type must match (valid domain tag)
        isMember.or(isPrescriber).or(isPharmacy).assertTrue();

        // 3. Identity fields must match, enrollment key must differ.
        //
        // Field layout per entity type:
        //   Members:              [tag, hash(cardholderId), hashDate(dob), hash(firstName), hash(lastName), hash(enrollmentKey), groupIdHash]
        //   Prescribers/Pharmacy: [tag, codeToField(qual), hash(id),      hash(enrollmentKey), 0,             0,                0          ]
        //
        // f0: always identity → must match
        // f1: always identity → must match
        // f2: member=identity (firstName), non-member=enrollmentKey
        // f3: always matches (member=lastName identity, non-member=zero padding)
        // f4: member=enrollmentKey, non-member=zero padding (always matches)
        // f5: always matches (member=groupIdHash, non-member=zero padding)

        // f0 must always match (cardholderId hash for members, qualifier for others)
        oldF0.assertEquals(newF0);

        // f1 must always match (DOB hash for members, prescriberId/serviceProviderId hash for others)
        oldF1.assertEquals(newF1);

        // f2: for members it's firstName hash (must match), for non-members it's enrollmentKey (must differ)
        const f2Match = oldF2.equals(newF2);
        Provable.if(isMember, f2Match.toField(), f2Match.not().toField()).assertEquals(Field(1));

        // f3: always must match (lastName hash for members, zero padding for prescribers/pharmacies)
        oldF3.assertEquals(newF3);

        // f4: for members it's enrollmentKey hash (must differ), for non-members it's zero padding (must match)
        const f4Match = oldF4.equals(newF4);
        Provable.if(isMember, f4Match.not().toField(), f4Match.toField()).assertEquals(Field(1));

        // f5: always must match (groupIdHash for members, zero padding for non-members)
        // Migration is locked to the same employer group — changing groups requires new enrollment
        oldF5.assertEquals(newF5);

        // 4. Compute both wallet IDs from the full padded preimage
        const oldWalletId = Poseidon.hash([oldDomainTag, oldF0, oldF1, oldF2, oldF3, oldF4, oldF5]);
        const newWalletId = Poseidon.hash([newDomainTag, newF0, newF1, newF2, newF3, newF4, newF5]);

        // 5. Wallet IDs must be different (sanity check — enrollment key changed)
        oldWalletId.equals(newWalletId).assertFalse();

        return {
          publicOutput: new MigrationOutput({
            domainTag: oldDomainTag,
            oldWalletId,
            newWalletId,
          }),
        };
      },
    },
  },
});

// ─── Proof Class ────────────────────────────────────────

export class WalletMigrationProof extends ZkProgram.Proof(WalletMigrationProgram) {}
