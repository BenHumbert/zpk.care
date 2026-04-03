/**
 * NCPDP Telecommunication Standard Version D.0 — Minimum Required Fields
 *
 * These are the minimum data elements required for claim adjudication.
 * Our ZK data models map directly to these fields.
 */

export const NCPDP_MINIMUM_FIELDS = {

  // ─────────────────────────────────────────────
  // TRANSACTION HEADER SEGMENT
  // ─────────────────────────────────────────────
  transactionHeader: {
    binNumber:                  { id: '301-C1', desc: 'Bank Identification Number', required: true },
    versionReleaseNumber:       { id: '102-A2', desc: 'Version/Release Number', required: true },
    transactionCode:            { id: '103-A3', desc: 'Transaction Code (B1=Billing)', required: true },
    processorControlNumber:     { id: '312-CC', desc: 'Processor Control Number', required: true },
    serviceProviderIdQualifier: { id: '201-B1', desc: 'Pharmacy Service Provider ID Qualifier', required: true },
    serviceProviderId:          { id: '202-B2', desc: 'Pharmacy Service Provider ID (NPI)', required: true },
    dateOfService:              { id: '401-D1', desc: 'Date of Service (CCYYMMDD)', required: true },
  },

  // ─────────────────────────────────────────────
  // PATIENT SEGMENT
  // ─────────────────────────────────────────────
  patient: {
    cardholderIdNumber:         { id: '302-C2', desc: 'Cardholder ID Number', required: true },
    dateOfBirth:                { id: '304-C4', desc: 'Date of Birth (CCYYMMDD)', required: true },
    genderCode:                 { id: '305-C5', desc: 'Gender Code', required: true },
    patientLastName:            { id: '311-CB', desc: 'Patient Last Name', required: true },
    patientFirstName:           { id: '310-CA', desc: 'Patient First Name', required: true },
  },

  // ─────────────────────────────────────────────
  // INSURANCE SEGMENT
  // ─────────────────────────────────────────────
  insurance: {
    processorControlNumber:     { id: '312-CC', desc: 'Processor Control Number', required: true },
    cardholderIdNumber:         { id: '302-C2', desc: 'Cardholder ID Number', required: true },
  },

  // ─────────────────────────────────────────────
  // CLAIM SEGMENT
  // ─────────────────────────────────────────────
  claim: {
    rxServiceRefNumQualifier:   { id: '455-EM', desc: 'Prescription/Service Reference Number Qualifier', required: true },
    rxServiceRefNumber:         { id: '402-D2', desc: 'Prescription/Service Reference Number', required: true },
    productServiceIdQualifier:  { id: '436-E1', desc: 'Product/Service ID Qualifier', required: true },
    productServiceId:           { id: '407-D7', desc: 'Product/Service ID (NDC Number)', required: true },
    quantityDispensed:          { id: '442-E7', desc: 'Quantity Dispensed', required: true },
    fillNumber:                 { id: '403-D3', desc: 'Fill Number', required: true },
    daysSupply:                 { id: '405-D5', desc: 'Days Supply', required: true },
    compoundCode:               { id: '406-D6', desc: 'Compound Code', required: true },
    dawProductSelectionCode:    { id: '408-D8', desc: 'DAW/Product Selection Code', required: true },
  },

  // ─────────────────────────────────────────────
  // PRESCRIBER SEGMENT
  // ─────────────────────────────────────────────
  prescriber: {
    prescriberIdQualifier:      { id: '465-EY', desc: 'Prescriber ID Qualifier (NPI)', required: true },
    prescriberId:               { id: '411-DB', desc: 'Prescriber ID (NPI Number)', required: true },
  },

  // ─────────────────────────────────────────────
  // PRICING SEGMENT
  // ─────────────────────────────────────────────
  pricing: {
    usualAndCustomaryCharge:    { id: '426-DQ', desc: 'Usual and Customary Charge', required: true },
    quantityPrescribed:         { id: '460-ET', desc: 'Quantity Prescribed (mandatory for CII)', required: true },
    ingredientCostSubmitted:    { id: '409-D9', desc: 'Ingredient Cost Submitted', required: true },
    dispensingFeeSubmitted:     { id: '412-DC', desc: 'Dispensing Fee Submitted', required: true },
    basisOfCostDetermination:   { id: '423-DN', desc: 'Basis of Cost Determination', required: true },
  },

} as const;
