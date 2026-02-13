import { Field, Struct, Poseidon } from 'o1js';

/**
 * TransactionHeader — maps to NCPDP Transaction Header segment (minimum fields).
 *
 * NCPDP Source Fields:
 *   301-C1  BIN Number
 *   102-A2  Version/Release Number
 *   103-A3  Transaction Code
 *   312-CC  Processor Control Number
 *   401-D1  Date of Service (CCYYMMDD)
 */
export class TransactionHeaderData extends Struct({
  /** Poseidon hash of BIN number (301-C1) */
  binNumberHash: Field,
  /** Version/release number as Field */
  versionReleaseNumber: Field,
  /** Transaction code (B1=1, B2=2, B3=3, E1=4, etc.) mapped to numeric */
  transactionCode: Field,
  /** Poseidon hash of processor control number (312-CC) */
  processorControlNumberHash: Field,
  /** Date of service as numeric CCYYMMDD */
  dateOfService: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.binNumberHash,
      this.versionReleaseNumber,
      this.transactionCode,
      this.processorControlNumberHash,
      this.dateOfService,
    ]);
  }
}

/**
 * Raw transaction header data — lives locally, never on-chain.
 */
export interface TransactionHeaderLocalData {
  binNumber: string;              // 301-C1
  versionReleaseNumber: string;   // 102-A2
  transactionCode: string;        // 103-A3
  processorControlNumber: string; // 312-CC
  dateOfService: string;          // 401-D1 (CCYYMMDD)
}
