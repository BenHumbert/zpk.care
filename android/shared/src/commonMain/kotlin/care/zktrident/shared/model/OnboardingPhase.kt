package care.zktrident.shared.model

import kotlinx.serialization.Serializable

@Serializable
enum class OnboardingPhase {
    awaiting_token,
    token_received,
    key_generated,
    wallet_derived,
    enrolled,
    compiling,
    ready
}
