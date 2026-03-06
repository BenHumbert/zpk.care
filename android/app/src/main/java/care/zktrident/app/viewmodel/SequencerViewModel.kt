package care.zktrident.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.model.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * Shared ViewModel for sequencer interactions.
 * All 5 flavors use this for chain state, status, and common queries.
 */
class SequencerViewModel : ViewModel() {
    private var rpcClient: LeviathanRpcClient? = null

    private val _status = MutableStateFlow<L2NodeStatus?>(null)
    val status: StateFlow<L2NodeStatus?> = _status.asStateFlow()

    private val _chainState = MutableStateFlow<L2ChainState?>(null)
    val chainState: StateFlow<L2ChainState?> = _chainState.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    fun configure(sequencerUrl: String) {
        rpcClient?.close()
        rpcClient = LeviathanRpcClient(sequencerUrl)
    }

    fun refreshStatus() {
        val client = rpcClient ?: return
        viewModelScope.launch {
            _loading.value = true
            try {
                _status.value = client.getStatus()
                _chainState.value = client.getChainState()
                _error.value = null
            } catch (e: Exception) {
                _error.value = e.message
            } finally {
                _loading.value = false
            }
        }
    }

    fun getClient(): LeviathanRpcClient? = rpcClient

    override fun onCleared() {
        rpcClient?.close()
        super.onCleared()
    }
}
