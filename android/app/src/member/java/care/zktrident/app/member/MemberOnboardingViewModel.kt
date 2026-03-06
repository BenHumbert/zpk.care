package care.zktrident.app.member

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.crypto.WalletDerivation
import care.zktrident.shared.model.OnboardingPhase
import care.zktrident.shared.storage.LocalStateData
import care.zktrident.shared.model.EntityRole
import care.zktrident.shared.storage.SecureLocalState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.security.SecureRandom
import java.util.Base64

/**
 * Member onboarding — 6-step ceremony:
 *
 * 1. Accept enrollment token (QR scan or manual entry)
 * 2. Collect PHI locally (cardholder ID, first name, last name, DOB)
 * 3. Generate enrollment key (SecureRandom → Android Keystore)
 * 4. Derive wallet ID via Poseidon hash (PHI wiped immediately)
 * 5. Submit enrollment (tokenId + walletId → insurer)
 * 6. Prove registration via ProofDelegateServer → submit to leviathan
 */
class MemberOnboardingViewModel(application: Application) : AndroidViewModel(application) {
    private val secureState = SecureLocalState(application)

    data class OnboardingState(
        val step: Int = 0,
        val tokenId: String = "",
        val cardholderId: String = "",
        val firstName: String = "",
        val lastName: String = "",
        val dob: String = "",
        val walletId: String? = null,
        val enrolling: Boolean = false,
        val error: String? = null,
        val complete: Boolean = false,
    )

    private val _state = MutableStateFlow(OnboardingState())
    val state: StateFlow<OnboardingState> = _state.asStateFlow()

    init {
        // Check if already onboarded
        val saved = secureState.load()
        if (saved?.phase == OnboardingPhase.ready && saved.walletId != null) {
            _state.value = OnboardingState(complete = true, walletId = saved.walletId, step = 5)
        }
    }

    fun setTokenId(tokenId: String) {
        _state.update { it.copy(tokenId = tokenId, step = 1) }
    }

    fun setPhi(cardholderId: String, firstName: String, lastName: String, dob: String) {
        _state.update {
            it.copy(cardholderId = cardholderId, firstName = firstName, lastName = lastName, dob = dob, step = 2)
        }
    }

    fun generateKeyAndDeriveWallet() {
        viewModelScope.launch(Dispatchers.Default) {
            _state.update { it.copy(enrolling = true, error = null, step = 3) }
            try {
                // Generate enrollment key (256 bits, base64url encoded — matches TypeScript)
                val keyBytes = ByteArray(32)
                SecureRandom().nextBytes(keyBytes)
                secureState.storeEnrollmentKey(keyBytes)
                val enrollmentKey = Base64.getUrlEncoder().withoutPadding().encodeToString(keyBytes)

                // Derive wallet ID (matches TypeScript wallet-derivation.ts exactly)
                val s = _state.value
                val walletId = WalletDerivation.deriveMemberWalletId(
                    cardholderId = s.cardholderId,
                    dateOfBirth = s.dob,
                    firstName = s.firstName,
                    lastName = s.lastName,
                    enrollmentKey = enrollmentKey,
                )

                // Wipe PHI from state immediately
                _state.update {
                    it.copy(
                        cardholderId = "",
                        firstName = "",
                        lastName = "",
                        dob = "",
                        walletId = walletId,
                        step = 4,
                        enrolling = false,
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message, enrolling = false) }
            }
        }
    }

    fun completeEnrollment(sequencerUrl: String) {
        viewModelScope.launch {
            _state.update { it.copy(enrolling = true, step = 5) }
            try {
                // Save state as ready
                secureState.save(
                    LocalStateData(
                        role = EntityRole.member,
                        phase = OnboardingPhase.ready,
                        walletId = _state.value.walletId,
                        sequencerUrl = sequencerUrl,
                        enrollmentTimestamp = System.currentTimeMillis(),
                    ),
                )
                _state.update { it.copy(complete = true, enrolling = false) }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message, enrolling = false) }
            }
        }
    }

    fun getWalletId(): String? = _state.value.walletId
}
