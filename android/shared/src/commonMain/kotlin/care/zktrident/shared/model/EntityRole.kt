package care.zktrident.shared.model

import kotlinx.serialization.Serializable

@Serializable
enum class EntityRole {
    member,
    prescriber,
    pharmacy,
    insurer,
    employer
}
