package care.zktrident.app.member

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.model.*
import care.zktrident.app.viewmodel.SequencerViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/**
 * Member dashboard — drug history, formulary, messages, activity summary.
 * Uses ClaimAccumulatorEntry (nested leaf+metadata) and MessageStoreEntry (nested message+payload)
 * matching the actual RPC wire format.
 */
class MemberDashboardViewModel : ViewModel() {
    private var rpcClient: LeviathanRpcClient? = null
    private var walletId: String? = null
    private var planIdHash: String = "default"
    private val json = Json { ignoreUnknownKeys = true }

    private val _claims = MutableStateFlow<List<ClaimAccumulatorEntry>>(emptyList())
    val claims: StateFlow<List<ClaimAccumulatorEntry>> = _claims.asStateFlow()

    private val _formulary = MutableStateFlow<List<FormularyEntry>>(emptyList())
    val formulary: StateFlow<List<FormularyEntry>> = _formulary.asStateFlow()

    private val _messages = MutableStateFlow<List<MessageStoreEntry>>(emptyList())
    val messages: StateFlow<List<MessageStoreEntry>> = _messages.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun configure(sequencerVm: SequencerViewModel) {
        rpcClient = sequencerVm.getClient()
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
                _error.value = e.message
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
}
