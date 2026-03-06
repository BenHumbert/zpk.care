package care.zktrident.app.insurer

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsurerReportsScreen(viewModel: InsurerDashboardViewModel, onBack: () -> Unit) {
    val batches by viewModel.batches.collectAsState()
    val chainState by viewModel.chainState.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshDashboard() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reports") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Card {
                    Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                        Text("Network Summary", style = MaterialTheme.typography.titleMedium)
                        if (chainState != null) {
                            Text("Chain height: ${chainState!!.chainHeight}")
                            Text("Registered wallets: ${chainState!!.walletCount}")
                            Text("Total batches: ${batches.size}")
                            Text("Total receipts: ${batches.sumOf { it.receiptCount }}")
                        }
                    }
                }
            }

            item { Text("Batch History", style = MaterialTheme.typography.titleMedium) }

            items(batches) { batch ->
                Card {
                    Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Batch #${batch.batchIndex}", style = MaterialTheme.typography.titleSmall)
                            Text(batch.status)
                        }
                        Text("Receipts: ${batch.receiptCount}")
                        Text("ID: ${batch.batchId.take(20)}...")
                    }
                }
            }
        }
    }
}
