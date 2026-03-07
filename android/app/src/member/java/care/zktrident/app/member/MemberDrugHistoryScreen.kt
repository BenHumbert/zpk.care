package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberDrugHistoryScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val claims by viewModel.claims.collectAsState()
    val loading by viewModel.loading.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshClaims() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Drug History") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        if (loading) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(padding))
        }
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(claims) { entry ->
                val leaf = entry.leaf
                val meta = entry.metadata
                Card {
                    Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                        Text(
                            meta?.brandName ?: "NDC: ${meta?.ndc ?: leaf.ndcHash.take(16)}",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        meta?.therapeuticClass?.let { tc ->
                            Text(tc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.height(4.dp))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("DOS: ${leaf.dateOfService}")
                            Text(if (leaf.operationType == "fulfillment") "Fill" else "Reversal")
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Copay: $${leaf.patientPayCents.toLongOrNull()?.div(100) ?: "?"}")
                            Text("Plan paid: $${leaf.planPayCents.toLongOrNull()?.div(100) ?: "?"}")
                        }
                        if (meta?.daysSupply != null) Text("Days supply: ${meta.daysSupply}")
                        if (meta?.fillNumber != null) Text(if (meta.fillNumber == 0) "Original fill" else "Refill #${meta.fillNumber}")
                        if (meta?.tierLevel != null) Text("Tier ${meta.tierLevel}", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}
