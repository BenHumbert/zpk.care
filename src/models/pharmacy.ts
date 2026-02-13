import { Field, Struct, Poseidon } from 'o1js';

/**
 * Pharmacy — maps to NCPDP Transaction Header / Pharmacy Provider segment.
 *
 * NCPDP Source Fields:
 *   201-B1  Service Provider ID Qualifier
 *   202-B2  Service Provider ID (NPI)
 */
export class PharmacyData extends Struct({
  /** Service provider ID qualifier (201-B1) */
  serviceProviderIdQualifier: Field,
  /** Poseidon hash of pharmacy NPI (202-B2) */
  serviceProviderIdHash: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.serviceProviderIdQualifier,
      this.serviceProviderIdHash,
    ]);
  }
}

/**
 * Raw pharmacy data — lives locally, never on-chain.
 */
export interface PharmacyLocalData {
  serviceProviderIdQualifier: number;  // 201-B1
  serviceProviderId: string;           // 202-B2 (NPI)
}
