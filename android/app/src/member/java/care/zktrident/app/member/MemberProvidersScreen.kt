package care.zktrident.app.member

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import care.zktrident.shared.model.NetworkProvider

/**
 * Providers screen — shows prescribers and pharmacies registered on the network.
 * Tap a prescriber to expand action buttons: Add PCP, Message, Grant Access.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberProvidersScreen(
    viewModel: MemberDashboardViewModel,
    onBack: () -> Unit,
    onMessage: ((recipientWalletId: String, recipientName: String) -> Unit)? = null,
) {
    val providers by viewModel.providers.collectAsState()
    val claims by viewModel.claims.collectAsState()
    var expandedWalletId by remember { mutableStateOf<String?>(null) }
    var actionFeedback by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        viewModel.refreshProviders()
        viewModel.refreshClaims()
    }

    val prescribers = remember(providers) { providers.filter { it.role == "prescriber" } }
    val pharmacies = remember(providers) { providers.filter { it.role == "pharmacy" } }

    val prescriberClaimCounts = remember(claims) {
        claims.groupBy { it.leaf.prescriberWalletId }.mapValues { it.value.size }
    }
    val pharmacyClaimCounts = remember(claims) {
        claims.groupBy { it.leaf.pharmacyWalletId }.mapValues { it.value.size }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Network") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = {
                    TextButton(onClick = { viewModel.refreshProviders() }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Feedback banner
            if (actionFeedback != null) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                        Row(
                            modifier = Modifier.padding(12.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                actionFeedback ?: "",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onTertiaryContainer,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { actionFeedback = null }) { Text("Dismiss") }
                        }
                    }
                }
            }

            // Prescribers section
            item {
                Text(
                    "Prescribers (${prescribers.size})",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }

            if (prescribers.isEmpty()) {
                item {
                    Text(
                        "No prescribers registered in network yet",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                items(prescribers) { provider ->
                    ProviderCard(
                        provider = provider,
                        claimCount = prescriberClaimCounts[provider.walletId] ?: 0,
                        isExpanded = expandedWalletId == provider.walletId,
                        onToggle = {
                            expandedWalletId = if (expandedWalletId == provider.walletId) null else provider.walletId
                        },
                        onAddPcp = {
                            val today = java.text.SimpleDateFormat("yyyyMMdd", java.util.Locale.US)
                                .format(java.util.Date())
                            viewModel.assignPcp(provider.walletId, today)
                            actionFeedback = "${provider.displayName} assigned as PCP"
                            expandedWalletId = null
                        },
                        onMessage = if (onMessage != null) {
                            { onMessage(provider.walletId, provider.displayName) }
                        } else null,
                        onGrantAccess = {
                            viewModel.grantPrescriberAccess(provider.walletId)
                            actionFeedback = "Access granted to ${provider.displayName}"
                            expandedWalletId = null
                        },
                        isPrescriber = true,
                    )
                }
            }

            // Pharmacies section
            item {
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                Text(
                    "Pharmacies (${pharmacies.size})",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }

            if (pharmacies.isEmpty()) {
                item {
                    Text(
                        "No pharmacies registered in network yet",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                items(pharmacies) { provider ->
                    ProviderCard(
                        provider = provider,
                        claimCount = pharmacyClaimCounts[provider.walletId] ?: 0,
                        isExpanded = expandedWalletId == provider.walletId,
                        onToggle = {
                            expandedWalletId = if (expandedWalletId == provider.walletId) null else provider.walletId
                        },
                        onAddPcp = null,
                        onMessage = if (onMessage != null) {
                            { onMessage(provider.walletId, provider.displayName) }
                        } else null,
                        onGrantAccess = {
                            viewModel.grantPrescriberAccess(provider.walletId)
                            actionFeedback = "Access granted to ${provider.displayName}"
                            expandedWalletId = null
                        },
                        isPrescriber = false,
                    )
                }
            }
        }
    }
}

@Composable
private fun ProviderCard(
    provider: NetworkProvider,
    claimCount: Int,
    isExpanded: Boolean,
    onToggle: () -> Unit,
    onAddPcp: (() -> Unit)?,
    onMessage: (() -> Unit)?,
    onGrantAccess: () -> Unit,
    isPrescriber: Boolean,
) {
    Card(
        modifier = Modifier.clickable { onToggle() },
    ) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(provider.displayName, style = MaterialTheme.typography.titleSmall)
                    provider.specialty?.let { spec ->
                        Text(
                            spec,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    provider.pharmacyType?.let { ptype ->
                        Text(
                            ptype,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    Text(
                        "ID: ${provider.walletId.take(16)}...",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (claimCount > 0) {
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            "$claimCount",
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            "claims",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Expandable action buttons
            AnimatedVisibility(visible = isExpanded) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (onAddPcp != null) {
                        OutlinedButton(
                            onClick = onAddPcp,
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text("Add PCP", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (onMessage != null) {
                        OutlinedButton(
                            onClick = onMessage,
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text("Message", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    OutlinedButton(
                        onClick = onGrantAccess,
                        modifier = Modifier.weight(1f),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Text("Grant Access", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}
