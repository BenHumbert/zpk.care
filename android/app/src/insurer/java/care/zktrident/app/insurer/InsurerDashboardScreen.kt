package care.zktrident.app.insurer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import care.zktrident.app.navigation.Routes
import care.zktrident.app.ui.StatusBanner
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsurerDashboardScreen(
    viewModel: InsurerDashboardViewModel,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
    onNavigate: (String) -> Unit,
) {
    val chainState by viewModel.chainState.collectAsState()
    val batches by viewModel.batches.collectAsState()
    val loading by viewModel.loading.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshDashboard() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Insurer Dashboard") },
                actions = { TextButton(onClick = { onNavigate(Routes.SETTINGS) }) { Text("Settings") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            StatusBanner(sequencerVm, sseVm)

            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Chain state
                Card {
                    Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                        Text("Chain State", style = MaterialTheme.typography.titleSmall)
                        if (chainState != null) {
                            Text("Height: ${chainState!!.chainHeight}")
                            Text("Wallets: ${chainState!!.walletCount}")
                            Text("Registry root: ${chainState!!.walletRegistryRoot.take(20)}...")
                        } else if (loading) {
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        }
                    }
                }

                // Navigation cards
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Card(modifier = Modifier.weight(1f).clickable { onNavigate(Routes.REPORTS) }) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Reports", style = MaterialTheme.typography.titleSmall)
                            Text("${batches.size} batches", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Card(modifier = Modifier.weight(1f).clickable { onNavigate(Routes.AUDIT) }) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Audit", style = MaterialTheme.typography.titleSmall)
                            Text("Chain integrity", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }

                // Recent batches
                Text("Recent Batches", style = MaterialTheme.typography.titleMedium)
                batches.take(5).forEach { batch ->
                    Card {
                        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Batch #${batch.batchIndex}", style = MaterialTheme.typography.titleSmall)
                                Text(batch.status)
                            }
                            Text("${batch.receiptCount} receipts", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}
