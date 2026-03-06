package care.zktrident.shared.api

import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.utils.io.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

/**
 * Server-Sent Events (SSE) client for leviathan real-time updates.
 *
 * Connects to the /events SSE endpoint on the leviathan sequencer
 * and emits events as a Kotlin Flow.
 *
 * Auto-reconnects on disconnection with exponential backoff.
 */
class SseClient(
    private val baseUrl: String,
    private val client: HttpClient = HttpClient { expectSuccess = false },
) {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Connect to the SSE endpoint and emit events as a Flow.
     * Automatically reconnects on failure with backoff.
     */
    fun events(): Flow<SseEvent> = flow {
        var backoff = 1000L
        while (currentCoroutineContext().isActive) {
            try {
                client.prepareGet("$baseUrl/events") {
                    header("Accept", "text/event-stream")
                    header("Cache-Control", "no-cache")
                }.execute { response ->
                    backoff = 1000L // Reset backoff on successful connection
                    val channel = response.bodyAsChannel()
                    var eventType = ""
                    var data = StringBuilder()

                    while (!channel.isClosedForRead) {
                        val line = channel.readUTF8Line() ?: break
                        when {
                            line.startsWith("event:") -> {
                                eventType = line.removePrefix("event:").trim()
                            }
                            line.startsWith("data:") -> {
                                data.append(line.removePrefix("data:").trim())
                            }
                            line.isEmpty() && data.isNotEmpty() -> {
                                // End of event — emit
                                val payload = try {
                                    json.parseToJsonElement(data.toString())
                                } catch (_: Exception) {
                                    JsonPrimitive(data.toString())
                                }
                                emit(SseEvent(eventType.ifEmpty { "message" }, payload))
                                eventType = ""
                                data = StringBuilder()
                            }
                        }
                    }
                }
            } catch (_: CancellationException) {
                break
            } catch (_: Exception) {
                // Reconnect with backoff
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(30_000L)
            }
        }
    }.flowOn(Dispatchers.IO)

    fun close() {
        client.close()
    }
}

data class SseEvent(
    val type: String,
    val data: JsonElement,
)
