package care.zktrident.app.member

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.api.ProofDelegateClient
import care.zktrident.shared.crypto.WalletDerivation
import care.zktrident.shared.model.EntityRole
import care.zktrident.shared.model.OnboardingPhase
import care.zktrident.shared.storage.LocalStateData
import care.zktrident.shared.storage.SecureLocalState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.Base64

/**
 * Member onboarding — 6-step ceremony:
 *
 * 1. Accept enrollment token (QR scan or manual entry)
 * 2. Collect PHI locally (cardholder ID, first name, last name, DOB)
 * 3. Generate enrollment key + derive wallet ID (PHI wiped immediately)
 * 4. Enroll with insurer (POST walletId + tokenId)
 * 5. Generate registration proof via ProofDelegateServer
 * 6. Submit proof to leviathan -> L2Receipt -> ready
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
        val preimageFields: List<String>? = null,
        val enrolling: Boolean = false,
        val statusMessage: String? = null,
        val error: String? = null,
        val complete: Boolean = false,
    )

    private val _state = MutableStateFlow(OnboardingState())
    val state: StateFlow<OnboardingState> = _state.asStateFlow()

    init {
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
            _state.update { it.copy(enrolling = true, error = null, step = 3, statusMessage = "Generating enrollment key...") }
            try {
                val keyBytes = ByteArray(32)
                SecureRandom().nextBytes(keyBytes)
                secureState.storeEnrollmentKey(keyBytes)
                val enrollmentKey = Base64.getUrlEncoder().withoutPadding().encodeToString(keyBytes)

                val s = _state.value
                val walletId = WalletDerivation.deriveMemberWalletId(
                    cardholderId = s.cardholderId,
                    dateOfBirth = s.dob,
                    firstName = s.firstName,
                    lastName = s.lastName,
                    enrollmentKey = enrollmentKey,
                ).toString()

                val preimage = WalletDerivation.memberPreimageFields(
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
                        preimageFields = preimage,
                        step = 4,
                        enrolling = false,
                        statusMessage = null,
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message, enrolling = false, statusMessage = null) }
            }
        }
    }

    fun completeEnrollment(sequencerUrl: String, insurerUrl: String, proverUrl: String, proverApiKey: String?) {
        viewModelScope.launch(Dispatchers.IO) {
            _state.update { it.copy(enrolling = true, error = null, step = 5, statusMessage = "Enrolling with insurer...") }
            try {
                val walletId = _state.value.walletId ?: throw IllegalStateException("No wallet ID")
                val tokenId = _state.value.tokenId
                val preimage = _state.value.preimageFields ?: throw IllegalStateException("No preimage fields")

                // Step 1: Notify insurer (simple HTTP POST, no Ktor dependency needed)
                try {
                    val body = """{"walletId":"$walletId","tokenId":"$tokenId","role":"member"}"""
                    val conn = URL("$insurerUrl/enrollment/process").openConnection() as HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.connectTimeout = 10000
                    conn.readTimeout = 10000
                    conn.outputStream.use { it.write(body.toByteArray()) }
                    conn.responseCode // trigger the request
                    conn.disconnect()
                } catch (_: Exception) {
                    _state.update { it.copy(statusMessage = "Insurer unreachable, continuing with registration...") }
                }

                // Step 2: Get registration witnesses from leviathan
                _state.update { it.copy(statusMessage = "Fetching registration witnesses...") }
                val rpcClient = LeviathanRpcClient(sequencerUrl)
                val witnesses = rpcClient.getRegistrationWitnesses()

                // Step 3: Request registration proof from ProofDelegateServer
                _state.update { it.copy(statusMessage = "Generating ZK proof (this may take 30-120s)...") }
                val proverClient = ProofDelegateClient(proverUrl, proverApiKey)
                val proveResult = proverClient.prove(
                    method = "proveRegistration",
                    params = mapOf(
                        "preimage" to preimage,
                        "registryWitnessJson" to witnesses.registryWitnessJson,
                        "lifecycleWitnessJson" to witnesses.lifecycleWitnessJson,
                        "currentRegistryRoot" to witnesses.currentRegistryRoot,
                        "currentLifecycleRoot" to witnesses.currentLifecycleRoot,
                    ),
                )

                val proofJson = proveResult.proofJson
                if (!proveResult.success || proofJson == null) {
                    throw Exception("Proof generation failed: ${proveResult.error}")
                }

                // Step 4: Submit proof to leviathan
                _state.update { it.copy(statusMessage = "Submitting proof to sequencer...") }
                rpcClient.submitProof(proofJson)

                // Save state as ready
                secureState.save(
                    LocalStateData(
                        role = EntityRole.member,
                        phase = OnboardingPhase.ready,
                        walletId = walletId,
                        sequencerUrl = sequencerUrl,
                        enrollmentTimestamp = System.currentTimeMillis(),
                    ),
                )

                _state.update { it.copy(complete = true, enrolling = false, preimageFields = null, statusMessage = null) }

                rpcClient.close()
                proverClient.close()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message, enrolling = false, statusMessage = null) }
            }
        }
    }

    fun getWalletId(): String? = _state.value.walletId
}
