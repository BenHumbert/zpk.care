package care.zktrident.app.employer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import care.zktrident.shared.api.LeviathanRpcClient
import care.zktrident.shared.model.*
import care.zktrident.app.viewmodel.SequencerViewModel
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Employer dashboard — manages groups, tokens, and roster
 * via the Employer Nautilus REST API (not direct RPC).
 */
class EmployerDashboardViewModel : ViewModel() {
    private var rpcClient: LeviathanRpcClient? = null
    private var nautilusUrl: String = ""
    private var adminToken: String = ""
    private val httpClient = HttpClient { expectSuccess = false }
    private val json = Json { ignoreUnknownKeys = true }

    // Groups
    private val _groups = MutableStateFlow<List<EmployerGroup>>(emptyList())
    val groups: StateFlow<List<EmployerGroup>> = _groups.asStateFlow()

    // Tokens
    private val _tokens = MutableStateFlow<List<EmployerToken>>(emptyList())
    val tokens: StateFlow<List<EmployerToken>> = _tokens.asStateFlow()

    // Roster
    private val _roster = MutableStateFlow<EmployerRoster?>(null)
    val roster: StateFlow<EmployerRoster?> = _roster.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun configure(sequencerVm: SequencerViewModel) {
        rpcClient = sequencerVm.getClient()
    }

    fun setNautilusConfig(url: String, token: String) {
        nautilusUrl = url
        adminToken = token
    }

    fun refreshGroups() {
        if (nautilusUrl.isEmpty()) return
        viewModelScope.launch {
            _loading.value = true
            try {
                val resp = httpClient.get("$nautilusUrl/groups") {
                    header("Authorization", "Bearer $adminToken")
                }
                val body = resp.bodyAsText()
                val parsed = json.decodeFromString<NautilusListResponse<EmployerGroup>>(body)
                if (parsed.ok) _groups.value = parsed.data ?: emptyList()
                _error.value = null
            } catch (e: Exception) { _error.value = e.message }
            finally { _loading.value = false }
        }
    }

    fun refreshRoster() {
        if (nautilusUrl.isEmpty()) return
        viewModelScope.launch {
            try {
                val resp = httpClient.get("$nautilusUrl/roster") {
                    header("Authorization", "Bearer $adminToken")
                }
                val body = resp.bodyAsText()
                _roster.value = json.decodeFromString(body)
            } catch (e: Exception) { _error.value = e.message }
        }
    }

    fun createGroup(groupId: String, planId: String, effectiveDate: String, cap: Int) {
        viewModelScope.launch {
            try {
                httpClient.post("$nautilusUrl/groups") {
                    contentType(ContentType.Application.Json)
                    header("Authorization", "Bearer $adminToken")
                    setBody("""{"groupId":"$groupId","planId":"$planId","effectiveDate":"$effectiveDate","enrollmentCap":$cap}""")
                }
                refreshGroups()
            } catch (e: Exception) { _error.value = e.message }
        }
    }

    fun generateToken(groupId: String, employeeId: String, familyId: String, validUntil: String) {
        viewModelScope.launch {
            try {
                httpClient.post("$nautilusUrl/tokens/generate") {
                    contentType(ContentType.Application.Json)
                    header("Authorization", "Bearer $adminToken")
                    setBody("""{"groupId":"$groupId","employeeId":"$employeeId","familyId":"$familyId","validUntil":"$validUntil"}""")
                }
            } catch (e: Exception) { _error.value = e.message }
        }
    }

    override fun onCleared() {
        httpClient.close()
        super.onCleared()
    }
}

@Serializable
data class EmployerGroup(
    val groupId: String,
    val planId: String,
    val effectiveDate: String,
    val terminationDate: String? = null,
    val enrollmentCap: Int = 0,
    val enrolledCount: Int = 0,
    val status: String = "active",
)

@Serializable
data class EmployerToken(
    val tokenId: String,
    val status: String,
    val groupId: String,
)

@Serializable
data class EmployerRoster(
    val total: Int,
    val active: Int,
    val entries: List<EmployerRosterEntry> = emptyList(),
)

@Serializable
data class EmployerRosterEntry(
    val employeeIdHash: String,
    val groupId: String,
    val status: String,
)

@Serializable
data class NautilusListResponse<T>(
    val ok: Boolean,
    val data: List<T>? = null,
    val error: String? = null,
)
