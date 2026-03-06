package care.zktrident.app.pharmacy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PharmacyFormularyScreen(viewModel: PharmacyDashboardViewModel, onBack: () -> Unit) {
    val formulary by viewModel.formulary.collectAsState()
    var query by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { viewModel.refreshFormulary() }

    val filtered = if (query.isBlank()) formulary
    else formulary.filter {
        it.brandName.contains(query, ignoreCase = true) || it.ndc.contains(query)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Formulary / DUR") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            OutlinedTextField(
                value = query, onValueChange = { query = it },
                label = { Text("Search drug or NDC") },
                modifier = Modifier.fillMaxWidth().padding(16.dp), singleLine = true,
            )
            LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(filtered) { entry ->
                    Card {
                        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                            Text(entry.brandName, style = MaterialTheme.typography.titleSmall)
                            Text("NDC: ${entry.ndc} | Tier ${entry.tierLevel}")
                            if (entry.therapeuticClass != null) Text(entry.therapeuticClass, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}
