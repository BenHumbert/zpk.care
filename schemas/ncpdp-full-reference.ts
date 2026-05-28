/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * NCPDP Telecommunication Standard Version D.0 — Full Field Reference
 *
 * This file serves as a reference catalog of ALL NCPDP fields.
 * We will cherry-pick from this when building specific features.
 *
 * Format: Field Name (Field ID) — Description
 * Organized by segment as defined in NCPDP D.0 spec.
 */

export const NCPDP_FULL_REFERENCE = {

  // ─────────────────────────────────────────────
  // TRANSACTION HEADER SEGMENT
  // ─────────────────────────────────────────────
  transactionHeader: {
    binNumber:                  { id: '301-C1', desc: 'Bank Identification Number' },
    versionReleaseNumber:       { id: '102-A2', desc: 'Version/Release Number' },
    transactionCode:            { id: '103-A3', desc: 'Transaction Code (B1=Billing, B2=Reversal, B3=Rebill, E1=Eligibility, P1=PA Request, P2=PA Reversal, P3=PA Inquiry, P4=PA Appeal)' },
    transactionCount:           { id: '109-A9', desc: 'Transaction Count' },
    serviceProviderIdQualifier: { id: '201-B1', desc: 'Service Provider ID Qualifier (01=NPI, 05=Medicaid, 07=NCPDP)' },
    serviceProviderId:          { id: '202-B2', desc: 'Service Provider ID (NPI)' },
    dateOfService:              { id: '401-D1', desc: 'Date of Service (CCYYMMDD)' },
    softwareVendorId:           { id: '110-AK', desc: 'Software Vendor/Certification ID' },
    processorControlNumber:     { id: '312-CC', desc: 'Processor Control Number' },
  },

  // ─────────────────────────────────────────────
  // PATIENT SEGMENT (AM01)
  // ─────────────────────────────────────────────
  patient: {
    patientIdQualifier:         { id: '331-CX', desc: 'Patient ID Qualifier' },
    patientId:                  { id: '332-CY', desc: 'Patient ID' },
    dateOfBirth:                { id: '304-C4', desc: 'Date of Birth (CCYYMMDD)' },
    genderCode:                 { id: '305-C5', desc: 'Gender Code (1=Male, 2=Female, 0=Not Specified)' },
    patientFirstName:           { id: '310-CA', desc: 'Patient First Name' },
    patientLastName:            { id: '311-CB', desc: 'Patient Last Name' },
    streetAddress:              { id: '322-CM', desc: 'Patient Street Address' },
    city:                       { id: '323-CN', desc: 'Patient City' },
    stateProvince:              { id: '324-CO', desc: 'Patient State/Province' },
    zipPostalCode:              { id: '325-CP', desc: 'Patient ZIP/Postal Code' },
    phoneNumber:                { id: '326-CQ', desc: 'Patient Phone Number' },
    placeOfService:             { id: '307-C7', desc: 'Place of Service' },
    pregnancyIndicator:         { id: '335-2C', desc: 'Pregnancy Indicator' },
    patientRelationshipCode:    { id: '306-C6', desc: 'Patient Relationship Code' },
    patientLocation:            { id: '384-4X', desc: 'Patient Residence' },
    patientEmailAddress:        { id: '350-HN', desc: 'Patient Email Address' },
  },

  // ─────────────────────────────────────────────
  // INSURANCE SEGMENT (AM04)
  // ─────────────────────────────────────────────
  insurance: {
    cardholderIdNumber:         { id: '302-C2', desc: 'Cardholder ID Number' },
    cardholderFirstName:        { id: '312-CC', desc: 'Cardholder First Name' },
    cardholderLastName:         { id: '313-CD', desc: 'Cardholder Last Name' },
    homePlan:                   { id: '315-CF', desc: 'Home Plan' },
    planId:                     { id: '524-FO', desc: 'Plan ID' },
    eligibilityClarificationCode: { id: '309-C9', desc: 'Eligibility Clarification Code' },
    groupId:                    { id: '301-C1', desc: 'Group ID' },
    personCode:                 { id: '303-C3', desc: 'Person Code' },
    patientRelationshipCode:    { id: '306-C6', desc: 'Patient Relationship Code' },
    otherPayerCoverageType:     { id: '338-5C', desc: 'Other Payer Coverage Type' },
    medicaidIndicator:          { id: '346-HC', desc: 'Medicaid Indicator' },
    providerAcceptAssignment:   { id: '347-HD', desc: 'Provider Accept Assignment Indicator' },
    cmsLowIncomeSubsidy:        { id: '379-MU', desc: 'CMS Low Income Subsidy Level' },
    otherPayerIdQualifier:      { id: '338-2A', desc: 'Other Payer ID Qualifier' },
    otherPayerId:               { id: '339-6C', desc: 'Other Payer ID' },
    otherPayerDate:             { id: '443-E8', desc: 'Other Payer Date' },
  },

  // ─────────────────────────────────────────────
  // CLAIM SEGMENT (AM07)
  // ─────────────────────────────────────────────
  claim: {
    rxServiceRefNumQualifier:   { id: '455-EM', desc: 'Prescription/Service Reference Number Qualifier (1=Rx, 2=Service)' },
    rxServiceRefNumber:         { id: '402-D2', desc: 'Prescription/Service Reference Number' },
    productServiceIdQualifier:  { id: '436-E1', desc: 'Product/Service ID Qualifier (03=NDC)' },
    productServiceId:           { id: '407-D7', desc: 'Product/Service ID (NDC Number)' },
    quantityDispensed:          { id: '442-E7', desc: 'Quantity Dispensed' },
    fillNumber:                 { id: '403-D3', desc: 'Fill Number' },
    daysSupply:                 { id: '405-D5', desc: 'Days Supply' },
    compoundCode:               { id: '406-D6', desc: 'Compound Code (1=Not Compound, 2=Compound)' },
    dawProductSelectionCode:    { id: '408-D8', desc: 'Dispense as Written (DAW) / Product Selection Code' },
    dateRxWritten:              { id: '414-DE', desc: 'Date Prescription Written (CCYYMMDD)' },
    numberOfRefillsAuthorized:  { id: '415-DF', desc: 'Number of Refills Authorized' },
    rxOriginCode:               { id: '419-DJ', desc: 'Prescription Origin Code (1=Written, 2=Phone, 3=Electronic, 4=Fax, 5=Pharmacy)' },
    submissionClarificationCode: { id: '420-DK', desc: 'Submission Clarification Code' },
    otherCoverageCode:          { id: '308-C8', desc: 'Other Coverage Code' },
    specialPackagingIndicator:  { id: '429-DT', desc: 'Special Packaging Indicator' },
    originallyPrescribedProductId: { id: '453-EJ', desc: 'Originally Prescribed Product/Service Code' },
    originallyPrescribedQuantity: { id: '454-EK', desc: 'Originally Prescribed Quantity' },
    unitOfMeasure:              { id: '600-28', desc: 'Unit of Measure' },
    levelOfService:             { id: '418-DI', desc: 'Level of Service' },
    priorAuthTypeCode:          { id: '461-EU', desc: 'Prior Authorization Type Code' },
    priorAuthNumberSubmitted:   { id: '462-EV', desc: 'Prior Authorization Number Submitted' },
    intermediaryAuthTypeId:     { id: '463-EW', desc: 'Intermediary Authorization Type ID' },
    intermediaryAuthId:         { id: '464-EX', desc: 'Intermediary Authorization ID' },
    scheduledRxIdNumber:        { id: '456-EN', desc: 'Scheduled Prescription ID Number' },
    unitDoseIndicator:          { id: '457-EP', desc: 'Unit Dose Indicator' },
    routeOfAdministration:      { id: '995-G1', desc: 'Route of Administration' },
    compoundType:               { id: '996-G2', desc: 'Compound Type' },
    medicationNonAdministered:  { id: '997-G3', desc: 'Medicaid Subrogation Internal Control Number/Transaction Control Number' },
    associatedRxServiceRefNum:  { id: '456-EN', desc: 'Associated Prescription/Service Reference Number' },
    associatedRxServiceDate:    { id: '457-EP', desc: 'Associated Prescription/Service Date' },
    procedureModifierCode:      { id: '458-SE', desc: 'Procedure Modifier Code' },
    quantityPrescribed:         { id: '460-ET', desc: 'Quantity Prescribed' },
  },

  // ─────────────────────────────────────────────
  // PRESCRIBER SEGMENT (AM03)
  // ─────────────────────────────────────────────
  prescriber: {
    prescriberIdQualifier:      { id: '465-EY', desc: 'Prescriber ID Qualifier (01=NPI, 12=DEA, 16=State License)' },
    prescriberId:               { id: '411-DB', desc: 'Prescriber ID (NPI Number)' },
    prescriberLastName:         { id: '427-DR', desc: 'Prescriber Last Name' },
    prescriberFirstName:        { id: '364-2J', desc: 'Prescriber First Name' },
    prescriberStreetAddress:    { id: '365-2K', desc: 'Prescriber Street Address' },
    prescriberCity:             { id: '366-2M', desc: 'Prescriber City' },
    prescriberState:            { id: '367-2N', desc: 'Prescriber State/Province' },
    prescriberZip:              { id: '368-2P', desc: 'Prescriber ZIP/Postal Code' },
    prescriberPhone:            { id: '498-PM', desc: 'Prescriber Phone Number' },
    primaryCareProviderIdQual:  { id: '421-DL', desc: 'Primary Care Provider ID Qualifier' },
    primaryCareProviderId:      { id: '422-DM', desc: 'Primary Care Provider ID' },
    primaryCareProviderLastName: { id: '474-8E', desc: 'Primary Care Provider Last Name' },
    prescriberDEANumber:        { id: '411-DB', desc: 'Prescriber DEA Number (when qualifier=12)' },
    prescriberStateLicense:     { id: '411-DB', desc: 'Prescriber State License (when qualifier=16)' },
    supervisorIdQualifier:      { id: '465-EY', desc: 'Supervisor ID Qualifier' },
    supervisorId:               { id: '411-DB', desc: 'Supervisor ID' },
    supervisorLastName:         { id: '427-DR', desc: 'Supervisor Last Name' },
  },

  // ─────────────────────────────────────────────
  // PHARMACY PROVIDER SEGMENT (AM02)
  // ─────────────────────────────────────────────
  pharmacyProvider: {
    pharmacyServiceProviderIdQualifier: { id: '201-B1', desc: 'Pharmacy Service Provider ID Qualifier' },
    pharmacyServiceProviderId:  { id: '202-B2', desc: 'Pharmacy Service Provider ID (NPI)' },
    pharmacyName:               { id: '553-AW', desc: 'Pharmacy Name (from provider file, not transmitted)' },
    pharmacyStreetAddress:      { id: '225-BW', desc: 'Pharmacy Street Address (from provider file)' },
    pharmacyCity:               { id: '226-BX', desc: 'Pharmacy City' },
    pharmacyState:              { id: '227-BY', desc: 'Pharmacy State' },
    pharmacyZip:                { id: '228-BZ', desc: 'Pharmacy ZIP' },
    pharmacyPhone:              { id: '229-BA', desc: 'Pharmacy Phone Number' },
  },

  // ─────────────────────────────────────────────
  // PRICING SEGMENT (AM11)
  // ─────────────────────────────────────────────
  pricing: {
    ingredientCostSubmitted:    { id: '409-D9', desc: 'Ingredient Cost Submitted' },
    dispensingFeeSubmitted:     { id: '412-DC', desc: 'Dispensing Fee Submitted' },
    usualAndCustomaryCharge:    { id: '426-DQ', desc: 'Usual and Customary Charge' },
    grossAmountDue:             { id: '430-DU', desc: 'Gross Amount Due' },
    basisOfCostDetermination:   { id: '423-DN', desc: 'Basis of Cost Determination' },
    flatSalesTaxAmountSubmitted: { id: '481-HA', desc: 'Flat Sales Tax Amount Submitted' },
    percentageSalesTaxAmountSubmitted: { id: '482-GE', desc: 'Percentage Sales Tax Amount Submitted' },
    percentageSalesTaxRateSubmitted: { id: '483-HE', desc: 'Percentage Sales Tax Rate Submitted' },
    percentageSalesTaxBasisSubmitted: { id: '484-JE', desc: 'Percentage Sales Tax Basis Submitted' },
    incentiveAmountSubmitted:   { id: '438-E3', desc: 'Incentive Amount Submitted' },
    otherAmountClaimedQualifier: { id: '479-H8', desc: 'Other Amount Claimed Submitted Qualifier' },
    otherAmountClaimedSubmitted: { id: '480-H9', desc: 'Other Amount Claimed Submitted' },
    patientPaidAmountSubmitted: { id: '433-DX', desc: 'Patient Paid Amount Submitted' },
    delayReasonCode:            { id: '357-NV', desc: 'Delay Reason Code' },
  },

  // ─────────────────────────────────────────────
  // COB (COORDINATION OF BENEFITS) SEGMENT (AM05)
  // ─────────────────────────────────────────────
  coordinationOfBenefits: {
    otherPayerCoverageType:     { id: '338-5C', desc: 'Other Payer Coverage Type' },
    otherPayerIdQualifier:      { id: '338-2A', desc: 'Other Payer ID Qualifier' },
    otherPayerId:               { id: '339-6C', desc: 'Other Payer ID' },
    otherPayerDate:             { id: '443-E8', desc: 'Other Payer Date' },
    otherPayerAmountPaidQualifier: { id: '341-HB', desc: 'Other Payer Amount Paid Qualifier' },
    otherPayerAmountPaid:       { id: '431-DV', desc: 'Other Payer Amount Paid' },
    otherPayerRejectCode:       { id: '472-6E', desc: 'Other Payer Reject Code' },
    otherPayerPatientRespAmtQual: { id: '351-NP', desc: 'Other Payer-Patient Responsibility Amount Qualifier' },
    otherPayerPatientRespAmt:   { id: '352-NQ', desc: 'Other Payer-Patient Responsibility Amount' },
    benefitStageQualifier:      { id: '394-MW', desc: 'Benefit Stage Qualifier' },
    benefitStageAmount:         { id: '392-MU', desc: 'Benefit Stage Amount' },
  },

  // ─────────────────────────────────────────────
  // CLINICAL SEGMENT (AM13)
  // ─────────────────────────────────────────────
  clinical: {
    diagnosisCodeQualifier:     { id: '491-VE', desc: 'Diagnosis Code Qualifier (01=ICD9, 02=ICD10)' },
    diagnosisCode:              { id: '424-DO', desc: 'Diagnosis Code' },
    clinicalInformationCounter: { id: '491-VE', desc: 'Clinical Information Counter' },
    measurementDate:            { id: '388-5E', desc: 'Measurement Date' },
    measurementTime:            { id: '389-6E', desc: 'Measurement Time' },
    measurementDimension:       { id: '390-7E', desc: 'Measurement Dimension' },
    measurementUnit:            { id: '391-8E', desc: 'Measurement Unit' },
    measurementValue:           { id: '392-MU', desc: 'Measurement Value' },
  },

  // ─────────────────────────────────────────────
  // DUR/PPS (Drug Utilization Review) SEGMENT (AM08)
  // ─────────────────────────────────────────────
  durPps: {
    durPpsCodeCounter:          { id: '473-7E', desc: 'DUR/PPS Code Counter' },
    reasonForServiceCode:       { id: '439-E4', desc: 'Reason for Service Code' },
    professionalServiceCode:    { id: '440-E5', desc: 'Professional Service Code' },
    resultOfServiceCode:        { id: '441-E6', desc: 'Result of Service Code' },
    durPpsLevelOfEffort:        { id: '474-8E', desc: 'DUR/PPS Level of Effort' },
    durCoAgentIdQualifier:      { id: '475-J9', desc: 'DUR Co-Agent ID Qualifier' },
    durCoAgentId:               { id: '476-H6', desc: 'DUR Co-Agent ID' },
  },

  // ─────────────────────────────────────────────
  // FACILITY SEGMENT (AM14)
  // ─────────────────────────────────────────────
  facility: {
    facilityIdQualifier:        { id: '333-CZ', desc: 'Facility ID Qualifier' },
    facilityId:                 { id: '334-1C', desc: 'Facility ID' },
    facilityName:               { id: '336-4C', desc: 'Facility Name' },
    facilityStreetAddress:      { id: '337-4D', desc: 'Facility Street Address' },
    facilityCity:               { id: '338-5C', desc: 'Facility City' },
    facilityState:              { id: '339-6C', desc: 'Facility State' },
    facilityZip:                { id: '340-7C', desc: 'Facility ZIP' },
  },

  // ─────────────────────────────────────────────
  // WORKERS COMPENSATION SEGMENT (AM10)
  // ─────────────────────────────────────────────
  workersCompensation: {
    dateOfInjury:               { id: '434-DY', desc: 'Date of Injury' },
    employerName:               { id: '435-DZ', desc: 'Employer Name' },
    employerStreetAddress:      { id: '436-E1', desc: 'Employer Street Address' },
    employerCity:               { id: '437-E2', desc: 'Employer City' },
    employerState:              { id: '438-E3', desc: 'Employer State' },
    employerZip:                { id: '439-E4', desc: 'Employer ZIP' },
    employerPhone:              { id: '440-E5', desc: 'Employer Phone Number' },
    carrierIdQualifier:         { id: '441-E6', desc: 'Workers Comp Carrier ID Qualifier' },
    carrierId:                  { id: '442-E7', desc: 'Workers Comp Carrier ID' },
    claimReferenceId:           { id: '443-E8', desc: 'Workers Comp Claim Reference ID' },
    billingEntityTypeIndicator: { id: '444-E9', desc: 'Billing Entity Type Indicator' },
    payToQualifier:             { id: '445-EA', desc: 'Pay To Qualifier' },
    payToId:                    { id: '446-EB', desc: 'Pay To ID' },
    payToName:                  { id: '447-EC', desc: 'Pay To Name' },
    genericEquivalentProductIdQualifier: { id: '448-ED', desc: 'Generic Equivalent Product ID Qualifier' },
    genericEquivalentProductId: { id: '449-EE', desc: 'Generic Equivalent Product ID' },
  },

  // ─────────────────────────────────────────────
  // COMPOUND SEGMENT (AM09)
  // ─────────────────────────────────────────────
  compound: {
    compoundDosageFormDescCode: { id: '450-EF', desc: 'Compound Dosage Form Description Code' },
    compoundDispensingUnitFormIndicator: { id: '451-EG', desc: 'Compound Dispensing Unit Form Indicator' },
    compoundIngredientComponentCount: { id: '447-EC', desc: 'Compound Ingredient Component Count' },
    compoundProductIdQualifier: { id: '448-ED', desc: 'Compound Product ID Qualifier' },
    compoundProductId:          { id: '449-EE', desc: 'Compound Product ID' },
    compoundIngredientQuantity: { id: '446-EB', desc: 'Compound Ingredient Quantity' },
    compoundIngredientDrugCost: { id: '490-UE', desc: 'Compound Ingredient Drug Cost' },
    compoundIngredientBasisOfCostDetermination: { id: '452-EH', desc: 'Compound Ingredient Basis of Cost Determination' },
    compoundIngredientModifierCode: { id: '453-EJ', desc: 'Compound Ingredient Modifier Code Count' },
  },

  // ─────────────────────────────────────────────
  // PRIOR AUTHORIZATION SEGMENT (AM06)
  // ─────────────────────────────────────────────
  priorAuthorization: {
    priorAuthTypeCode:          { id: '461-EU', desc: 'Prior Authorization Type Code' },
    priorAuthNumberSubmitted:   { id: '462-EV', desc: 'Prior Authorization Number Submitted' },
    authorizationNumber:        { id: '503-F3', desc: 'Authorization Number' },
    priorAuthProcessedDate:     { id: '498-PM', desc: 'Prior Auth Processed Date' },
    priorAuthEffectiveDate:     { id: '499-PN', desc: 'Prior Auth Effective Date' },
    priorAuthExpirationDate:    { id: '500-PP', desc: 'Prior Auth Expiration Date' },
    priorAuthNumberOfRefillsAuth: { id: '503-F3', desc: 'Prior Auth Number of Refills Authorized' },
    priorAuthQuantityAccumulated: { id: '504-F4', desc: 'Prior Auth Quantity Accumulated' },
  },

} as const;
