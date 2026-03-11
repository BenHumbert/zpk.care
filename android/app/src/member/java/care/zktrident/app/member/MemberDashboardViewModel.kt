package care.zktrident.app.member

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.crypto.PoseidonHasher
import care.zktrident.shared.model.*
import care.zktrident.shared.storage.SecureLocalState
import care.zktrident.app.viewmodel.SequencerViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Member dashboard — drug history, formulary, messages, plan spend, PCP.
 */
class MemberDashboardViewModel(application: Application) : AndroidViewModel(application) {
    private var rpcClient: LeviathanRpcClient? = null
    private var walletId: String? = null
    private var planIdHash: String = "default"
    private val json = Json { ignoreUnknownKeys = true }
    private val secureState = SecureLocalState(application)

    private val _claims = MutableStateFlow<List<ClaimAccumulatorEntry>>(emptyList())
    val claims: StateFlow<List<ClaimAccumulatorEntry>> = _claims.asStateFlow()

    private val _formulary = MutableStateFlow<List<FormularyEntry>>(emptyList())
    val formulary: StateFlow<List<FormularyEntry>> = _formulary.asStateFlow()

    private val _messages = MutableStateFlow<List<MessageStoreEntry>>(emptyList())
    val messages: StateFlow<List<MessageStoreEntry>> = _messages.asStateFlow()

    private val _planSpend = MutableStateFlow<PlanSpend?>(null)
    val planSpend: StateFlow<PlanSpend?> = _planSpend.asStateFlow()

    private val _pcpAssignment = MutableStateFlow<PcpAssignment?>(null)
    val pcpAssignment: StateFlow<PcpAssignment?> = _pcpAssignment.asStateFlow()

    private val _providers = MutableStateFlow<List<NetworkProvider>>(emptyList())
    val providers: StateFlow<List<NetworkProvider>> = _providers.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun configure(sequencerVm: SequencerViewModel) {
        rpcClient = sequencerVm.getClient()
        // Load PCP from local state
        loadPcpFromLocal()
    }

    fun setWalletId(id: String) {
        walletId = id
    }

    fun refreshClaims() {
        val client = rpcClient ?: return
        val wid = walletId ?: return
        viewModelScope.launch {
            _loading.value = true
            try {
                _claims.value = client.getClaimsByMember(wid)
                _error.value = null
            } catch (e: Exception) {
                _error.value = e.message
            } finally {
                _loading.value = false
            }
        }
    }

    fun refreshProviders() {
        val client = rpcClient ?: return
        viewModelScope.launch {
            try {
                _providers.value = client.getNetworkProviders()
            } catch (e: Exception) {
                _error.value = e.message
            }
        }
    }

    fun setPlanIdHash(hash: String) { planIdHash = hash }

    fun refreshFormulary() { refreshFormulary(planIdHash) }

    fun refreshFormulary(planIdHash: String) {
        val client = rpcClient ?: return
        viewModelScope.launch {
            try {
                val response = client.getFormulary(planIdHash)
                if (response != null && response.entriesJson.isNotEmpty()) {
                    _formulary.value = json.decodeFromString(response.entriesJson)
                }
            } catch (e: Exception) {
                android.util.Log.e("MemberVM", "Formulary load failed (planIdHash=$planIdHash): ${e.message}", e)
                _error.value = "Formulary: ${e.message}"
            }
        }
    }

    fun refreshMessages() {
        val client = rpcClient ?: return
        val wid = walletId ?: return
        viewModelScope.launch {
            try {
                _messages.value = client.getMessagesByWallet(wid)
            } catch (e: Exception) {
                _error.value = e.message
            }
        }
    }

