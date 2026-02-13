import { Field, Poseidon } from 'o1js';
import { MemberData } from '../models/member.js';
import { PrescriberData } from '../models/prescriber.js';
import { PharmacyData } from '../models/pharmacy.js';
import { MedicationData, MedicationPricingData } from '../models/medication.js';
import { TransactionHeaderData } from '../models/transaction-header.js';
import { hashString, dateToField, codeToField, centsToField, quantityToField } from './hash-utils.js';
import type { MemberLocalData } from '../models/member.js';
import type { PrescriberLocalData } from '../models/prescriber.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';
import type { MedicationLocalData, MedicationPricingLocalData } from '../models/medication.js';
import type { TransactionHeaderLocalData } from '../models/transaction-header.js';

/**
 * Commitment Builders
 *
 * These functions take raw local data (PHI/PII) and produce
 * ZK-compatible Struct instances with hashed fields.
 *
 * Flow: LocalData (device) → Builder → Struct → .commitment() → Merkle leaf
 */

export function buildMemberData(local: MemberLocalData): MemberData {
  return new MemberData({
    cardholderIdHash: hashString(local.cardholderId),
    dateOfBirth: dateToField(local.dateOfBirth),
    genderCode: codeToField(local.genderCode),
    firstNameHash: hashString(local.firstName),
    lastNameHash: hashString(local.lastName),
  });
}

export function buildPrescriberData(local: PrescriberLocalData): PrescriberData {
  return new PrescriberData({
    prescriberIdQualifier: codeToField(local.prescriberIdQualifier),
    prescriberIdHash: hashString(local.prescriberId),
  });
}

export function buildPharmacyData(local: PharmacyLocalData): PharmacyData {
  return new PharmacyData({
    serviceProviderIdQualifier: codeToField(local.serviceProviderIdQualifier),
    serviceProviderIdHash: hashString(local.serviceProviderId),
  });
}

export function buildMedicationData(local: MedicationLocalData): MedicationData {
  return new MedicationData({
    rxRefNumberHash: hashString(local.rxServiceRefNumber),
    ndcHash: hashString(local.productServiceId),
    quantityDispensed: quantityToField(local.quantityDispensed),
    fillNumber: codeToField(local.fillNumber),
    daysSupply: codeToField(local.daysSupply),
    compoundCode: codeToField(local.compoundCode),
    dawCode: codeToField(local.dawProductSelectionCode),
  });
}

export function buildMedicationPricingData(local: MedicationPricingLocalData): MedicationPricingData {
  return new MedicationPricingData({
    usualAndCustomaryCharge: centsToField(local.usualAndCustomaryCharge),
    quantityPrescribed: quantityToField(local.quantityPrescribed),
    ingredientCostSubmitted: centsToField(local.ingredientCostSubmitted),
    dispensingFeeSubmitted: centsToField(local.dispensingFeeSubmitted),
    basisOfCostDetermination: codeToField(local.basisOfCostDetermination),
  });
}

export function buildTransactionHeaderData(local: TransactionHeaderLocalData): TransactionHeaderData {
  return new TransactionHeaderData({
    binNumberHash: hashString(local.binNumber),
    versionReleaseNumber: dateToField(local.versionReleaseNumber),
    transactionCode: hashString(local.transactionCode),
    processorControlNumberHash: hashString(local.processorControlNumber),
    dateOfService: dateToField(local.dateOfService),
  });
}

/**
 * Generate a unique member identifier.
 * This is the root identity used across the system to link
 * a member to their proof-gated wallet and all associated NFTs.
 */
export function generateMemberIdentifier(local: MemberLocalData): Field {
  return Poseidon.hash([
    hashString(local.cardholderId),
    dateToField(local.dateOfBirth),
    hashString(local.firstName),
    hashString(local.lastName),
  ]);
}
