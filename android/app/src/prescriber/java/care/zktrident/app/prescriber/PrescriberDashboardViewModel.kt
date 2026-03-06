package care.zktrident.app.prescriber

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.model.*
import care.zktrident.app.viewmodel.SequencerViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

class PrescriberDashboardViewModel : ViewModel() {
    private var rpcClient: LeviathanRpcClient? = null
    private var walletId: String? = null

    private val _claims = MutableStateFlow<List<ClaimAccumulatorEntry>>(emptyList())
    val claims: StateFlow<List<ClaimAccumulatorEntry>> = _claims.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun configure(sequencerVm: SequencerViewModel) { rpcClient = sequencerVm.getClient() }
    fun setWalletId(id: String) { walletId = id }

    fun refreshClaims() {
        val client = rpcClient ?: return
        val wid = walletId ?: return
        viewModelScope.launch {
            _loading.value = true
            try {
                _claims.value = client.getClaimsByPrescriber(wid)
                _error.value = null
            } catch (e: Exception) { _error.value = e.message }
            finally { _loading.value = false }
        }
    }

    val uniquePatients: Int get() = _claims.value.map { it.leaf.memberWalletId }.distinct().size
    val uniquePharmacies: Int get() = _claims.value.map { it.leaf.pharmacyWalletId }.distinct().size
    val uniqueMedications: Int get() = _claims.value.map { it.leaf.ndcHash }.distinct().size
}
