package care.zktrident.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.SseClient
import care.zktrident.shared.api.SseEvent
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * ViewModel for SSE event streaming from the leviathan sequencer.
 *
 * Maintains a connection to the /events endpoint and exposes
 * real-time events (batch:built, proof:accepted, etc.) as StateFlow.
 */
class SseViewModel : ViewModel() {
    private var sseClient: SseClient? = null

    private val _events = MutableSharedFlow<SseEvent>(replay = 0, extraBufferCapacity = 100)
    val events: SharedFlow<SseEvent> = _events.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _lastEvent = MutableStateFlow<SseEvent?>(null)
    val lastEvent: StateFlow<SseEvent?> = _lastEvent.asStateFlow()

    fun connect(sequencerUrl: String) {
        if (sseClient != null) return

        val client = SseClient(sequencerUrl)
        sseClient = client

        viewModelScope.launch {
            _connected.value = true
            client.events().collect { event ->
                _lastEvent.value = event
                _events.emit(event)
            }
            _connected.value = false
        }
    }

    fun disconnect() {
        sseClient?.close()
        sseClient = null
        _connected.value = false
    }

    override fun onCleared() {
        disconnect()
        super.onCleared()
    }
}
