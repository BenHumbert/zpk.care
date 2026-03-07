package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberPlanSpendScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val planSpend by viewModel.planSpend.collectAsState()
    val claims by viewModel.claims.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.refreshPlanSpend()
        viewModel.refreshClaims()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Plan Spend") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = {
                    TextButton(onClick = { viewModel.refreshPlanSpend() }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (planSpend == null) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
            } else {
                val spend = planSpend!!

                Text("Year-to-Date Summary", style = MaterialTheme.typography.titleMedium)

                // Deductible
                SpendCard(
                    title = "Deductible",
                    spent = spend.deductibleDollars(),
                    description = "Amount applied toward your annual deductible",
                )

                // Out-of-Pocket
                SpendCard(
                    title = "Out-of-Pocket",
                    spent = spend.oopDollars(),
                    description = "Total you've paid (copays + deductible)",
                )

                // Benefit Used
                SpendCard(
                    title = "Plan Benefit Used",
                    spent = spend.benefitDollars(),
                    description = "Total your plan has paid on your behalf",
                )

                // Claims count
                Card {
                    Row(
                        modifier = Modifier.padding(16.dp).fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column {
                            Text("Total Claims", style = MaterialTheme.typography.titleSmall)
                            Text("Fills and reversals on record", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(
                            "${spend.claimCount}",
                            style = MaterialTheme.typography.headlineMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }

                // Quick breakdown of recent fills
                if (claims.isNotEmpty()) {
                    Divider()
                    Text("Recent Fills", style = MaterialTheme.typography.titleSmall)
                    claims.take(5).forEach { entry ->
                        val meta = entry.metadata
                        val leaf = entry.leaf
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                meta?.brandName ?: "NDC: ${leaf.ndcHash.take(12)}",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                "You: $${leaf.patientPayCents.toLongOrNull()?.div(100) ?: "?"}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Plan: $${leaf.planPayCents.toLongOrNull()?.div(100) ?: "?"}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SpendCard(title: String, spent: String, description: String) {
    Card {
        Row(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                spent,
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
