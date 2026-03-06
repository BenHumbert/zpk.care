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
                            Text(entry.brandName, style = MaterialTheme.typography.titleSmall)
                            if (entry.genericName != null) Text(entry.genericName, style = MaterialTheme.typography.bodySmall)
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("NDC: ${entry.ndc}")
                                Text("Tier ${entry.tierLevel}", style = MaterialTheme.typography.labelSmall)
                            }
                            if (entry.dosageForm != null) Text("${entry.dosageForm} ${entry.strength ?: ""}", style = MaterialTheme.typography.bodySmall)
                            if (entry.therapeuticClass != null) Text(entry.therapeuticClass, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}
