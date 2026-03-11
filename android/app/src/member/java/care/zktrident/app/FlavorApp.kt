package care.zktrident.app

import android.nfc.Tag
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import care.zktrident.app.member.*
import care.zktrident.app.navigation.Routes
import care.zktrident.app.ui.SettingsScreen
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel
import care.zktrident.shared.model.OnboardingPhase
import care.zktrident.shared.storage.SecureLocalState
import kotlinx.coroutines.flow.SharedFlow

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
    val context = LocalContext.current

    // Get NFC tag flow from activity
    val activity = context as? MainActivity
    val nfcTagFlow: SharedFlow<Tag>? = activity?.nfcTagFlow

    // Pending message recipient (set from Providers screen)
    var pendingMessageRecipientId by remember { mutableStateOf<String?>(null) }
    var pendingMessageRecipientName by remember { mutableStateOf<String?>(null) }

    // On startup: if already enrolled, configure VMs from saved state
    LaunchedEffect(Unit) {
        val state = SecureLocalState(context).load()
        val url = state?.sequencerUrl
        if (state?.phase == OnboardingPhase.ready && url != null) {
            sequencerVm.configure(url)
            sequencerVm.refreshStatus()
            sseVm.connect(url)
            dashboardVm.configure(sequencerVm)
            state.walletId?.let { dashboardVm.setWalletId(it) }
        }
    }

    // Determine start destination based on saved state
    val savedState = remember { SecureLocalState(context).load() }
    val startDest = if (savedState?.phase == OnboardingPhase.ready && savedState.walletId != null) {
        Routes.DASHBOARD
    } else {
        Routes.LANDING
    }

    /** Configure VMs after enrollment or restore */
    fun configureAfterEnrollment(walletId: String) {
        val url = BuildConfig.DEFAULT_SEQUENCER_URL
        sequencerVm.configure(url)
        sequencerVm.refreshStatus()
        sseVm.connect(url)
        dashboardVm.configure(sequencerVm)
        dashboardVm.setWalletId(walletId)
        navController.navigate(Routes.DASHBOARD) {
            popUpTo(0) { inclusive = true }
        }
    }

    NavHost(navController = navController, startDestination = startDest) {
        // Landing — first screen for new users
        composable(Routes.LANDING) {
            MemberLandingScreen(
                onEnrollment = {
                    navController.navigate(Routes.ONBOARDING)
                },
                onRestoreBackup = {
                    navController.navigate(Routes.NFC_RESTORE)
                },
            )
        }
        composable(Routes.ONBOARDING) {
            MemberOnboardingScreen(
                viewModel = onboardingVm,
                sequencerVm = sequencerVm,
                onComplete = {
                    val wid = onboardingVm.getWalletId() ?: return@MemberOnboardingScreen
                    configureAfterEnrollment(wid)
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
                onCompose = { navController.navigate(Routes.COMPOSE_MESSAGE) },
            )
        }
        composable(Routes.COMPOSE_MESSAGE) {
            MemberComposeMessageScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
                onSent = {
                    pendingMessageRecipientId = null
                    pendingMessageRecipientName = null
                    navController.popBackStack()
                },
                prefilledRecipientId = pendingMessageRecipientId,
                prefilledRecipientName = pendingMessageRecipientName,
            )
        }
        composable(Routes.PCP_ASSIGN) {
            MemberPcpScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.PLAN_SPEND) {
            MemberPlanSpendScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.PROVIDERS) {
            MemberProvidersScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
                onMessage = { recipientId, recipientName ->
                    pendingMessageRecipientId = recipientId
                    pendingMessageRecipientName = recipientName
                    navController.navigate(Routes.COMPOSE_MESSAGE)
                },
            )
        }
        composable(Routes.BENEFIT_PLAN) {
            MemberBenefitPlanScreen(
                viewModel = dashboardVm,
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.NFC_WRITE) {
            if (nfcTagFlow != null) {
                MemberNfcWriteScreen(
                    nfcTagFlow = nfcTagFlow,
                    rpcClient = sequencerVm.getClient(),
                    onBack = { navController.popBackStack() },
                )
            } else {
                Text(
                    "NFC not available on this device",
                    modifier = Modifier.padding(32.dp),
                )
            }
        }
        composable(Routes.NFC_RESTORE) {
            if (nfcTagFlow != null) {
                MemberNfcRestoreScreen(
                    nfcTagFlow = nfcTagFlow,
                    sequencerUrl = BuildConfig.DEFAULT_SEQUENCER_URL,
                    onRestoreComplete = { walletId ->
                        configureAfterEnrollment(walletId)
                    },
                    onBack = { navController.popBackStack() },
                )
            } else {
                Text(
                    "NFC not available on this device",
                    modifier = Modifier.padding(32.dp),
                )
            }
        }
        composable(Routes.NFC_SCAN) {
            if (nfcTagFlow != null) {
                MemberNfcWriteScreen(
                    nfcTagFlow = nfcTagFlow,
                    rpcClient = sequencerVm.getClient(),
                    onBack = { navController.popBackStack() },
                )
            } else {
                Text(
                    "NFC not available on this device",
                    modifier = Modifier.padding(32.dp),
                )
            }
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                sequencerVm = sequencerVm,
                onBack = { navController.popBackStack() },
            )
        }
    }
}
