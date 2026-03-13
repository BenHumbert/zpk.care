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
                    TextButton(onClick = {
                        viewModel.refreshPlanSpend()
                        viewModel.refreshClaims()
                    }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (planSpend == null) {
                item {
                    CircularProgressIndicator(
                        modifier = Modifier.fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).padding(32.dp),
                    )
                }
            } else {
                val spend = planSpend!!
                val dedMax = 150000L
                val oopMax = 500000L
                val dedPct = if (dedMax > 0) (spend.deductiblePaidCents.toFloat() / dedMax).coerceIn(0f, 1f) else 0f
                val oopPct = if (oopMax > 0) (spend.oopPaidCents.toFloat() / oopMax).coerceIn(0f, 1f) else 0f

                item {
                    Text("Year-to-Date Summary", style = MaterialTheme.typography.titleMedium)
                }

                // Deductible progress
                item {
                    SpendProgressCard(
                        title = "Deductible",
                        spent = spend.deductibleDollars(),
                        limit = "$${dedMax / 100}",
                        pct = dedPct,
                        color = Accent,
                        description = "Amount applied toward your annual deductible",
                    )
                }

                // Out-of-Pocket progress
                item {
                    SpendProgressCard(
                        title = "Out-of-Pocket Maximum",
                        spent = spend.oopDollars(),
                        limit = "$${oopMax / 100}",
                        pct = oopPct,
                        color = if (oopPct > 0.8f) Yellow else Accent,
                        description = "Total you've paid (copays + deductible)",
                    )
                }

                // Benefit used (no progress bar — plan-side)
                item {
                    Card {
                        Row(
                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Plan Benefit Used", style = MaterialTheme.typography.titleSmall)
                                Text(
                                    "Total your plan has paid on your behalf",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TextSecondary,
                                )
                            }
                            Text(
                                spend.benefitDollars(),
                                style = MaterialTheme.typography.headlineSmall,
                                color = Accent,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }

                // Claims count
                item {
                    Card {
                        Row(
                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column {
                                Text("Total Claims", style = MaterialTheme.typography.titleSmall)
                                Text(
                                    "Fills and reversals on record",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TextSecondary,
                                )
                            }
                            Text(
                                "${spend.claimCount}",
                                style = MaterialTheme.typography.headlineMedium,
                                color = Accent,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }

                // Recent fills with ClaimCard
                if (claims.isNotEmpty()) {
                    item {
                        Text(
                            "Recent Fills",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                    items(claims.take(5)) { entry ->
                        ClaimCard(entry)
                    }
                }
            }
        }
    }
}

@Composable
private fun SpendProgressCard(
    title: String,
    spent: String,
    limit: String,
    pct: Float,
    color: androidx.compose.ui.graphics.Color,
    description: String,
) {
    Card {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleSmall)
                    Text(description, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                }
                Text(
                    "$spent of $limit",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(12.dp))
            // Progress bar
            Box(
                modifier = Modifier.fillMaxWidth().height(10.dp)
                    .clip(RoundedCornerShape(5.dp)).background(BgHover),
            ) {
                Box(
                    modifier = Modifier.fillMaxHeight().fillMaxWidth(pct)
                        .clip(RoundedCornerShape(5.dp)).background(color),
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "${(pct * 100).toInt()}% of limit",
                style = MaterialTheme.typography.labelSmall,
                color = TextSecondary,
            )
        }
    }
}
