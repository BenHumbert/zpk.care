package care.zktrident.app.employer

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployerRosterScreen(viewModel: EmployerDashboardViewModel, onBack: () -> Unit) {
    val roster by viewModel.roster.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshRoster() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Employee Roster") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            // Summary card
            Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        Column {
                            Text("${roster?.active ?: 0}", style = MaterialTheme.typography.headlineMedium)
                            Text("Active", style = MaterialTheme.typography.labelSmall)
                        }
                        Column {
                            Text("${roster?.total ?: 0}", style = MaterialTheme.typography.headlineMedium)
                            Text("Total", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }

            LazyColumn(
                contentPadding = PaddingValues(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(roster?.entries ?: emptyList()) { entry ->
                    Card {
                        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(entry.employeeIdHash.take(16) + "...", style = MaterialTheme.typography.titleSmall)
                                Text(entry.status)
                            }
                            Text("Group: ${entry.groupId}", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}
