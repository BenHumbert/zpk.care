package care.zktrident.app

import androidx.compose.runtime.*
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import care.zktrident.app.member.*
import care.zktrident.app.navigation.Routes
import care.zktrident.app.ui.SettingsScreen
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

/**
 * Member flavor app — most complex onboarding (6 steps), drug history,
 * formulary lookup, NFC credential attestation, proof delegation.
 */
@Composable
fun FlavorApp(
    navController: NavHostController,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
) {
    val onboardingVm: MemberOnboardingViewModel = viewModel()
    val dashboardVm: MemberDashboardViewModel = viewModel()

    NavHost(navController = navController, startDestination = Routes.ONBOARDING) {
        composable(Routes.ONBOARDING) {
            MemberOnboardingScreen(
                viewModel = onboardingVm,
                sequencerVm = sequencerVm,
                onComplete = {
                    dashboardVm.configure(sequencerVm)
                    onboardingVm.getWalletId()?.let { dashboardVm.setWalletId(it) }
                    navController.navigate(Routes.DASHBOARD) {
                        popUpTo(Routes.ONBOARDING) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.DASHBOARD) {
            MemberDashboardScreen(
                viewModel = dashboardVm,
                sequencerVm = sequencerVm,
                sseVm = sseVm,
                onNavigate = { route -> navController.navigate(route) },
            )
        }
        composable(Routes.DRUG_HISTORY) {
            MemberDrugHistoryScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.FORMULARY) {
            MemberFormularyScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.MESSAGES) {
            MemberMessagesScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.NFC_SCAN) {
            // Placeholder NFC screen — full implementation requires NFC hardware
            androidx.compose.material3.Text(
                "Hold NFC card to back of device",
                modifier = androidx.compose.ui.Modifier.padding(32.dp),
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                sequencerVm = sequencerVm,
                onBack = { navController.popBackStack() },
            )
        }
    }
}
