package care.zktrident.shared.api

import care.zktrident.shared.crypto.BigIntJson
import care.zktrident.shared.model.*
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.json.*
import java.util.concurrent.atomic.AtomicInteger

/**
 * JSON-RPC 2.0 client for the Leviathan sequencer.
 *
 * Mirrors the TypeScript L2Client from src/l2/l2-client.ts.
 * All methods map to l2_* RPC method names on the sequencer.
 * POSTs to baseUrl/rpc with named parameters (buildJsonObject).
 */
class LeviathanRpcClient(
    private val baseUrl: String,
    private val client: HttpClient = defaultHttpClient(),
) {
    private val requestId = AtomicInteger(1)
    @PublishedApi internal val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    // ─── Core RPC Call ──────────────────────────────────────────

    suspend fun rpcCall(method: String, params: JsonElement? = null): JsonElement {
        val id = requestId.getAndIncrement()
        val body = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            if (params != null) put("params", params)
        }

        val response = client.post("$baseUrl/rpc") {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }

        if (!response.status.isSuccess()) {
            throw RpcException(response.status.value, "HTTP ${response.status.value}: ${response.status.description}")
        }

        val responseText = response.bodyAsText()
        val responseJson = json.parseToJsonElement(responseText).jsonObject

        val error = responseJson["error"]
        if (error != null && error !is JsonNull) {
            val errorObj = error.jsonObject
            val code = errorObj["code"]?.jsonPrimitive?.intOrNull ?: -1
            val message = errorObj["message"]?.jsonPrimitive?.contentOrNull ?: "Unknown RPC error"
            throw RpcException(code, message)
        }

        return BigIntJson.unwrapAll(
            responseJson["result"] ?: throw RpcException(-1, "No result in response")
        )
    }

    /** Typed RPC call with automatic deserialization */
    suspend inline fun <reified T> rpc(method: String, params: JsonElement? = null): T {
        val result = rpcCall(method, params)
        return json.decodeFromJsonElement(result)
    }

    // ─── Status & Health ────────────────────────────────────────

    suspend fun getStatus(): L2NodeStatus = rpc("l2_getStatus")

    suspend fun getChainState(): L2ChainState = rpc("l2_getChainState")

    // ─── Receipts ───────────────────────────────────────────────

    suspend fun getReceipt(receiptId: String): L2Receipt = rpc(
        "l2_getReceipt",
        buildJsonObject { put("receiptId", receiptId) },
    )

    suspend fun getReceiptsByWallet(walletId: String): List<L2Receipt> = rpc(
        "l2_getReceiptsByWallet",
        buildJsonObject { put("walletId", walletId) },
    )

    suspend fun getAllReceipts(limit: Int = 1000, offset: Int = 0): List<L2Receipt> = rpc(
        "l2_getAllReceipts",
        buildJsonObject { put("limit", limit); put("offset", offset) },
    )

    // ─── Batches ────────────────────────────────────────────────

    suspend fun getBatch(batchNumber: String): L2Batch = rpc(
        "l2_getBatch",
        buildJsonObject { put("batchNumber", batchNumber) },
    )

    suspend fun getAllBatches(limit: Int = 1000, offset: Int = 0): List<L2Batch> = rpc(
        "l2_getAllBatches",
        buildJsonObject { put("limit", limit); put("offset", offset) },
    )

    // ─── Claims ─────────────────────────────────────────────────

    suspend fun getClaimsByMember(walletId: String): List<ClaimAccumulatorEntry> = rpc(
        "l2_getClaimsByMember",
        buildJsonObject { put("walletId", walletId) },
    )

    suspend fun getClaimsByPharmacy(walletId: String): List<ClaimAccumulatorEntry> = rpc(
        "l2_getClaimsByPharmacy",
        buildJsonObject { put("walletId", walletId) },
    )

    suspend fun getClaimsByPrescriber(walletId: String): List<ClaimAccumulatorEntry> = rpc(
        "l2_getClaimsByPrescriber",
        buildJsonObject { put("walletId", walletId) },
    )

    suspend fun getClaimsByNdc(ndcHash: String): List<ClaimAccumulatorEntry> = rpc(
        "l2_getClaimsByNdc",
        buildJsonObject { put("ndcHash", ndcHash) },
    )

    // ─── Formulary ──────────────────────────────────────────────

    suspend fun getFormulary(planIdHash: String): FormularyResponse? = rpc(
        "l2_getFormulary",
        buildJsonObject { put("planIdHash", planIdHash) },
    )

    // ─── Network Providers ─────────────────────────────────────

    suspend fun getNetworkProviders(role: String? = null): List<NetworkProvider> = rpc(
        "l2_getNetworkProviders",
        buildJsonObject { if (role != null) put("role", role) },
    )

    // ─── Messages ───────────────────────────────────────────────

    suspend fun getMessagesByWallet(walletId: String): List<MessageStoreEntry> = rpc(
        "l2_getMessagesByWallet",
        buildJsonObject { put("walletId", walletId) },
    )

    suspend fun getMessagesByThread(threadIdHash: String): List<MessageStoreEntry> = rpc(
        "l2_getMessagesByThread",
        buildJsonObject { put("threadIdHash", threadIdHash) },
    )

    /**
     * Store an encrypted message on the sequencer.
     * The sequencer only stores opaque ciphertext — no plaintext ever touches it.
     */
    suspend fun storeMessage(
        messageCommitment: String,
        senderWalletId: String,
        recipientWalletId: String,
        messageType: String,
        threadIdHash: String,
        ciphertext: String,
        iv: String,
        tag: String,
    ): JsonElement = rpcCall(
        "l2_storeMessage",
        buildJsonObject {
            putJsonObject("message") {
                put("messageCommitment", messageCommitment)
                put("senderWalletId", senderWalletId)
                put("recipientWalletId", recipientWalletId)
                put("messageType", messageType)
                put("threadIdHash", threadIdHash)
            }
            putJsonObject("payload") {
                put("ciphertext", ciphertext)
                put("iv", iv)
                put("tag", tag)
                put("timestamp", System.currentTimeMillis())
            }
        },
    )

    // ─── NFC Attestation ──────────────────────────────────────

    /**
     * Request a sequencer-signed NFC credential attestation (~500 bytes).
     * The attestation proves registration via Ed25519 signature — fits on NTAG216.
     */
    suspend fun requestAttestation(walletId: String, expirySeconds: Int? = null): JsonElement = rpcCall(
        "l2_requestAttestation",
        buildJsonObject {
            put("walletId", walletId)
            if (expirySeconds != null) put("expirySeconds", expirySeconds)
        },
    )

    // ─── Registration ─────────────────────────────────────────

    suspend fun getRegistrationWitnesses(): RegistrationWitnesses = rpc("l2_getRegistrationWitnesses")

    suspend fun submitProof(proofJson: String, entityMetadata: Map<String, String>? = null): JsonElement = rpcCall(
        "l2_submitProof",
        buildJsonObject {
            put("proofJson", json.parseToJsonElement(proofJson))
            if (entityMetadata != null) {
                putJsonObject("entityMetadata") {
                    entityMetadata.forEach { (k, v) -> put(k, v) }
                }
            }
        },
    )

    // ─── Accumulator ────────────────────────────────────────────

    suspend fun reconstructAccumulator(walletId: String): JsonElement = rpcCall(
        "l2_reconstructAccumulator",
        buildJsonObject { put("walletId", walletId) },
    )

    // ─── Leviathan-specific ─────────────────────────────────────

    suspend fun getLeviathanStatus(): JsonElement = rpcCall("l2_getLeviathanStatus")

    suspend fun getPartitionLeaders(): JsonElement = rpcCall("l2_getPartitionLeaders")

    // ─── Quorum ─────────────────────────────────────────────────

    suspend fun getQuorumStatus(): JsonElement = rpcCall("l2_getQuorumStatus")

    suspend fun getStateCertificate(partitionIndex: Int): JsonElement = rpcCall(
        "l2_getStateCertificate",
        buildJsonObject { put("partitionIndex", partitionIndex) },
    )

    fun close() {
        client.close()
    }

    companion object {
        fun defaultHttpClient(): HttpClient = HttpClient {
            expectSuccess = false
        }
    }
}

/** Exception for JSON-RPC errors */
class RpcException(val code: Int, override val message: String) : Exception("RPC error $code: $message")
