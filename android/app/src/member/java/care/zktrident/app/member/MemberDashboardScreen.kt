package care.zktrident.app.member

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import care.zktrident.app.navigation.Routes
import care.zktrident.app.ui.StatusBanner
import care.zktrident.app.ui.theme.*
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel
import care.zktrident.shared.model.ClaimAccumulatorEntry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberDashboardScreen(
    viewModel: MemberDashboardViewModel,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
    onNavigate: (String) -> Unit,
) {
    val claims by viewModel.claims.collectAsState()
    val planSpend by viewModel.planSpend.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val pcpAssignment by viewModel.pcpAssignment.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.refreshClaims()
        viewModel.refreshPlanSpend()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Health") },
                actions = {
                    TextButton(onClick = { onNavigate(Routes.SETTINGS) }) { Text("Settings") }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            StatusBanner(sequencerVm, sseVm)

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // ── PCP nudge (if not assigned yet) ──
                if (pcpAssignment == null) {
                    item {
                        OutlinedCard(
                            modifier = Modifier.fillMaxWidth().clickable { onNavigate(Routes.PROVIDERS) },
                            border = CardDefaults.outlinedCardBorder().copy(
                                brush = SolidColor(Accent.copy(alpha = 0.4f)),
                            ),
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp).fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        "Assign your Primary Care Provider",
                                        style = MaterialTheme.typography.titleSmall,
                                        color = Accent,
                                    )
                                    Text(
                                        "Tap to choose from your network",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = TextSecondary,
                                    )
                                }
                            }
                        }
                    }
                }

                // ── Hero: Plan Spend progress ──
                item {
                    PlanSpendHero(planSpend, onClick = { onNavigate(Routes.PLAN_SPEND) })
                }

                // ── Primary actions ──
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        PrimaryActionCard(
                            title = "Drug History",
                            value = "${claims.size}",
                            label = "claims",
                            modifier = Modifier.weight(1f),
                        ) { onNavigate(Routes.DRUG_HISTORY) }
                        PrimaryActionCard(
                            title = "Formulary",
                            value = "Search",
                            label = "drugs & coverage",
                            modifier = Modifier.weight(1f),
                        ) { onNavigate(Routes.FORMULARY) }
                    }
                }
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        PrimaryActionCard(
                            title = "Messages",
                            value = "Inbox",
                            label = "secure messages",
                            modifier = Modifier.weight(1f),
                        ) { onNavigate(Routes.MESSAGES) }
                        PrimaryActionCard(
                            title = "Providers",
                            value = "Network",
                            label = "prescribers & Rx",
                            modifier = Modifier.weight(1f),
                        ) { onNavigate(Routes.PROVIDERS) }
                    }
                }

                // ── Secondary actions ──
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        SecondaryActionCard("Benefit Plan", Modifier.weight(1f)) {
                            onNavigate(Routes.BENEFIT_PLAN)
                        }
                        SecondaryActionCard("NFC Backup", Modifier.weight(1f)) {
                            onNavigate(Routes.NFC_WRITE)
                        }
                    }
                }

                // ── Recent activity ──
                if (claims.isNotEmpty()) {
                    item {
                        Text(
                            "Recent Activity",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                    items(claims.take(5)) { entry ->
                        ClaimCard(entry)
                    }
                    if (claims.size > 5) {
                        item {
                            TextButton(
                                onClick = { onNavigate(Routes.DRUG_HISTORY) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("View all ${claims.size} claims")
                            }
                        }
                    }
                }

                if (claims.isEmpty() && !loading) {
                    item {
                        Text(
                            "No claims yet",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                        )
                    }
                }

                if (loading) {
                    item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
                }
            }
        }
    }
}

// ── Hero card: deductible + OOP progress bars ──

@Composable
private fun PlanSpendHero(spend: PlanSpend?, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Plan Spend", style = MaterialTheme.typography.titleSmall)
                Text("Year to Date", style = MaterialTheme.typography.labelSmall, color = TextSecondary)
            }
            Spacer(Modifier.height(12.dp))

            if (spend == null) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            } else {
                val dedMax = 150000L
                val oopMax = 500000L
                val dedPct = if (dedMax > 0) (spend.deductiblePaidCents.toFloat() / dedMax).coerceIn(0f, 1f) else 0f
                val oopPct = if (oopMax > 0) (spend.oopPaidCents.toFloat() / oopMax).coerceIn(0f, 1f) else 0f

                ProgressRow("Deductible", spend.deductibleDollars(), "$${dedMax / 100}", dedPct, Accent)
                Spacer(Modifier.height(10.dp))
                ProgressRow("Out-of-Pocket", spend.oopDollars(), "$${oopMax / 100}", oopPct, if (oopPct > 0.8f) Yellow else Accent)
            }
        }
    }
}

@Composable
private fun ProgressRow(label: String, spent: String, limit: String, pct: Float, color: Color) {
    Column {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
            Text("$spent of $limit", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
        }
        Spacer(Modifier.height(4.dp))
        Box(
            modifier = Modifier.fillMaxWidth().height(8.dp)
                .clip(RoundedCornerShape(4.dp)).background(BgHover),
        ) {
            Box(
                modifier = Modifier.fillMaxHeight().fillMaxWidth(pct)
                    .clip(RoundedCornerShape(4.dp)).background(color),
            )
        }
    }
}

@Composable
private fun PrimaryActionCard(title: String, value: String, label: String, modifier: Modifier, onClick: () -> Unit) {
    Card(modifier = modifier.clickable(onClick = onClick)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = Accent)
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
        }
    }
}

@Composable
private fun SecondaryActionCard(title: String, modifier: Modifier, onClick: () -> Unit) {
    OutlinedCard(modifier = modifier.clickable(onClick = onClick)) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

@Composable
fun ClaimCard(entry: ClaimAccumulatorEntry) {
    val meta = entry.metadata
    val leaf = entry.leaf
    val isReversal = leaf.operationType == "reversal" || leaf.operationType == "2"
    val isControlled = (meta?.deaSchedule ?: 0) >= 2
    val barColor = when {
        isReversal -> Red
        isControlled -> Orange
        else -> Green
    }

    Card {
        Row(modifier = Modifier.fillMaxWidth()) {
            // Color indicator bar
            Box(
                modifier = Modifier
                    .width(4.dp)
                    .heightIn(min = 56.dp)
                    .background(barColor),
            )
            Column(modifier = Modifier.padding(12.dp).weight(1f)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            meta?.brandName ?: "NDC: ${meta?.ndc ?: leaf.ndcHash.take(12)}",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        meta?.therapeuticClass?.let { tc ->
                            Text(tc, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                        }
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        if (isReversal) {
                            Text("REVERSED", style = MaterialTheme.typography.labelSmall, color = Red)
                        }
                        if (isControlled) {
                            Text("C-${meta?.deaSchedule}", style = MaterialTheme.typography.labelSmall, color = Orange, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("DOS: ${leaf.dateOfService}", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("You: $${leaf.patientPayCents.toLongOrNull()?.div(100) ?: "?"}", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                        Text("Plan: $${leaf.planPayCents.toLongOrNull()?.div(100) ?: "?"}", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                    }
                }
            }
        }
    }
}
