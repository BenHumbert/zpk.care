package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Benefit Plan screen — shows plan details derived from formulary tier distribution
 * and accumulator data (deductible, OOP max, benefit used).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberBenefitPlanScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val formulary by viewModel.formulary.collectAsState()
    val planSpend by viewModel.planSpend.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.refreshFormulary()
        viewModel.refreshPlanSpend()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Benefit Plan") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = {
                    TextButton(onClick = {
                        viewModel.refreshFormulary()
                        viewModel.refreshPlanSpend()
                    }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Plan spend summary
            item {
                Text("Accumulator Summary", style = MaterialTheme.typography.titleMedium)
            }

            if (planSpend == null) {
                item { CircularProgressIndicator(modifier = Modifier.padding(16.dp)) }
            } else {
                val spend = planSpend!!
                item {
                    Card {
                        Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                            AccumulatorRow("Deductible Paid", spend.deductibleDollars())
                            Divider(modifier = Modifier.padding(vertical = 8.dp))
                            AccumulatorRow("Out-of-Pocket Paid", spend.oopDollars())
                            Divider(modifier = Modifier.padding(vertical = 8.dp))
                            AccumulatorRow("Plan Benefit Used", spend.benefitDollars())
                            Divider(modifier = Modifier.padding(vertical = 8.dp))
                            AccumulatorRow("Total Claims", spend.claimCount.toString())
                        }
                    }
                }
            }

            // Formulary tier breakdown
            item {
                Spacer(Modifier.height(8.dp))
                Text("Formulary Tier Breakdown", style = MaterialTheme.typography.titleMedium)
            }

            if (formulary.isEmpty()) {
                item {
                    Text(
                        "Loading formulary...",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                val tierGroups = formulary.groupBy { it.tierLevel }
                val tierNames = mapOf(
                    1 to "Tier 1 — Generic",
                    2 to "Tier 2 — Preferred Brand",
                    3 to "Tier 3 — Non-Preferred Brand",
                    4 to "Tier 4 — Specialty",
                )
                items(tierGroups.keys.sorted()) { tier ->
                    val meds = tierGroups[tier] ?: emptyList()
                    val avgPrice = meds.mapNotNull { it.pricePerUnit }.average().let {
                        if (it.isNaN()) "N/A" else "$${String.format("%.2f", it)}"
                    }
                    val tierColor = when (tier) {
                        1 -> MaterialTheme.colorScheme.primary
                        2 -> MaterialTheme.colorScheme.secondary
                        3 -> MaterialTheme.colorScheme.tertiary
                        4 -> MaterialTheme.colorScheme.error
                        else -> MaterialTheme.colorScheme.onSurface
                    }
                    Card {
                        Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column {
                                    Text(
                                        tierNames[tier] ?: "Tier $tier",
                                        style = MaterialTheme.typography.titleSmall,
                                        color = tierColor,
                                    )
                                    Text(
                                        "${meds.size} medications",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    Text(
                                        "Avg: $avgPrice/unit",
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                            // Show top 3 drugs in tier
                            if (meds.isNotEmpty()) {
                                Spacer(Modifier.height(8.dp))
                                Divider()
                                Spacer(Modifier.height(4.dp))
                                meds.take(3).forEach { med ->
                                    Text(
                                        "${med.brandName} — ${med.strength ?: ""}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(vertical = 2.dp),
                                    )
                                }
                                if (meds.size > 3) {
                                    Text(
                                        "and ${meds.size - 3} more...",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }

                // Total formulary count
                item {
                    Text(
                        "Total: ${formulary.size} medications in formulary",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun AccumulatorRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(
            value,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}
