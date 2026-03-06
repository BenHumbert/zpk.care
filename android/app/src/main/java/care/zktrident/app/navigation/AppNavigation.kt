package care.zktrident.app.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable

/** Navigation routes shared across all flavors */
object Routes {
    const val ONBOARDING = "onboarding"
    const val DASHBOARD = "dashboard"
    const val SETTINGS = "settings"
    const val CLAIM_DETAIL = "claim/{receiptId}"
    const val FORMULARY = "formulary"
    const val MESSAGES = "messages"

    // Member-specific
    const val DRUG_HISTORY = "drug_history"
    const val NFC_SCAN = "nfc_scan"

    // Pharmacy-specific
    const val DISPENSING = "dispensing"
    const val DUR_CHECK = "dur_check"

    // Prescriber-specific
    const val PRESCRIBING_HISTORY = "prescribing_history"

    // Insurer-specific
    const val REPORTS = "reports"
    const val AUDIT = "audit"
    const val ENROLLMENT_ADMIN = "enrollment_admin"

    // Employer-specific
    const val GROUPS = "groups"
    const val TOKENS = "tokens"
    const val ROSTER = "roster"
}

/**
 * Each product flavor provides its own navGraph via FlavorNavGraph interface.
 * This allows the main activity to delegate navigation setup to the flavor.
 */
interface FlavorNavGraph {
    /** The start destination route */
    val startDestination: String

    /** Register all flavor-specific composable destinations */
    @Composable
    fun NavGraph(navController: NavHostController)
}
