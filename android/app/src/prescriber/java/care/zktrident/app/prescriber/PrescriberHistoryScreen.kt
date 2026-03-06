package care.zktrident.app.prescriber

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrescriberHistoryScreen(viewModel: PrescriberDashboardViewModel, onBack: () -> Unit) {
    val claims by viewModel.claims.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Prescribing History") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(claims) { entry ->
                val leaf = entry.leaf
                val meta = entry.metadata
                Card {
                    Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(meta?.brandName ?: leaf.ndcHash.take(12), style = MaterialTheme.typography.titleSmall)
                            Text(leaf.operationType)
                        }
                        Text("Patient: ${leaf.memberWalletId.take(16)}...", style = MaterialTheme.typography.bodySmall)
                        Text("Pharmacy: ${leaf.pharmacyWalletId.take(16)}...", style = MaterialTheme.typography.bodySmall)
                        Text("DOS: ${leaf.dateOfService}", style = MaterialTheme.typography.bodySmall)
                        if (meta?.tierLevel != null) Text("Tier ${meta.tierLevel}", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}