    /** Fetch accumulator totals (deductible, OOP, benefit used) from sequencer */
    fun refreshPlanSpend() {
        val client = rpcClient ?: return
        val wid = walletId ?: return
        viewModelScope.launch {
            try {
                val result = client.reconstructAccumulator(wid)
                val obj = result.jsonObject
                _planSpend.value = PlanSpend(
                    deductiblePaidCents = obj["deductiblePaidCents"]?.jsonPrimitive?.longOrNull ?: 0L,
                    oopPaidCents = obj["oopPaidCents"]?.jsonPrimitive?.longOrNull ?: 0L,
                    benefitUsedCents = obj["benefitUsedCents"]?.jsonPrimitive?.longOrNull ?: 0L,
                    claimCount = obj["claimCount"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0,
                )
            } catch (e: Exception) {
                // No claims yet = no accumulator data, which is fine
                _planSpend.value = PlanSpend(0, 0, 0, 0)
            }
        }
    }

    /**
     * Send an encrypted message to a recipient.
     * Encrypts client-side with a random AES-256-GCM key, then stores
     * the ciphertext on the sequencer. Only hashed commitments go on-chain.
     */
    fun sendMessage(
        recipientWalletId: String,
        messageText: String,
        onSuccess: () -> Unit,
        onError: (String) -> Unit,
    ) {
        val client = rpcClient ?: run { onError("Not connected"); return }
        val senderWid = walletId ?: run { onError("No wallet ID"); return }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                // Generate random AES key, IV
                val aesKey = ByteArray(32)
                val iv = ByteArray(12)
                SecureRandom().nextBytes(aesKey)
                SecureRandom().nextBytes(iv)

                // Encrypt message text
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(128, iv))
                val ciphertextWithTag = cipher.doFinal(messageText.toByteArray(Charsets.UTF_8))

                // Split ciphertext and auth tag (last 16 bytes)
                val ciphertext = ciphertextWithTag.copyOfRange(0, ciphertextWithTag.size - 16)
                val tag = ciphertextWithTag.copyOfRange(ciphertextWithTag.size - 16, ciphertextWithTag.size)

                // Compute message commitment (Poseidon hash of sender+recipient+timestamp)
                val timestamp = System.currentTimeMillis()
                val commitment = PoseidonHasher.hashStrings(listOf(senderWid, recipientWalletId, timestamp.toString()))

                // Thread ID = hash of sorted wallet pair (for conversation grouping)
                val threadPair = listOf(senderWid, recipientWalletId).sorted()
                val threadIdHash = PoseidonHasher.hashStrings(threadPair)

                client.storeMessage(
                    messageCommitment = commitment,
                    senderWalletId = senderWid,
                    recipientWalletId = recipientWalletId,
                    messageType = "text",
                    threadIdHash = threadIdHash,
                    ciphertext = ciphertext.toHexString(),
                    iv = iv.toHexString(),
                    tag = tag.toHexString(),
                )

                // Refresh messages after send
                refreshMessages()
                onSuccess()
            } catch (e: Exception) {
                onError(e.message ?: "Failed to send message")
            }
        }
    }

    private fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it) }

    /** Assign a PCP (stored locally only — no sequencer call) */
    fun assignPcp(pcpWalletId: String, effectiveDate: String) {
        val pcp = PcpAssignment(pcpWalletId = pcpWalletId, effectiveDate = effectiveDate)
        _pcpAssignment.value = pcp
        savePcpToLocal(pcp)

        // Notify the sequencer and prescriber via message store
        val wid = walletId ?: return
        sendMessage(
            recipientWalletId = pcpWalletId,
            messageText = "PCP_ASSIGN:$wid:$effectiveDate",
            onSuccess = { },
            onError = { },
        )
    }

    private fun loadPcpFromLocal() {
        try {
            val prefs = getApplication<android.app.Application>()
                .getSharedPreferences("zktrident_pcp", android.content.Context.MODE_PRIVATE)
            val pcpWalletId = prefs.getString("pcpWalletId", null)
            val effectiveDate = prefs.getString("effectiveDate", null)
            if (pcpWalletId != null && effectiveDate != null) {
                _pcpAssignment.value = PcpAssignment(pcpWalletId, effectiveDate)
            }
        } catch (_: Exception) { }
    }

    /**
     * Grant a provider access to view this member's data.
     * Stores the permission locally and sends an encrypted notification
     * to the provider via the sequencer message store.
     */
    fun grantPrescriberAccess(providerWalletId: String) {
        // Store granted access locally
        val prefs = getApplication<android.app.Application>()
            .getSharedPreferences("zktrident_access", android.content.Context.MODE_PRIVATE)
        val existing = prefs.getStringSet("grantedProviders", emptySet()) ?: emptySet()
        prefs.edit().putStringSet("grantedProviders", existing + providerWalletId).apply()

        // Send notification message to the provider
        val wid = walletId ?: return
        sendMessage(
            recipientWalletId = providerWalletId,
            messageText = "ACCESS_GRANT:$wid",
            onSuccess = { },
            onError = { },
        )
    }

    /** Check if access has been granted to a provider */
    fun hasGrantedAccess(providerWalletId: String): Boolean {
        val prefs = getApplication<android.app.Application>()
            .getSharedPreferences("zktrident_access", android.content.Context.MODE_PRIVATE)
        return (prefs.getStringSet("grantedProviders", emptySet()) ?: emptySet()).contains(providerWalletId)
    }

    private fun savePcpToLocal(pcp: PcpAssignment) {
        try {
            getApplication<android.app.Application>()
                .getSharedPreferences("zktrident_pcp", android.content.Context.MODE_PRIVATE)
                .edit()
                .putString("pcpWalletId", pcp.pcpWalletId)
                .putString("effectiveDate", pcp.effectiveDate)
                .apply()
        } catch (_: Exception) { }
    }
}

data class PlanSpend(
    val deductiblePaidCents: Long,
    val oopPaidCents: Long,
    val benefitUsedCents: Long,
    val claimCount: Int,
) {
    fun deductibleDollars(): String = "$${deductiblePaidCents / 100}.${"%02d".format(deductiblePaidCents % 100)}"
    fun oopDollars(): String = "$${oopPaidCents / 100}.${"%02d".format(oopPaidCents % 100)}"
    fun benefitDollars(): String = "$${benefitUsedCents / 100}.${"%02d".format(benefitUsedCents % 100)}"
}

data class PcpAssignment(
    val pcpWalletId: String,
    val effectiveDate: String,
)
