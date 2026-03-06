package care.zktrident.app.prescriber

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
fun PrescriberDashboardScreen(
    viewModel: PrescriberDashboardViewModel,
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
    onNavigate: (String) -> Unit,
) {
    val claims by viewModel.claims.collectAsState()
    val loading by viewModel.loading.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshClaims() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Prescriber Dashboard") },
                actions = { TextButton(onClick = { onNavigate(Routes.SETTINGS) }) { Text("Settings") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            StatusBanner(sequencerVm, sseVm)

            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Stats row
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Prescriptions", "${claims.size}", Modifier.weight(1f))
                    StatCard("Patients", "${viewModel.uniquePatients}", Modifier.weight(1f))
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Pharmacies", "${viewModel.uniquePharmacies}", Modifier.weight(1f))
                    StatCard("Medications", "${viewModel.uniqueMedications}", Modifier.weight(1f))
                }

                Card(modifier = Modifier.fillMaxWidth().clickable { onNavigate(Routes.PRESCRIBING_HISTORY) }) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("View Prescribing History", style = MaterialTheme.typography.titleSmall)
                        Text("All prescriptions with drug details", style = MaterialTheme.typography.bodySmall)
                    }
                }

                if (loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier) {
    Card(modifier = modifier) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(value, style = MaterialTheme.typography.headlineMedium)
            Text(label, style = MaterialTheme.typography.labelSmall)
        }
    }
}
