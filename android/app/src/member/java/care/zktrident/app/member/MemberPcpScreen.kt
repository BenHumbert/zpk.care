package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberPcpScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val currentPcp by viewModel.pcpAssignment.collectAsState()
    var pcpWalletId by remember { mutableStateOf("") }
    var effectiveDate by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("PCP Assignment") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "Assign your Primary Care Provider",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                "Your PCP can view your drug history and accumulators. " +
                    "This assignment is stored locally on your device only.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Show current assignment
            if (currentPcp != null) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                        Text("Current PCP", style = MaterialTheme.typography.labelSmall)
                        Text(
                            "Wallet: ${currentPcp!!.pcpWalletId.take(20)}...",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(
                            "Effective: ${currentPcp!!.effectiveDate}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                Divider()
                Text("Reassign PCP", style = MaterialTheme.typography.titleSmall)
            }

            OutlinedTextField(
                value = pcpWalletId,
                onValueChange = { pcpWalletId = it },
                label = { Text("Prescriber Wallet ID") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                supportingText = { Text("Ask your prescriber for their wallet ID") },
            )

            OutlinedTextField(
                value = effectiveDate,
                onValueChange = { effectiveDate = it },
                label = { Text("Effective Date (CCYYMMDD)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )

            Button(
                onClick = {
                    viewModel.assignPcp(pcpWalletId, effectiveDate)
                    saved = true
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = pcpWalletId.isNotBlank() && effectiveDate.length == 8,
            ) {
                Text("Assign PCP")
            }

            if (saved) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                    Text(
                        "PCP assigned successfully",
                        modifier = Modifier.padding(12.dp),
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                }
            }
        }
    }
}
