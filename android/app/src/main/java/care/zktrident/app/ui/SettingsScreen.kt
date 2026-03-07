package care.zktrident.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import care.zktrident.app.BuildConfig
import care.zktrident.app.viewmodel.SequencerViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    sequencerVm: SequencerViewModel,
    onBack: () -> Unit,
) {
    val status by sequencerVm.status.collectAsState()
    val error by sequencerVm.error.collectAsState()
    var sequencerUrl by remember { mutableStateOf(BuildConfig.DEFAULT_SEQUENCER_URL) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text("Back") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Role: ${BuildConfig.ROLE}", style = MaterialTheme.typography.titleMedium)
            Text("Version: ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium)

            Divider()

            Text("Sequencer Connection", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = sequencerUrl,
                onValueChange = { sequencerUrl = it },
                label = { Text("Sequencer URL") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            Button(
                onClick = {
                    sequencerVm.configure(sequencerUrl)
                    sequencerVm.refreshStatus()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Connect")
            }

            if (error != null) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                ) {
                    Text(
                        "Error: $error",
                        modifier = Modifier.padding(12.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }

            if (status != null) {
                val s = status!!
                Card {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("Connected", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                        Text("Wallets: ${s.currentWalletCount}")
                        Text("Pending proofs: ${s.pendingProofs}")
                        Text("Batches built: ${s.totalBatchesBuilt}")
                        Text("Batches settled: ${s.totalBatchesSettled}")
                    }
                }
            }
        }
    }
}
