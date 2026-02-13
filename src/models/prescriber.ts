import { Field, Struct, Poseidon } from 'o1js';

/**
 * Prescriber — maps to NCPDP Prescriber segment (minimum fields).
 *
 * NCPDP Source Fields:
 *   465-EY  Prescriber ID Qualifier (01=NPI)
 *   411-DB  Prescriber ID (NPI Number)
 */
export class PrescriberData extends Struct({
  /** Prescriber ID qualifier (01=NPI, 12=DEA, 16=State License) */
  prescriberIdQualifier: Field,
  /** Poseidon hash of the prescriber NPI (411-DB) */
  prescriberIdHash: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.prescriberIdQualifier,
      this.prescriberIdHash,
    ]);
  }
}

/**
 * Raw prescriber data — lives locally, never on-chain.
 */
export interface PrescriberLocalData {
  prescriberIdQualifier: number;  // 465-EY
  prescriberId: string;           // 411-DB (NPI)
}
