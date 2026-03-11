package care.zktrident.app.member

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
    val status by sequencerVm.status.collectAsState()
    val loading by viewModel.loading.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshClaims() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Member Dashboard") },
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
                // Quick actions
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        QuickActionCard("Drug History", "${claims.size} claims", Modifier.weight(1f)) {
                            onNavigate(Routes.DRUG_HISTORY)
                        }
                        QuickActionCard("Formulary", "Search drugs", Modifier.weight(1f)) {
                            onNavigate(Routes.FORMULARY)
                        }
                    }
                }
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        QuickActionCard("Messages", "Inbox", Modifier.weight(1f)) {
                            onNavigate(Routes.MESSAGES)
                        }
                        QuickActionCard("Plan Spend", "Deductible & OOP", Modifier.weight(1f)) {
                            onNavigate(Routes.PLAN_SPEND)
                        }
                    }
                }
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        QuickActionCard("My PCP", "Assign provider", Modifier.weight(1f)) {
                            onNavigate(Routes.PCP_ASSIGN)
                        }
                        QuickActionCard("Providers", "Prescribers & Rx", Modifier.weight(1f)) {
                            onNavigate(Routes.PROVIDERS)
                        }
                    }
                }
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        QuickActionCard("Benefit Plan", "Tiers & accumulators", Modifier.weight(1f)) {
                            onNavigate(Routes.BENEFIT_PLAN)
                        }
                        QuickActionCard("NFC Backup", "Write recovery card", Modifier.weight(1f)) {
                            onNavigate(Routes.NFC_WRITE)
                        }
                    }
                }

                // Recent claims
                item {
                    Text(
                        "Recent Activity",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }

                if (loading) {
                    item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
                }

                items(claims.take(10)) { entry ->
                    ClaimCard(entry)
                }

                if (claims.isEmpty() && !loading) {
                    item {
                        Text(
                            "No claims yet",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun QuickActionCard(title: String, subtitle: String, modifier: Modifier, onClick: () -> Unit) {
    Card(
        modifier = modifier.clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ClaimCard(entry: ClaimAccumulatorEntry) {
    val meta = entry.metadata
    val leaf = entry.leaf
    Card {
        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(meta?.brandName ?: leaf.ndcHash.take(12), style = MaterialTheme.typography.titleSmall)
                Text(leaf.operationType, style = MaterialTheme.typography.labelSmall)
            }
            Text("DOS: ${leaf.dateOfService}", style = MaterialTheme.typography.bodySmall)
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Copay: $${leaf.patientPayCents.toLongOrNull()?.div(100) ?: "?"}", style = MaterialTheme.typography.bodySmall)
                Text("Plan: $${leaf.planPayCents.toLongOrNull()?.div(100) ?: "?"}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
