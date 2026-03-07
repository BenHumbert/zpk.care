package care.zktrident.shared.crypto

import java.math.BigInteger
import java.nio.charset.Charset

/**
 * Wallet ID derivation matching the TypeScript implementation.
 *
 * walletId = Poseidon.hash([domainTag, hashString(cardholderId), hashDate(dob),
 *   hashString(firstName), hashString(lastName), hashString(enrollmentKey)])
 */
object WalletDerivation {
    /** Domain tag for member wallets (matches TypeScript DOMAIN_TAG_MEMBER = Field(0)) */
    val DOMAIN_TAG_MEMBER = BigInteger.ZERO
    /** Domain tag for prescriber wallets (matches TypeScript DOMAIN_TAG_PRESCRIBER = Field(1)) */
    val DOMAIN_TAG_PRESCRIBER = BigInteger.ONE
    /** Domain tag for pharmacy wallets (matches TypeScript DOMAIN_TAG_PHARMACY = Field(2)) */
    val DOMAIN_TAG_PHARMACY = BigInteger.TWO

    /**
     * Derive a member wallet ID from local PHI data.
     * PHI is hashed immediately and never stored.
     */
    fun deriveMemberWalletId(
        cardholderId: String,
        dateOfBirth: String,  // YYYYMMDD format as numeric string
        firstName: String,
        lastName: String,
        enrollmentKey: String
    ): BigInteger {
        require(enrollmentKey.length >= 16) { "Enrollment key must be at least 16 characters" }
        return PoseidonHasher.hash(listOf(
            DOMAIN_TAG_MEMBER,
            hashString(cardholderId),
            hashDate(dateOfBirth),
            hashString(firstName),
            hashString(lastName),
            hashString(enrollmentKey)
        ))
    }

    /**
     * Return the 6 preimage fields as decimal strings (for ProofDelegateServer).
     * These are the hashed fields that were used to derive the walletId.
     * The prover needs them to generate the registration proof.
     */
    fun memberPreimageFields(
        cardholderId: String,
        dateOfBirth: String,
        firstName: String,
        lastName: String,
        enrollmentKey: String,
    ): List<String> = listOf(
        DOMAIN_TAG_MEMBER.toString(),
        hashString(cardholderId).toString(),
        hashDate(dateOfBirth).toString(),
        hashString(firstName).toString(),
        hashString(lastName).toString(),
        hashString(enrollmentKey).toString(),
    )

    /**
     * Hash a string using the same encoding as o1js Encoding.stringToFields.
     *
     * stringToFields packs bytes in little-endian order, 31 bytes per Field,
     * with a 0x01 sentinel byte appended to the byte array before packing.
     */
    fun hashString(value: String): BigInteger {
        val fields = stringToFields(value)
        return PoseidonHasher.hash(fields)
    }

    /**
     * Hash a date string (YYYYMMDD) as BigInt, same as o1js hashDate.
     * hashDate(d) = Poseidon.hash([Field(BigInt(dateStr))])
     */
    fun hashDate(dateStr: String): BigInteger {
        return PoseidonHasher.hash(listOf(BigInteger(dateStr)))
    }

    /**
     * Convert string to Fields using o1js Encoding.stringToFields algorithm.
     *
     * 1. Get UTF-8 bytes
     * 2. Append 0x01 sentinel byte
     * 3. Pack into 31-byte chunks (little-endian) as BigIntegers
     */
    fun stringToFields(s: String): List<BigInteger> {
        val bytes = s.toByteArray(Charsets.UTF_8)
        // Append sentinel byte 0x01
        val withSentinel = bytes + byteArrayOf(1)

        val fields = mutableListOf<BigInteger>()
        var i = 0
        while (i < withSentinel.size) {
            val chunkEnd = minOf(i + 31, withSentinel.size)
            val chunk = withSentinel.sliceArray(i until chunkEnd)
            // Little-endian: byte[0] is least significant
            var value = BigInteger.ZERO
            for (j in chunk.indices) {
                value = value.or(BigInteger.valueOf(chunk[j].toLong() and 0xFF).shiftLeft(j * 8))
            }
            fields.add(value)
            i += 31
        }
        return fields
    }
}
