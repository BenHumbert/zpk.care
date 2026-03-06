package care.zktrident.app

import androidx.compose.runtime.*
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import care.zktrident.app.insurer.*
import care.zktrident.app.navigation.Routes
import care.zktrident.app.ui.SettingsScreen
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

@Composable
fun FlavorApp(
    navController: NavHostController,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
) {
    val dashboardVm: InsurerDashboardViewModel = viewModel()

    LaunchedEffect(Unit) { dashboardVm.configure(sequencerVm) }

    NavHost(navController = navController, startDestination = Routes.DASHBOARD) {
        composable(Routes.DASHBOARD) {
            InsurerDashboardScreen(
                viewModel = dashboardVm,
                sequencerVm = sequencerVm,
                sseVm = sseVm,
                onNavigate = { navController.navigate(it) },
            )
        }
        composable(Routes.REPORTS) {
            InsurerReportsScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.AUDIT) {
            InsurerAuditScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(sequencerVm = sequencerVm, onBack = { navController.popBackStack() })
        }
    }
}
