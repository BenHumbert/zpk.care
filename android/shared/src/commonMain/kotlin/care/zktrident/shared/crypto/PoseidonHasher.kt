package care.zktrident.shared.crypto

import java.math.BigInteger

/**
 * Poseidon hash function over the Pallas base field (Kimchi variant).
 *
 * This implementation produces identical output to o1js Poseidon.hash().
 * It uses the Kimchi parameters: width-3 sponge, 55 full rounds (0 partial),
 * x^7 S-box on ALL state elements, ARK at END of each round.
 *
 * Permutation order per round: S-box -> MDS -> ARK
 * (hasInitialRoundConstant = false)
 */
object PoseidonHasher {
    private val p = PastaConstants.FIELD_MODULUS
    private val mds = PastaConstants.MDS
    private val width = PastaConstants.WIDTH
    private val fullRounds = PastaConstants.FULL_ROUNDS
    private val sboxExp = PastaConstants.SBOX_EXP.toBigInteger()

    private val roundConstants: Array<Array<BigInteger>> by lazy {
        PoseidonRoundConstants.ROUND_CONSTANTS
    }

    /**
     * Poseidon hash of a list of field elements.
     *
     * Matches o1js behavior:
     * - Sponge construction with rate=2, capacity=1
     * - Input zero-padded to multiple of rate
     * - Output = state[0] after final permutation
     */
    fun hash(inputs: List<BigInteger>): BigInteger {
        val state = Array(width) { BigInteger.ZERO }

        if (inputs.isEmpty()) {
            // Empty input: one permutation on zero state
            permute(state)
            return state[0]
        }

        // Zero-pad to multiple of rate
        val paddedSize = ((inputs.size + PastaConstants.RATE - 1) / PastaConstants.RATE) * PastaConstants.RATE
        val padded = inputs.toMutableList()
        while (padded.size < paddedSize) padded.add(BigInteger.ZERO)

        // Absorb in chunks of RATE
        var i = 0
        while (i < padded.size) {
            for (j in 0 until PastaConstants.RATE) {
                state[j] = (state[j] + padded[i + j]).mod(p)
            }
            permute(state)
            i += PastaConstants.RATE
        }

        return state[0]
    }

    fun hash(input: BigInteger): BigInteger = hash(listOf(input))

    fun hashStrings(inputs: List<String>): String =
        hash(inputs.map { BigInteger(it) }).toString()

    /**
     * The Poseidon permutation (Kimchi variant).
     *
     * 55 full rounds, each: S-box -> MDS -> ARK
     * No partial rounds. No initial ARK.
     */
    private fun permute(state: Array<BigInteger>) {
        for (round in 0 until fullRounds) {
            // 1. S-box: x^7 on ALL state elements
            for (i in 0 until width) {
                state[i] = state[i].modPow(sboxExp, p)
            }

            // 2. MDS matrix multiplication
            mdsMultiply(state)

            // 3. Add round constants (ARK)
            val rc = roundConstants[round]
            for (i in 0 until width) {
                state[i] = (state[i] + rc[i]).mod(p)
            }
        }
    }

    /** MDS matrix multiplication: new_state[i] = sum(MDS[i][j] * state[j]) mod p */
    private fun mdsMultiply(state: Array<BigInteger>) {
        val result = Array(width) { BigInteger.ZERO }
        for (i in 0 until width) {
            for (j in 0 until width) {
                result[i] = (result[i] + mds[i][j] * state[j]).mod(p)
            }
        }
        for (i in 0 until width) {
            state[i] = result[i]
        }
    }
}
