package care.zktrident.shared.crypto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*
import java.math.BigInteger

/**
 * Serializer for BigInteger values in JSON-RPC communication with the leviathan.
 * The leviathan uses a custom "__bigint__:" prefix for BigInt serialization.
 */
object BigIntSerializer : KSerializer<BigInteger> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("BigInteger", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: BigInteger) {
        encoder.encodeString(value.toString())
    }

    override fun deserialize(decoder: Decoder): BigInteger {
        val str = decoder.decodeString()
        // Handle __bigint__: prefix from leviathan JSON serialization
        return if (str.startsWith("__bigint__:")) {
            BigInteger(str.removePrefix("__bigint__:"))
        } else {
            BigInteger(str)
        }
    }
}

/**
 * Parse a JSON value that might contain __bigint__: prefixed strings.
 */
/**
 * Utility for unwrapping __bigint__: prefixed strings in JSON responses.
 * Matches the TypeScript l2-json.ts BigInt serialization format.
 */
object BigIntJson {
    /**
     * Recursively unwrap all __bigint__: prefixed strings in a JsonElement tree,
     * converting them to plain numeric strings for kotlinx.serialization.
     */
    fun unwrapAll(element: JsonElement): JsonElement = when (element) {
        is JsonPrimitive -> {
            val content = element.content
            if (element.isString && content.startsWith("__bigint__:")) {
                JsonPrimitive(content.removePrefix("__bigint__:"))
            } else {
                element
            }
        }
        is JsonObject -> JsonObject(element.mapValues { (_, v) -> unwrapAll(v) })
        is JsonArray -> JsonArray(element.map { unwrapAll(it) })
    }
}

fun JsonElement.toBigIntOrNull(): BigInteger? {
    return when (this) {
        is JsonPrimitive -> {
            val content = this.content
            when {
                content.startsWith("__bigint__:") -> BigInteger(content.removePrefix("__bigint__:"))
                content.all { it.isDigit() || it == '-' } -> try { BigInteger(content) } catch (_: Exception) { null }
                else -> null
            }
        }
        else -> null
    }
}
