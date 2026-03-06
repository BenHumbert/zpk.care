package care.zktrident.app.insurer

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsurerAuditScreen(viewModel: InsurerDashboardViewModel, onBack: () -> Unit) {
    val chainState by viewModel.chainState.collectAsState()
    val quorumStatus by viewModel.quorumStatus.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshDashboard() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Audit & Integrity") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Card {
                Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                    Text("Chain Integrity", style = MaterialTheme.typography.titleMedium)
                    if (chainState != null) {
                        Text("Audit chain hash: ${chainState!!.auditChainHash.take(24)}...")
                        Text("Wallet registry root: ${chainState!!.walletRegistryRoot.take(24)}...")
                        Text("Lifecycle root: ${chainState!!.lifecycleRoot.take(24)}...")
                        Text("Benefit plan root: ${chainState!!.benefitPlanRoot.take(24)}...")
                        if (chainState!!.claimAccumulatorRoot != null) {
                            Text("Claim accumulator: ${chainState!!.claimAccumulatorRoot!!.take(24)}...")
                        }
                    }
                }
            }

            Card {
                Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                    Text("Quorum Status", style = MaterialTheme.typography.titleMedium)
                    if (quorumStatus != null) {
                        Text(quorumStatus.toString().take(200), style = MaterialTheme.typography.bodySmall)
                    } else {
                        Text("Quorum not available (single-node mode)", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            Card {
                Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                    Text("Verification", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "All data on the leviathan network is cryptographically committed. " +
                            "Poseidon hash chains ensure tamper-evidence. " +
                            "ZK proofs verify every state transition without revealing PHI.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}
