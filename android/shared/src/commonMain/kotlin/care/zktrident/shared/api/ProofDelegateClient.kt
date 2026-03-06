package care.zktrident.shared.api

import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/**
 * Client for the ProofDelegateServer (src/nodes/proof-delegate.ts).
 *
 * The ProofDelegateServer compiles StateTransitionProgram once and serves
 * ZK proof generation over HTTPS. Only hashed Fields are sent — no PHI.
 *
 * Endpoints:
 *   POST /prove   — generate a StateTransitionProof
 *   GET  /status  — check compilation status
 */
class ProofDelegateClient(
    private val baseUrl: String,
    private val apiKey: String? = null,
    private val client: HttpClient = HttpClient { expectSuccess = false },
) {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Check if the prover is ready (StateTransitionProgram compiled).
     */
    suspend fun getStatus(): ProverStatus {
        val response = client.get("$baseUrl/status") {
            apiKey?.let { header("X-API-Key", it) }
        }
        val body = response.bodyAsText()
        return json.decodeFromString(body)
    }

    /**
     * Request a ZK proof from the delegate server.
     *
     * @param method "proveRegistration" or "proveWalletUpdate"
     * @param params Named parameters (preimage, witness JSONs, roots — all as decimal strings)
     * @return The proof JSON string (to be submitted to leviathan)
     */
    suspend fun prove(
        method: String,
        params: Map<String, Any>,
    ): ProveResult {
        val body = buildJsonObject {
            put("method", method)
            put("params", buildJsonObject {
                params.forEach { (k, v) ->
                    when (v) {
                        is String -> put(k, v)
                        is List<*> -> put(k, buildJsonArray { v.forEach { add(it.toString()) } })
                        else -> put(k, v.toString())
                    }
                }
            })
        }

        val response = client.post("$baseUrl/prove") {
            contentType(ContentType.Application.Json)
            apiKey?.let { header("X-API-Key", it) }
            setBody(body.toString())
        }

        val responseText = response.bodyAsText()
        val responseJson = json.parseToJsonElement(responseText).jsonObject

        val success = responseJson["success"]?.jsonPrimitive?.booleanOrNull ?: false
        if (!success) {
            val error = responseJson["error"]?.jsonPrimitive?.contentOrNull ?: "Proof generation failed"
            return ProveResult(success = false, error = error)
        }

        val proofJson = responseJson["proofJson"]?.jsonPrimitive?.contentOrNull
            ?: return ProveResult(success = false, error = "No proof in response")
        val proofTimeMs = responseJson["proofTimeMs"]?.jsonPrimitive?.longOrNull

        return ProveResult(success = true, proofJson = proofJson, proofTimeMs = proofTimeMs)
    }

    fun close() {
        client.close()
    }
}

@Serializable
data class ProverStatus(
    val available: Boolean = false,
    val compiled: Boolean = false,
    val queueDepth: Int = 0,
    val avgProofTimeMs: Long = 0,
)

data class ProveResult(
    val success: Boolean,
    val proofJson: String? = null,
    val error: String? = null,
    val proofTimeMs: Long? = null,
)
