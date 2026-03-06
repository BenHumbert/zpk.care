package care.zktrident.shared.crypto

/**
 * Pasta curve constants for Poseidon hash over the Pallas base field.
 *
 * These constants produce identical output to o1js Poseidon.hash().
 * Extracted from o1js/src/bindings/crypto/constants.ts (poseidonParamsKimchiFp).
 *
 * Poseidon parameters:
 *   - Width: 3 (sponge state = 3 field elements)
 *   - Rate: 2 (absorb 2 elements per permutation)
 *   - Full rounds: 55 (ALL rounds are full — no partial rounds)
 *   - Partial rounds: 0
 *   - S-box exponent: 7 (x^7, applied to ALL state elements)
 *   - hasInitialRoundConstant: false (ARK at end of round, not beginning)
 *   - Field: Pallas base field
 */
object PastaConstants {
    /** Pallas base field modulus */
    val FIELD_MODULUS: java.math.BigInteger = java.math.BigInteger(
        "28948022309329048855892746252171976963363056481941560715954676764349967630337"
    )

    /** Sponge width */
    const val WIDTH = 3

    /** Sponge rate (elements absorbed per permutation) */
    const val RATE = 2

    /** Number of full rounds (ALL rounds are full — no partial rounds in Kimchi) */
    const val FULL_ROUNDS = 55

    /** Number of partial rounds (zero in Kimchi Poseidon) */
    const val PARTIAL_ROUNDS = 0

    /** S-box exponent */
    const val SBOX_EXP = 7

    /** Whether ARK is applied before S-box (false = ARK at end of round) */
    const val HAS_INITIAL_ROUND_CONSTANT = false

    /**
     * MDS matrix (3x3) for the Kimchi Poseidon instance.
     * Extracted from o1js/src/bindings/crypto/constants.ts lines 506-521.
     */
    val MDS: Array<Array<java.math.BigInteger>> = arrayOf(
        arrayOf(
            java.math.BigInteger("12035446894107573964500871153637039653510326950134440362813193268448863222019"),
            java.math.BigInteger("25461374787957152039031444204194007219326765802730624564074257060397341542093"),
            java.math.BigInteger("27667907157110496066452777015908813333407980290333709698851344970789663080149"),
        ),
        arrayOf(
            java.math.BigInteger("4491931056866994439025447213644536587424785196363427220456343191847333476930"),
            java.math.BigInteger("14743631939509747387607291926699970421064627808101543132147270746750887019919"),
            java.math.BigInteger("9448400033389617131295304336481030167723486090288313334230651810071857784477"),
        ),
        arrayOf(
            java.math.BigInteger("10525578725509990281643336361904863911009900817790387635342941550657754064843"),
            java.math.BigInteger("27437632000253211280915908546961303399777448677029255413769125486614773776695"),
            java.math.BigInteger("27566319851776897085443681456689352477426926500749993803132851225169606086988"),
        ),
    )
}
