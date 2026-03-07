package care.zktrident.shared.storage

import care.zktrident.shared.model.EntityRole
import care.zktrident.shared.model.OnboardingPhase
import kotlinx.serialization.Serializable

/**
 * Local state persisted on device. Contains NO PHI/PII — only hashed identifiers.
 * Kotlin equivalent of NautilusLocalState in TypeScript.
 */
@Serializable
data class LocalStateData(
    val role: EntityRole,
    val phase: OnboardingPhase = OnboardingPhase.awaiting_token,
    val walletId: String? = null,
    val sequencerUrl: String? = null,
    val enrollmentTimestamp: Long? = null,
)

/**
 * Secure local state persistence.
 * On Android: uses Android Keystore + EncryptedSharedPreferences.
 * On Desktop/JVM: file-based (for testing only).
 */
expect class SecureLocalState(context: Any) {
    fun load(): LocalStateData?
    fun save(data: LocalStateData)
    fun storeEnrollmentKey(key: ByteArray)
    fun getEnrollmentKey(): ByteArray?
    fun clear()
}
