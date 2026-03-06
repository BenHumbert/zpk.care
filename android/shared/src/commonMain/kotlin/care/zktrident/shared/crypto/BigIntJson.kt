package care.zktrident.shared.crypto

import kotlinx.serialization.json.*

/**
 * BigInt-safe JSON handling for zkpCare L2 protocol.
 *
 * The leviathan serializes BigInt values as "__bigint__:12345" (prefixed string).
 * This utility handles encoding/decoding of these prefixed values.
 */
object BigIntJson {
    private const val BIGINT_PREFIX = "__bigint__:"

    /** Extract a BigInt string from a JSON element that may be prefixed */
    fun extractBigInt(element: JsonElement): String = when (element) {
        is JsonPrimitive -> {
            val content = element.content
            if (content.startsWith(BIGINT_PREFIX)) {
                content.removePrefix(BIGINT_PREFIX)
            } else {
                content
            }
        }
        else -> throw IllegalArgumentException("Cannot extract BigInt from $element")
    }

    /** Wrap a BigInt string as a prefixed string for sending to leviathan */
    fun wrapBigInt(value: String): JsonPrimitive = JsonPrimitive("$BIGINT_PREFIX$value")

    /**
     * Recursively unwrap all __bigint__: prefixed strings in a JSON tree.
     * Converts "__bigint__:123" → "123" (JsonPrimitive string).
     */
    fun unwrapAll(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> buildJsonObject {
            element.forEach { (key, value) -> put(key, unwrapAll(value)) }
        }
        is JsonArray -> JsonArray(element.map { unwrapAll(it) })
        is JsonPrimitive -> {
            if (element.isString && element.content.startsWith(BIGINT_PREFIX)) {
                JsonPrimitive(element.content.removePrefix(BIGINT_PREFIX))
            } else {
                element
            }
        }
    }
}
