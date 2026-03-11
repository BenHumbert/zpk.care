package care.zktrident.shared.crypto

import java.math.BigInteger

object PoseidonHasher {
    private val P = PastaConstants.FIELD_MODULUS
    private val POWER = BigInteger.valueOf(PastaConstants.POWER.toLong())

    fun hash(input: List<BigInteger>): BigInteger {
        val state = arrayOf(BigInteger.ZERO, BigInteger.ZERO, BigInteger.ZERO)
        update(state, input)
        return state[0]
    }

    fun hash(vararg input: BigInteger): BigInteger = hash(input.toList())

    /**
     * Hash a list of strings by converting each to a Field element via
     * Poseidon.hash([char0, char1, ...]) then hashing the results.
     * Matches the TypeScript CircuitString.hash() pattern.
     */
    fun hashStrings(input: List<String>): String {
        val fields = input.map { s ->
            val chars = s.toCharArray().map { BigInteger.valueOf(it.code.toLong()) }
            if (chars.isEmpty()) BigInteger.ZERO else hash(chars)
        }
        return hash(fields).toString()
    }

    private fun update(state: Array<BigInteger>, input: List<BigInteger>) {
        if (input.isEmpty()) {
            permutation(state)
            return
        }
        // Pad to multiple of rate
        val padded = input.toMutableList()
        while (padded.size % PastaConstants.RATE != 0) {
            padded.add(BigInteger.ZERO)
        }
        // Process blocks
        for (blockStart in padded.indices step PastaConstants.RATE) {
            for (i in 0 until PastaConstants.RATE) {
                state[i] = (state[i] + padded[blockStart + i]).mod(P)
            }
            permutation(state)
        }
    }

    private fun permutation(state: Array<BigInteger>) {
        for (round in 0 until PastaConstants.FULL_ROUNDS) {
            // S-box: raise to power 7
            for (i in 0 until PastaConstants.STATE_SIZE) {
                state[i] = state[i].modPow(POWER, P)
            }
            // MDS matrix multiply + round constant addition
            val oldState = state.copyOf()
            for (i in 0 until PastaConstants.STATE_SIZE) {
                var sum = BigInteger.ZERO
                for (j in 0 until PastaConstants.STATE_SIZE) {
                    sum = (sum + PastaConstants.MDS[i][j] * oldState[j]).mod(P)
                }
                state[i] = (sum + PastaConstants.ROUND_CONSTANTS[round][i]).mod(P)
            }
        }
    }
}
