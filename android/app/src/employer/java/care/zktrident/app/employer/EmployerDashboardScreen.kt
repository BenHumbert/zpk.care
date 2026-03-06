package care.zktrident.app.employer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import care.zktrident.app.navigation.Routes
import care.zktrident.app.ui.StatusBanner
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployerDashboardScreen(
    viewModel: EmployerDashboardViewModel,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
    onNavigate: (String) -> Unit,
) {
    val groups by viewModel.groups.collectAsState()
    val roster by viewModel.roster.collectAsState()
    val loading by viewModel.loading.collectAsState()

    // Config dialog
    var showConfig by remember { mutableStateOf(false) }
    var nautilusUrl by remember { mutableStateOf("") }
    var adminToken by remember { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Employer Dashboard") },
                actions = {
                    TextButton(onClick = { showConfig = true }) { Text("Config") }
                    TextButton(onClick = { onNavigate(Routes.SETTINGS) }) { Text("Settings") }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            StatusBanner(sequencerVm, sseVm)

            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Card(modifier = Modifier.weight(1f).clickable { onNavigate(Routes.GROUPS) }) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Groups", style = MaterialTheme.typography.titleSmall)
                            Text("${groups.size} groups", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Card(modifier = Modifier.weight(1f).clickable { onNavigate(Routes.TOKENS) }) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Tokens", style = MaterialTheme.typography.titleSmall)
                            Text("Generate & manage", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                Card(modifier = Modifier.fillMaxWidth().clickable { onNavigate(Routes.ROSTER) }) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Roster", style = MaterialTheme.typography.titleSmall)
                        Text("${roster?.active ?: 0} active / ${roster?.total ?: 0} total", style = MaterialTheme.typography.bodySmall)
                    }
                }

                if (loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
        }
    }

    if (showConfig) {
        AlertDialog(
            onDismissRequest = { showConfig = false },
            title = { Text("Employer Nautilus Config") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = nautilusUrl, onValueChange = { nautilusUrl = it }, label = { Text("Nautilus URL") }, singleLine = true)
                    OutlinedTextField(value = adminToken, onValueChange = { adminToken = it }, label = { Text("Admin Token") }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.setNautilusConfig(nautilusUrl, adminToken)
                    viewModel.refreshGroups()
                    viewModel.refreshRoster()
                    showConfig = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { showConfig = false }) { Text("Cancel") } },
        )
    }
}
