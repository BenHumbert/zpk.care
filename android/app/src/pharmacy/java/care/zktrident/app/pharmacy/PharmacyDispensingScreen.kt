package care.zktrident.app.pharmacy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PharmacyDispensingScreen(viewModel: PharmacyDashboardViewModel, onBack: () -> Unit) {
    val claims by viewModel.claims.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Dispensing History") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val fills = claims.filter { it.leaf.operationType == "fulfillment" }
            val reversals = claims.filter { it.leaf.operationType == "reversal" }

            item {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Card(modifier = Modifier.weight(1f)) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text("${fills.size}", style = MaterialTheme.typography.headlineMedium)
                            Text("Fills", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    Card(modifier = Modifier.weight(1f)) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text("${reversals.size}", style = MaterialTheme.typography.headlineMedium)
                            Text("Reversals", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }

            items(claims) { entry ->
                val leaf = entry.leaf
                val meta = entry.metadata
                Card {
                    Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                        Text(meta?.brandName ?: "NDC: ${meta?.ndc ?: leaf.ndcHash.take(16)}", style = MaterialTheme.typography.titleSmall)
                        Text("Patient: ${leaf.memberWalletId.take(16)}...", style = MaterialTheme.typography.bodySmall)
                        Text("DOS: ${leaf.dateOfService} | ${leaf.operationType}", style = MaterialTheme.typography.bodySmall)
                        if (meta?.daysSupply != null) Text("Days: ${meta.daysSupply}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
