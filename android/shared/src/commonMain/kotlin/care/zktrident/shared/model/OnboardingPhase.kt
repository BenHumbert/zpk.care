package care.zktrident.shared.model

import kotlinx.serialization.Serializable

/** Onboarding state machine phases */
@Serializable
enum class OnboardingPhase {
    unconfigured, pin_required, key_generation, compiling, enrolling, ready
}

@Serializable
data class OnboardingStatus(
    val phase: OnboardingPhase,
    val role: EntityRole,
    val walletId: String? = null,
)
