package care.zktrident.app.insurer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.model.*
import care.zktrident.app.viewmodel.SequencerViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

class InsurerDashboardViewModel : ViewModel() {
    private var rpcClient: LeviathanRpcClient? = null

    private val _chainState = MutableStateFlow<L2ChainState?>(null)
    val chainState: StateFlow<L2ChainState?> = _chainState.asStateFlow()

    private val _batches = MutableStateFlow<List<L2Batch>>(emptyList())
    val batches: StateFlow<List<L2Batch>> = _batches.asStateFlow()

    private val _quorumStatus = MutableStateFlow<JsonElement?>(null)
    val quorumStatus: StateFlow<JsonElement?> = _quorumStatus.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun configure(sequencerVm: SequencerViewModel) { rpcClient = sequencerVm.getClient() }

    fun refreshDashboard() {
        val client = rpcClient ?: return
        viewModelScope.launch {
            _loading.value = true
            try {
                _chainState.value = client.getChainState()
                _batches.value = client.getBatchHistory(20)
                try { _quorumStatus.value = client.getQuorumStatus() } catch (_: Exception) { }
                _error.value = null
            } catch (e: Exception) { _error.value = e.message }
            finally { _loading.value = false }
        }
    }
}
