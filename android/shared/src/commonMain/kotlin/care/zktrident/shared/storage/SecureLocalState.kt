package care.zktrident.shared.storage

import care.zktrident.shared.model.EntityRole
import care.zktrident.shared.model.OnboardingPhase

/**
 * Secure local state interface — expect/actual for platform-specific implementations.
 *
 * On Android: backed by Android Keystore + EncryptedSharedPreferences.
 * Stores enrollment key, wallet ID, onboarding phase, and sequencer URL.
 * Enrollment key NEVER leaves the device.
 */
data class LocalStateData(
    val role: EntityRole,
    val phase: OnboardingPhase,
    val walletId: String? = null,
    val sequencerUrl: String? = null,
    val enrollmentTimestamp: Long? = null,
) {
    override fun toString(): String =
        "LocalStateData(role=$role, phase=$phase, walletId=${walletId?.take(8)}..., sequencerUrl=$sequencerUrl)"
}

expect class SecureLocalState(context: Any) {
    /** Load saved state, or null if none exists */
    fun load(): LocalStateData?

    /** Save state to encrypted storage */
    fun save(data: LocalStateData)

    /** Store the enrollment key bytes (hardware-backed on Android) */
    fun storeEnrollmentKey(key: ByteArray)

    /** Retrieve the enrollment key bytes */
    fun getEnrollmentKey(): ByteArray?

    /** Wipe all stored data (factory reset) */
    fun clear()
}
