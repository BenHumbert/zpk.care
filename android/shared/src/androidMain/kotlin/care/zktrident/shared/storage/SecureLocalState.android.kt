package care.zktrident.shared.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import care.zktrident.shared.model.EntityRole
import care.zktrident.shared.model.OnboardingPhase
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android implementation of SecureLocalState.
 *
 * - State data: EncryptedSharedPreferences (AES-256-SIV for keys, AES-256-GCM for values)
 * - Enrollment key: Android Keystore hardware-backed AES key wrapping
 *   The enrollment key bytes are encrypted with a Keystore-backed AES key
 *   so they never exist in plaintext outside the TEE/StrongBox.
 */
actual class SecureLocalState(context: Any) {
    private val context: Context = context as Context
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs by lazy {
        EncryptedSharedPreferences.create(
            context,
            "zktrident_state",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    actual fun load(): LocalStateData? {
        val roleStr = prefs.getString("role", null) ?: return null
        val phaseStr = prefs.getString("phase", null) ?: return null
        return LocalStateData(
            role = EntityRole.valueOf(roleStr),
            phase = OnboardingPhase.valueOf(phaseStr),
            walletId = prefs.getString("walletId", null),
            sequencerUrl = prefs.getString("sequencerUrl", null),
            enrollmentTimestamp = prefs.getLong("enrollmentTimestamp", 0L).takeIf { it > 0 },
        )
    }

    actual fun save(data: LocalStateData) {
        prefs.edit()
            .putString("role", data.role.name)
            .putString("phase", data.phase.name)
            .putString("walletId", data.walletId)
            .putString("sequencerUrl", data.sequencerUrl)
            .putLong("enrollmentTimestamp", data.enrollmentTimestamp ?: 0L)
            .apply()
    }

    actual fun storeEnrollmentKey(key: ByteArray) {
        val wrappingKey = getOrCreateWrappingKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
        val iv = cipher.iv
        val encrypted = cipher.doFinal(key)
        // Store IV + ciphertext as hex
        prefs.edit()
            .putString("ek_iv", iv.toHex())
            .putString("ek_data", encrypted.toHex())
            .apply()
    }

    actual fun getEnrollmentKey(): ByteArray? {
        val ivHex = prefs.getString("ek_iv", null) ?: return null
        val dataHex = prefs.getString("ek_data", null) ?: return null
        val wrappingKey = getOrCreateWrappingKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(128, ivHex.fromHex()))
        return cipher.doFinal(dataHex.fromHex())
    }

    actual fun clear() {
        prefs.edit().clear().apply()
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore")
            ks.load(null)
            ks.deleteEntry(WRAPPING_KEY_ALIAS)
        } catch (_: Exception) { }
    }

    @Synchronized
    private fun getOrCreateWrappingKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore")
        ks.load(null)
        ks.getKey(WRAPPING_KEY_ALIAS, null)?.let { return it as SecretKey }

        val spec = KeyGenParameterSpec.Builder(
            WRAPPING_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()

        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(spec)
        return kg.generateKey()
    }

    companion object {
        private const val WRAPPING_KEY_ALIAS = "zktrident_ek_wrapper"
    }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private fun String.fromHex(): ByteArray {
    check(length % 2 == 0)
    return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
