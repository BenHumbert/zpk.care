package care.zktrident.app.member

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.model.*
import care.zktrident.shared.storage.SecureLocalState
import care.zktrident.app.viewmodel.SequencerViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

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

    /** Assign a PCP (stored locally only — no sequencer call) */
    fun assignPcp(pcpWalletId: String, effectiveDate: String) {
        val pcp = PcpAssignment(pcpWalletId = pcpWalletId, effectiveDate = effectiveDate)
        _pcpAssignment.value = pcp
        savePcpToLocal(pcp)
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
