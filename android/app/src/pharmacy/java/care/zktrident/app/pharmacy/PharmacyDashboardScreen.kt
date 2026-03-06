package care.zktrident.app.pharmacy

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
fun PharmacyDashboardScreen(
    viewModel: PharmacyDashboardViewModel,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
    onNavigate: (String) -> Unit,
) {
    val claims by viewModel.claims.collectAsState()
    val loading by viewModel.loading.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshClaims() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pharmacy Dashboard") },
                actions = { TextButton(onClick = { onNavigate(Routes.SETTINGS) }) { Text("Settings") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            StatusBanner(sequencerVm, sseVm)

            LazyColumn(
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Card(modifier = Modifier.weight(1f).clickable { onNavigate(Routes.DISPENSING) }) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text("Dispensing", style = MaterialTheme.typography.titleSmall)
                                Text("${claims.size} claims", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        Card(modifier = Modifier.weight(1f).clickable { onNavigate(Routes.FORMULARY) }) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text("Formulary", style = MaterialTheme.typography.titleSmall)
                                Text("DUR check", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }

                item { Text("Recent Dispensing", style = MaterialTheme.typography.titleMedium) }
                if (loading) { item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) } }

                items(claims.take(15)) { entry ->
                    val leaf = entry.leaf
                    val meta = entry.metadata
                    Card {
                        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(meta?.brandName ?: leaf.ndcHash.take(12), style = MaterialTheme.typography.titleSmall)
                                Text(leaf.operationType)
                            }
                            Text("Patient: ${leaf.memberWalletId.take(12)}...", style = MaterialTheme.typography.bodySmall)
                            Text("Prescriber: ${leaf.prescriberWalletId.take(12)}...", style = MaterialTheme.typography.bodySmall)
                            Text("DOS: ${leaf.dateOfService} | Copay: $${leaf.patientPayCents.toLongOrNull()?.div(100) ?: "?"}", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}
