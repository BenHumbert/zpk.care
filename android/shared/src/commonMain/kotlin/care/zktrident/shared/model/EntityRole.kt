package care.zktrident.shared.model

import kotlinx.serialization.Serializable

/** The five entity types in the zkpCare system */
@Serializable
enum class EntityRole {
    member, prescriber, pharmacy, insurer, employer
}
