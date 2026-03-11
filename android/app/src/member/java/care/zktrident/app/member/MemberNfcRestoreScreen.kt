package care.zktrident.app.member

import android.nfc.NdefMessage
import android.nfc.Tag
import android.nfc.tech.Ndef
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import care.zktrident.shared.model.EntityRole
import care.zktrident.shared.model.OnboardingPhase
import care.zktrident.shared.storage.LocalStateData
import care.zktrident.shared.storage.SecureLocalState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * NFC Restore screen — reads recovery card from NFC tag, decrypts with PIN,
 * restores enrollment key + wallet ID to SecureLocalState.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberNfcRestoreScreen(
    nfcTagFlow: SharedFlow<Tag>,
    sequencerUrl: String,
    onRestoreComplete: (walletId: String) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var cardData by remember { mutableStateOf<RecoveryCardData?>(null) }
    var pin by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Hold NFC recovery card to back of device") }
    var isProcessing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Listen for NFC tags
    LaunchedEffect(Unit) {
        nfcTagFlow.collect { tag ->
            if (cardData != null) return@collect // Already read
            isProcessing = true
            status = "Reading NFC tag..."
            error = null
            try {
                val card = withContext(Dispatchers.IO) { readRecoveryCardFromTag(tag) }
                if (card != null) {
                    cardData = card
                    status = "Card read — wallet ${card.walletId.take(12)}... Enter PIN to decrypt"
                } else {
                    error = "No recovery card found on this tag"
                    status = "Try again with your recovery card"
                }
            } catch (e: Exception) {
                error = "Read error: ${e.message}"
            }
            isProcessing = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Restore from Backup") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (cardData == null) {
                // Step 1: Tap NFC card
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                    Column(
                        modifier = Modifier.padding(24.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (isProcessing) {
                            CircularProgressIndicator()
                            Spacer(Modifier.height(8.dp))
                        }
                        Text("Tap Recovery Card", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
                    }
                }
                if (error != null) {
                    Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            } else {
                // Step 2: Enter PIN to decrypt
                Text("Recovery Card Detected", style = MaterialTheme.typography.titleLarge)
                Text(
                    "Wallet: ${cardData!!.walletId.take(20)}...",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "Created: ${java.text.SimpleDateFormat("MMM dd, yyyy", java.util.Locale.US).format(java.util.Date(cardData!!.createdAt))}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                OutlinedTextField(
                    value = pin,
                    onValueChange = { pin = it },
                    label = { Text("Enter PIN") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    isError = error != null,
                )

                if (error != null) {
                    Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }

                Button(
                    onClick = {
                        scope.launch {
                            isProcessing = true
                            error = null
                            status = "Decrypting enrollment key..."
                            try {
                                val enrollmentKey = withContext(Dispatchers.Default) {
                                    decryptRecoveryCard(cardData!!, pin)
                                }
                                if (enrollmentKey != null) {
                                    // Restore to SecureLocalState
                                    val secureState = SecureLocalState(context)
                                    secureState.storeEnrollmentKey(enrollmentKey)
                                    secureState.save(
                                        LocalStateData(
                                            role = EntityRole.member,
                                            phase = OnboardingPhase.ready,
                                            walletId = cardData!!.walletId,
                                            sequencerUrl = sequencerUrl,
                                            enrollmentTimestamp = System.currentTimeMillis(),
                                        ),
                                    )
                                    onRestoreComplete(cardData!!.walletId)
                                } else {
                                    error = "Decryption failed — wrong PIN?"
                                }
                            } catch (e: Exception) {
                                error = "Decrypt error: ${e.message}"
                            }
                            isProcessing = false
                        }
                    },
                    enabled = pin.length >= 6 && !isProcessing,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (isProcessing) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text("Decrypt & Restore")
                }

                TextButton(
                    onClick = { cardData = null; pin = ""; error = null; status = "Hold NFC recovery card to back of device" },
                ) {
                    Text("Scan a different card")
                }
            }
        }
    }
}

/**
 * Read RecoveryCardData from NDEF external type record on NFC tag.
 */
private fun readRecoveryCardFromTag(tag: Tag): RecoveryCardData? {
    val ndef = Ndef.get(tag) ?: return null
    ndef.connect()
    try {
        val message: NdefMessage = ndef.ndefMessage ?: return null
        for (record in message.records) {
            val type = String(record.type, Charsets.US_ASCII)
            if (type == "zktrident.care:recovery") {
                val json = String(record.payload, Charsets.UTF_8)
                return Json { ignoreUnknownKeys = true }.decodeFromString<RecoveryCardData>(json)
            }
        }
        return null
    } finally {
        ndef.close()
    }
}

/**
 * Decrypt enrollment key from recovery card using PIN.
 * PBKDF2WithHmacSHA256 (600K iterations) + AES-256-GCM.
 */
private fun decryptRecoveryCard(card: RecoveryCardData, pin: String): ByteArray? {
    return try {
        val salt = card.salt.hexToByteArray()
        val iv = card.iv.hexToByteArray()
        val encrypted = card.encryptedKey.hexToByteArray()

        // Derive key from PIN
        val keySpec = PBEKeySpec(pin.toCharArray(), salt, 600_000, 256)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val derivedKey = factory.generateSecret(keySpec).encoded
        val secretKey = SecretKeySpec(derivedKey, "AES")

        // Decrypt
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
        cipher.doFinal(encrypted)
    } catch (_: Exception) {
        null
    }
}

private fun String.hexToByteArray(): ByteArray {
    check(length % 2 == 0)
    return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
