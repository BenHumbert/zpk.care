package care.zktrident.app.member

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import care.zktrident.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberDrugHistoryScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val claims by viewModel.claims.collectAsState()
    val loading by viewModel.loading.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshClaims() }

    // Compute summary stats
    val fills = remember(claims) { claims.count { it.leaf.operationType != "reversal" && it.leaf.operationType != "2" } }
    val reversals = remember(claims) { claims.count { it.leaf.operationType == "reversal" || it.leaf.operationType == "2" } }
    val controlled = remember(claims) { claims.count { (it.metadata?.deaSchedule ?: 0) >= 2 } }
    val totalPatientPay = remember(claims) {
        claims.sumOf { it.leaf.patientPayCents.toLongOrNull() ?: 0L }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Drug History") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = {
                    TextButton(onClick = { viewModel.refreshClaims() }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            if (loading) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Summary stats bar
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatChip("Fills", "$fills", Green, Modifier.weight(1f))
                        StatChip("Reversed", "$reversals", Red, Modifier.weight(1f))
                        StatChip("Controlled", "$controlled", Orange, Modifier.weight(1f))
                        StatChip("You Paid", "$${totalPatientPay / 100}", Accent, Modifier.weight(1f))
                    }
                }

                if (claims.isEmpty() && !loading) {
                    item {
                        Text(
                            "No claims yet",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                            modifier = Modifier.padding(top = 16.dp),
                        )
                    }
                }

                // Claim cards (reuse shared ClaimCard from dashboard)
                items(claims) { entry ->
                    ClaimCard(entry)
                }
            }
        }
    }
}

@Composable
private fun StatChip(label: String, value: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = color.copy(alpha = 0.15f)),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 10.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = color)
            Text(label, style = MaterialTheme.typography.labelSmall, color = TextSecondary)
        }
    }
}
