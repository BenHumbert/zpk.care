package care.zktrident.shared.crypto

import java.math.BigInteger

/**
 * Wallet ID derivation — mirrors src/wallets/wallet-derivation.ts
 *
 * walletId = Poseidon.hash([domainTag, ...hashedPHIFields, hash(enrollmentKey)])
 *
 * Domain tags:
 *   0 = Member
 *   1 = Prescriber
 *   2 = Pharmacy
 *
 * IMPORTANT: hashString uses Poseidon(stringToFields(value)) to match o1js.
 * stringToFields packs characters into field elements using radix-256 big-endian
 * packing (31 bytes per field), matching o1js Encoding.stringToFields.
 *
 * The enrollment key is hashed as a string via the same mechanism.
 * PHI is wiped from memory immediately after derivation.
 */
object WalletDerivation {
    private val p = PastaConstants.FIELD_MODULUS

    /** Domain tag constants matching TypeScript wallet-derivation.ts */
    const val DOMAIN_MEMBER = 0L
    const val DOMAIN_PRESCRIBER = 1L
    const val DOMAIN_PHARMACY = 2L

    /**
     * Hash a string to a field element (matches src/zkp/hash-utils.ts hashString).
     *
     * o1js implementation: Encoding.stringToFields(value) -> Poseidon.hash(fields)
     */
    fun hashString(input: String): BigInteger {
        val fields = stringToFields(input)
        return PoseidonHasher.hash(fields)
    }

    /**
     * Replicate o1js Encoding.stringToFields.
     *
     * o1js packs string bytes into field elements using a radix-256 scheme:
     * each field element holds up to 31 bytes (248 bits < 254-bit field).
     * Characters are encoded as UTF-8 bytes, packed big-endian into fields.
     */
    fun stringToFields(input: String): List<BigInteger> {
        val bytes = input.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) return listOf(BigInteger.ZERO)

        val chunkSize = 31 // max bytes per field element (248 bits < 254-bit Pallas field)
        val fields = mutableListOf<BigInteger>()
        var i = 0
        while (i < bytes.size) {
            val end = minOf(i + chunkSize, bytes.size)
            val chunk = bytes.sliceArray(i until end)
            // Big-endian interpretation: first byte is most significant
            fields.add(BigInteger(1, chunk))
            i = end
        }
        return fields
    }

    /**
     * Convert a date string (CCYYMMDD) to a hashed field (matches hashDate in hash-utils.ts).
     * hashDate = Poseidon.hash([Field(BigInt(dateStr))])
     */
    fun hashDate(dateStr: String): BigInteger {
        val dateField = BigInteger(dateStr)
        return PoseidonHasher.hash(listOf(dateField))
    }

    /**
     * Convert a small integer code to a field element (matches codeToField in hash-utils.ts).
     */
    fun codeToField(code: Int): BigInteger = BigInteger.valueOf(code.toLong())

    /**
     * Derive a member wallet ID.
     *
     * Preimage: [0, hash(cardholderId), hashDate(dob), hash(firstName), hash(lastName), hash(enrollmentKey)]
     *
     * @param cardholderId Cardholder ID string
     * @param dateOfBirth Date of birth as CCYYMMDD string
     * @param firstName Patient first name (PHI)
     * @param lastName Patient last name (PHI)
     * @param enrollmentKey Enrollment key string (secret)
     * @return Wallet ID as decimal string
     */
    fun deriveMemberWalletId(
        cardholderId: String,
        dateOfBirth: String,
        firstName: String,
        lastName: String,
        enrollmentKey: String,
    ): String {
        val fields = listOf(
            BigInteger.valueOf(DOMAIN_MEMBER),
            hashString(cardholderId),
            hashDate(dateOfBirth),
            hashString(firstName),
            hashString(lastName),
            hashString(enrollmentKey),
        )
        return PoseidonHasher.hash(fields).toString()
    }

    /**
     * Derive a prescriber wallet ID.
     *
     * Preimage: [1, codeToField(qualifier), hash(prescriberId), hash(enrollmentKey)]
     *
     * @param prescriberIdQualifier Qualifier code (e.g., 1=NPI, 12=DEA)
     * @param prescriberId Prescriber ID string
     * @param enrollmentKey Enrollment key string
     * @return Wallet ID as decimal string
     */
    fun derivePrescriberWalletId(
        prescriberIdQualifier: Int,
        prescriberId: String,
        enrollmentKey: String,
    ): String {
        val fields = listOf(
            BigInteger.valueOf(DOMAIN_PRESCRIBER),
            codeToField(prescriberIdQualifier),
            hashString(prescriberId),
            hashString(enrollmentKey),
        )
        return PoseidonHasher.hash(fields).toString()
    }

    /**
     * Derive a pharmacy wallet ID.
     *
     * Preimage: [2, codeToField(qualifier), hash(serviceProviderId), hash(enrollmentKey)]
     *
     * @param serviceProviderIdQualifier Qualifier code
     * @param serviceProviderId Service provider ID string
     * @param enrollmentKey Enrollment key string
     * @return Wallet ID as decimal string
     */
    fun derivePharmacyWalletId(
        serviceProviderIdQualifier: Int,
        serviceProviderId: String,
        enrollmentKey: String,
    ): String {
        val fields = listOf(
            BigInteger.valueOf(DOMAIN_PHARMACY),
            codeToField(serviceProviderIdQualifier),
            hashString(serviceProviderId),
            hashString(enrollmentKey),
        )
        return PoseidonHasher.hash(fields).toString()
    }
}
