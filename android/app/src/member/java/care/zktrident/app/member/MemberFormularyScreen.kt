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
fun MemberFormularyScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val formulary by viewModel.formulary.collectAsState()
    val error by viewModel.error.collectAsState()
    var searchQuery by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { viewModel.refreshFormulary() }

    val filtered = if (searchQuery.isBlank()) formulary
    else formulary.filter {
        it.brandName.contains(searchQuery, ignoreCase = true) ||
            (it.genericName?.contains(searchQuery, ignoreCase = true) == true) ||
            it.ndc.contains(searchQuery)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Formulary") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            if (error != null) {
                Text(
                    error ?: "",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                label = { Text("Search by drug name or NDC") },
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                singleLine = true,
            )

            LazyColumn(
                contentPadding = PaddingValues(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(filtered) { entry ->
                    Card {
                        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(entry.brandName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                val tierLabel = when (entry.tierLevel) {
                                    1 -> "T1 Generic"
                                    2 -> "T2 Preferred"
                                    3 -> "T3 Non-Preferred"
                                    4 -> "T4 Specialty"
                                    else -> "Tier ${entry.tierLevel}"
                                }
                                Text(tierLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                            entry.genericName?.let { gn -> Text(gn, style = MaterialTheme.typography.bodySmall) }
                            entry.dosageForm?.let { df -> Text("$df ${entry.strength ?: ""}", style = MaterialTheme.typography.bodySmall) }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                entry.copayAmountCents?.let { copay ->
                                    Text("Copay: $${copay / 100}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                                }
                                entry.pricePerUnit?.let { price ->
                                    Text("AWP: ${"$%.2f".format(price)}/unit", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("NDC: ${entry.ndc}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                entry.maxDaySupply?.let { ds -> Text("${ds}d supply", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                if (entry.requiresPriorAuth) {
                                    Text("PA Required", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                                }
                            }
                            entry.therapeuticClass?.let { tc -> Text(tc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                }
            }
        }
    }
}
