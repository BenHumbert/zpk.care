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
import care.zktrident.shared.model.FormularyEntry

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
                actions = {
                    TextButton(onClick = { viewModel.refreshFormulary() }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            if (error != null) {
                Text(
                    error ?: "",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }

            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                label = { Text("Search by drug name or NDC") },
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                singleLine = true,
            )

            // Result count
            Text(
                "${filtered.size} medications",
                style = MaterialTheme.typography.labelSmall,
                color = TextSecondary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )

            LazyColumn(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(filtered) { entry ->
                    FormularyCard(entry)
                }
            }
        }
    }
}

@Composable
private fun FormularyCard(entry: FormularyEntry) {
    val tierColor = when (entry.tierLevel) {
        1 -> Green
        2 -> Blue
        3 -> Yellow
        4 -> Red
        else -> TextSecondary
    }
    val tierLabel = when (entry.tierLevel) {
        1 -> "T1 Generic"
        2 -> "T2 Preferred"
        3 -> "T3 Non-Preferred"
        4 -> "T4 Specialty"
        else -> "Tier ${entry.tierLevel}"
    }
    val isControlled = entry.deaSchedule >= 2

    Card {
        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
            // Header: drug name + tier chip + controlled badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(entry.brandName, style = MaterialTheme.typography.titleSmall)
                    entry.genericName?.let { gn ->
                        Text(gn, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (isControlled) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(Orange.copy(alpha = 0.2f))
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        ) {
                            Text(
                                "C-${entry.deaSchedule}",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = Orange,
                            )
                        }
                    }
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(tierColor.copy(alpha = 0.2f))
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    ) {
                        Text(
                            tierLabel,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Medium,
                            color = tierColor,
                        )
                    }
                }
            }

            // Dosage info
            entry.dosageForm?.let { df ->
                Text(
                    "$df ${entry.strength ?: ""}".trim(),
                    style = MaterialTheme.typography.bodySmall,
                    color = TextSecondary,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }

            Spacer(Modifier.height(8.dp))

            // Cost row
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                entry.copayAmountCents?.let { copay ->
                    Text(
                        "Copay: $${copay / 100}",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = Accent,
                    )
                }
                entry.pricePerUnit?.let { price ->
                    Text(
                        "AWP: ${"$%.2f".format(price)}/unit",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextSecondary,
                    )
                }
            }

            // Meta row: NDC, supply, PA
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("NDC: ${entry.ndc}", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                entry.maxDaySupply?.let { ds ->
                    Text("${ds}d supply", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                }
                if (entry.requiresPriorAuth) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(Red.copy(alpha = 0.2f))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    ) {
                        Text(
                            "PA Required",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            color = Red,
                        )
                    }
                }
            }

            // Therapeutic class
            entry.therapeuticClass?.let { tc ->
                Text(
                    tc,
                    style = MaterialTheme.typography.bodySmall,
                    color = TextSecondary,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}
