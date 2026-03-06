package care.zktrident.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Core L2 types matching the TypeScript L2 layer wire format exactly.
 * Field names use @SerialName where Kotlin naming differs from JSON.
 * All bigint fields are represented as String (decimal) after BigIntJson unwrapping.
 */

@Serializable
data class L2NodeStatus(
    val running: Boolean = true,
    val uptimeMs: Long = 0,
    val pendingProofs: Int = 0,
    val totalProofsAccepted: Int = 0,
    val totalBatchesBuilt: Int = 0,
    val totalBatchesSettled: Int = 0,
    val totalBatchesFailed: Int = 0,
    val currentRegistryRoot: String = "",
    val currentLifecycleRoot: String = "",
    val currentWalletCount: String = "0",
    val inFlightBatch: String? = null,
    val nextBatchInMs: Long = 0,
    val batchIntervalMs: Long = 0,
    val chainProofEnabled: Boolean = false,
    val globalStateRoot: String? = null,
    val blockHeight: String? = null,
    val l2Only: Boolean = true,
)

@Serializable
data class L2Receipt(
    val receiptId: String,
    val walletId: String,
    val sequenceNumber: String = "0",
    val oldRegistryRoot: String = "",
    val newRegistryRoot: String = "",
    val oldLifecycleRoot: String = "",
    val newLifecycleRoot: String = "",
    val isRegistration: Boolean = false,
    val l2BlockNumber: String? = null,
    val acceptedAt: Long = 0,
    @SerialName("l1Status") val status: String = "pending",
    @SerialName("l1BatchNumber") val batchNumber: String? = null,
    val auditEventHash: String? = null,
    val claimLeafIndex: String? = null,
)

@Serializable
data class L2Batch(
    val batchNumber: String = "0",
    val blockNumbers: List<String> = emptyList(),
    val registrationCount: Int = 0,
    val transitionCount: Int = 0,
    val oldRegistryRoot: String = "",
    val newRegistryRoot: String = "",
    val oldLifecycleRoot: String = "",
    val newLifecycleRoot: String = "",
    val batchProofJson: String = "",
    val chainProofJson: String? = null,
    val globalStateRoot: String? = null,
    val blockHeight: String? = null,
    val createdAt: Long = 0,
    @SerialName("l1Status") val status: String = "pending",
    @SerialName("l1TxHash") val txHash: String? = null,
    val failureReason: String? = null,
    val claimAccumulatorRoot: String? = null,
    val messageStoreRoot: String? = null,
    val workerId: Int? = null,
    val proveTimeMs: Long? = null,
)

@Serializable
data class L2ChainState(
    val registryRoot: String = "",
    val lifecycleRoot: String = "",
    val walletCount: String = "0",
    val globalStateRoot: String? = null,
    val blockHeight: String? = null,
    val chainProofEnabled: Boolean = false,
    val auditChainHash: String = "",
    val pendingProofs: Int = 0,
    val latestBatchNumber: String? = null,
    val latestBatchStatus: String? = null,
)

/**
 * Claim accumulator entry — matches ClaimAccumulatorEntry from TypeScript.
 * The RPC returns nested objects: leaf + metadata.
 */
@Serializable
data class ClaimAccumulatorEntry(
    val leafIndex: String = "0",
    val leaf: ClaimLeafData,
    val leafHash: String = "",
    val metadata: ClaimMetadata? = null,
)

@Serializable
data class ClaimLeafData(
    val memberWalletId: String = "",
    val ndcHash: String = "",
    val pharmacyWalletId: String = "",
    val prescriberWalletId: String = "",
    val dateOfService: String = "",
    val patientPayCents: String = "0",
    val planPayCents: String = "0",
    val operationType: String = "",
    val deductibleCreditCents: String = "0",
)

@Serializable
data class ClaimMetadata(
    val receiptId: String = "",
    val timestamp: Long = 0,
    val ndc: String? = null,
    val brandName: String? = null,
    val tierLevel: Int? = null,
    val therapeuticClass: String? = null,
    val daysSupply: Int? = null,
    val fillNumber: Int? = null,
    val gpi: String? = null,
)

@Serializable
data class FormularyResponse(
    val formularyRoot: String = "",
    val entriesJson: String = "",
    val publishedAt: Long = 0,
    val version: Int = 0,
)

@Serializable
data class FormularyEntry(
    val ndc: String,
    val brandName: String,
    val genericName: String? = null,
    val dosageForm: String? = null,
    val strength: String? = null,
    val tierLevel: Int = 1,
    val therapeuticClass: String? = null,
    val gpi: String? = null,
    val ndcHash: String = "",
    val pricePerUnit: Double? = null,
)

@Serializable
data class ActivitySummary(
    val totalClaims: Int = 0,
    val totalReversals: Int = 0,
    val activeClaims: Int = 0,
    val totalPatientPayCents: String = "0",
    val totalPlanPayCents: String = "0",
    val uniqueMedications: Int = 0,
    val dateRange: DateRange? = null,
)

@Serializable
data class DateRange(
    val earliest: String,
    val latest: String,
)

/** Message store entry — matches MessageStoreEntry from TypeScript (nested) */
@Serializable
data class MessageStoreEntry(
    val leafIndex: String = "0",
    val message: MessageData,
    val leafHash: String = "",
    val payload: MessagePayload? = null,
)

@Serializable
data class MessageData(
    val messageCommitment: String = "",
    val senderWalletId: String = "",
    val recipientWalletId: String = "",
    val messageType: String = "",
    val threadIdHash: String = "",
)

@Serializable
data class MessagePayload(
    val ciphertext: String = "",
    val iv: String = "",
    val tag: String = "",
    val timestamp: Long = 0,
    val receiptId: String? = null,
)

/** Wrapper for JSON-RPC 2.0 responses */
@Serializable
data class JsonRpcResponse<T>(
    val jsonrpc: String = "2.0",
    val id: Int,
    val result: T? = null,
    val error: JsonRpcError? = null,
)

@Serializable
data class JsonRpcError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null,
)

/** Nautilus API response wrapper */
@Serializable
data class NautilusResponse<T>(
    val ok: Boolean,
    val data: T? = null,
    val error: String? = null,
)
