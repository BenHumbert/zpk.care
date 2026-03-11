package care.zktrident.app.member

import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.storage.SecureLocalState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Recovery card data written to NFC tag.
 * Compatible format with TypeScript RecoveryCard v2.
 */
@Serializable
data class RecoveryCardData(
    val version: Int = 2,
    val walletId: String,
    val domainTag: Int = 0,
    val salt: String,
    val iv: String,
    val encryptedKey: String,
    val kdf: String = "pbkdf2",
    val createdAt: Long,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberNfcWriteScreen(
    nfcTagFlow: SharedFlow<Tag>,
    rpcClient: LeviathanRpcClient? = null,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var pinConfirm by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Enter a 6+ digit PIN to encrypt your backup") }
    var isWriting by remember { mutableStateOf(false) }
    var writeSuccess by remember { mutableStateOf(false) }
    var recoveryJson by remember { mutableStateOf<String?>(null) }
    var attestationJson by remember { mutableStateOf<String?>(null) }
    var attestationStatus by remember { mutableStateOf("") }

    // Listen for NFC tags
    LaunchedEffect(Unit) {
        nfcTagFlow.collect { tag ->
            val recovery = recoveryJson ?: return@collect
            isWriting = true
            status = "Writing to NFC tag..."
            try {
                val written = withContext(Dispatchers.IO) {
                    writeDualNdefToTag(tag, recovery, attestationJson)
                }
                if (written) {
                    writeSuccess = true
                    status = if (attestationJson != null) {
                        "Recovery card + attestation written!"
                    } else {
                        "Recovery card written (no attestation available)"
                    }
                } else {
                    status = "Failed to write — tag may be read-only or too small"
                }
            } catch (e: Exception) {
                status = "Write error: ${e.message}"
            }
            isWriting = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Write Recovery Card") },
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
            if (writeSuccess) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Column(modifier = Modifier.padding(24.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Backup Complete", style = MaterialTheme.typography.headlineSmall)
                        Spacer(Modifier.height(8.dp))
                        Text("Your recovery card has been written. Store it in a safe place.", style = MaterialTheme.typography.bodyMedium)
                        Text("You will need this card + your PIN to restore your wallet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (attestationJson != null) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "Ed25519 attestation included — pharmacies can verify offline.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            } else if (recoveryJson != null) {
                // Card is prepared, waiting for NFC tap
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                    Column(modifier = Modifier.padding(24.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        if (isWriting) {
                            CircularProgressIndicator()
                            Spacer(Modifier.height(8.dp))
                        }
                        Text("Hold NFC card to back of device", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
                        Spacer(Modifier.height(4.dp))
                        Text("NTAG216 recommended (888 bytes)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (attestationJson != null) {
                            Text(
                                "Will write: recovery + attestation (dual record)",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        } else if (attestationStatus.isNotEmpty()) {
                            Text(attestationStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            } else {
                // PIN entry
                Text("Create Recovery Card", style = MaterialTheme.typography.titleLarge)
                Text(
                    "This encrypts your enrollment key with a PIN and writes it to an NFC tag, " +
                        "along with a sequencer-signed attestation for offline pharmacy verification. " +
                        "The tag contains NO personal information.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                OutlinedTextField(
                    value = pin,
                    onValueChange = { pin = it },
                    label = { Text("PIN (6+ characters)") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                OutlinedTextField(
                    value = pinConfirm,
                    onValueChange = { pinConfirm = it },
                    label = { Text("Confirm PIN") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                val canPrepare = pin.length >= 6 && pin == pinConfirm
                Button(
                    onClick = {
                        scope.launch {
                            status = "Encrypting enrollment key..."
                            try {
                                val recovery = withContext(Dispatchers.Default) {
                                    prepareRecoveryCard(context as android.content.Context, pin)
                                }
                                if (recovery == null) {
                                    status = "No enrollment key found — complete enrollment first"
                                    return@launch
                                }
                                recoveryJson = recovery

                                // Fetch attestation from sequencer (best-effort)
                                val client = rpcClient
                                if (client != null) {
                                    val state = SecureLocalState(context).load()
                                    val wid = state?.walletId
                                    if (wid != null) {
                                        status = "Requesting attestation from sequencer..."
                                        try {
                                            val att = withContext(Dispatchers.IO) {
                                                client.requestAttestation(wid)
                                            }
                                            attestationJson = att.toString()
                                            attestationStatus = "Attestation received (Ed25519 signed)"
                                        } catch (e: Exception) {
                                            attestationStatus = "Attestation unavailable: ${e.message}"
                                        }
                                    }
                                } else {
                                    attestationStatus = "No sequencer connection — recovery only"
                                }

                                status = "Tap NFC tag to write"
                            } catch (e: Exception) {
                                status = "Error: ${e.message}"
                            }
                        }
                    },
                    enabled = canPrepare,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Prepare Card")
                }

                if (pin.isNotEmpty() && pin.length < 6) {
                    Text("PIN must be at least 6 characters", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (pinConfirm.isNotEmpty() && pin != pinConfirm) {
                    Text("PINs do not match", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }

                Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * Encrypt enrollment key with PIN-derived key and build recovery card JSON.
 * Uses PBKDF2WithHmacSHA256 (600K iterations) + AES-256-GCM.
 */
private fun prepareRecoveryCard(context: android.content.Context, pin: String): String? {
    val secureState = SecureLocalState(context)
    val enrollmentKey = secureState.getEnrollmentKey() ?: return null
    val stateData = secureState.load() ?: return null
    val walletId = stateData.walletId ?: return null

    // Generate salt and IV
    val salt = ByteArray(16)
    val iv = ByteArray(12)
    SecureRandom().nextBytes(salt)
    SecureRandom().nextBytes(iv)

    // Derive key from PIN via PBKDF2
    val keySpec = PBEKeySpec(pin.toCharArray(), salt, 600_000, 256)
    val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
    val derivedKey = factory.generateSecret(keySpec).encoded
    val secretKey = SecretKeySpec(derivedKey, "AES")

    // Encrypt enrollment key with AES-256-GCM
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
    val encrypted = cipher.doFinal(enrollmentKey)

    val card = RecoveryCardData(
        walletId = walletId,
        salt = salt.toHexString(),
        iv = iv.toHexString(),
        encryptedKey = encrypted.toHexString(),
        createdAt = System.currentTimeMillis(),
    )

    return Json.encodeToString(card)
}

/**
 * Write dual NDEF records to tag:
 * 1. zktrident.care:recovery — encrypted enrollment key (for backup/restore)
 * 2. zktrident.care:attestation — Ed25519 signed credential (for offline verification)
 *
 * Both fit within NTAG216's 888 bytes (~400 + ~500 = ~900, tight but feasible with
 * compact JSON; if too large, attestation is omitted gracefully).
 */
private fun writeDualNdefToTag(tag: Tag, recoveryJson: String, attestationJson: String?): Boolean {
    val recoveryPayload = recoveryJson.toByteArray(Charsets.UTF_8)
    val recoveryRecord = NdefRecord(
        NdefRecord.TNF_EXTERNAL_TYPE,
        "zktrident.care:recovery".toByteArray(Charsets.US_ASCII),
        ByteArray(0),
        recoveryPayload,
    )

    val records = mutableListOf(recoveryRecord)

    if (attestationJson != null) {
        val attestationPayload = attestationJson.toByteArray(Charsets.UTF_8)
        val attestationRecord = NdefRecord(
            NdefRecord.TNF_EXTERNAL_TYPE,
            "zktrident.care:attestation".toByteArray(Charsets.US_ASCII),
            ByteArray(0),
            attestationPayload,
        )
        records.add(attestationRecord)
    }

    val message = NdefMessage(records.toTypedArray())

    // Try Ndef first (already formatted)
    val ndef = Ndef.get(tag)
    if (ndef != null) {
        ndef.connect()
        try {
            if (!ndef.isWritable) return false
            val msgBytes = message.toByteArray()
            if (ndef.maxSize < msgBytes.size) {
                // Too large for dual records — try recovery only
                if (attestationJson != null) {
                    val recoveryOnly = NdefMessage(arrayOf(recoveryRecord))
                    if (ndef.maxSize >= recoveryOnly.toByteArray().size) {
                        ndef.writeNdefMessage(recoveryOnly)
                        return true
                    }
                }
                return false
            }
            ndef.writeNdefMessage(message)
            return true
        } finally {
            ndef.close()
        }
    }

    // Try formatting
    val formatable = NdefFormatable.get(tag) ?: return false
    formatable.connect()
    try {
        formatable.format(message)
        return true
    } finally {
        formatable.close()
    }
}

private fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it) }
