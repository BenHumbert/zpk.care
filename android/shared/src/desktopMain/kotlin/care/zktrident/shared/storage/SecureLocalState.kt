package care.zktrident.shared.storage

import java.io.File
import java.util.Properties

/**
 * Desktop/JVM stub implementation of SecureLocalState.
 * Uses a plain properties file — for testing only, NOT production.
 */
actual class SecureLocalState(context: Any) {
    private val propsFile = File(System.getProperty("user.home"), ".zktrident_state.properties")
    private val props = Properties()

    init {
        if (propsFile.exists()) {
            propsFile.inputStream().use { props.load(it) }
        }
    }

    actual fun load(): LocalStateData? {
        val roleStr = props.getProperty("role") ?: return null
        val phaseStr = props.getProperty("phase") ?: return null
        return LocalStateData(
            role = care.zktrident.shared.model.EntityRole.valueOf(roleStr),
            phase = care.zktrident.shared.model.OnboardingPhase.valueOf(phaseStr),
            walletId = props.getProperty("walletId"),
            sequencerUrl = props.getProperty("sequencerUrl"),
            enrollmentTimestamp = props.getProperty("enrollmentTimestamp")?.toLongOrNull(),
        )
    }

    actual fun save(data: LocalStateData) {
        props.setProperty("role", data.role.name)
        props.setProperty("phase", data.phase.name)
        data.walletId?.let { props.setProperty("walletId", it) }
        data.sequencerUrl?.let { props.setProperty("sequencerUrl", it) }
        data.enrollmentTimestamp?.let { props.setProperty("enrollmentTimestamp", it.toString()) }
        propsFile.outputStream().use { props.store(it, "zkTrident desktop state") }
    }

    actual fun storeEnrollmentKey(key: ByteArray) {
        props.setProperty("enrollmentKey", key.joinToString("") { "%02x".format(it) })
        propsFile.outputStream().use { props.store(it, "zkTrident desktop state") }
    }

    actual fun getEnrollmentKey(): ByteArray? {
        val hex = props.getProperty("enrollmentKey") ?: return null
        return hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }

    actual fun clear() {
        props.clear()
        propsFile.delete()
    }
}
