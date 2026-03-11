package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Compose message screen — allows member to send an encrypted message
 * to a provider (prescriber, pharmacy) or insurer.
 *
 * Messages are encrypted client-side and submitted to the sequencer's
 * message store. Only hashed commitments are stored on-chain.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberComposeMessageScreen(
    viewModel: MemberDashboardViewModel,
    onBack: () -> Unit,
    onSent: () -> Unit,
    prefilledRecipientId: String? = null,
    prefilledRecipientName: String? = null,
) {
    val claims by viewModel.claims.collectAsState()
    var recipientWalletId by remember { mutableStateOf(prefilledRecipientId ?: "") }
    var messageText by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showRecipientPicker by remember { mutableStateOf(false) }

    // Build recipient list from claim history
    val knownRecipients = remember(claims) {
        val providers = mutableListOf<Pair<String, String>>()
        claims.map { it.leaf.prescriberWalletId }
            .filter { it.isNotBlank() && it != "0" }
            .distinct()
            .forEach { providers.add("Prescriber" to it) }
        claims.map { it.leaf.pharmacyWalletId }
            .filter { it.isNotBlank() && it != "0" }
            .distinct()
            .forEach { providers.add("Pharmacy" to it) }
        providers
    }

    LaunchedEffect(Unit) { viewModel.refreshClaims() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Send Message") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
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
            Text("Compose Encrypted Message", style = MaterialTheme.typography.titleMedium)
            Text(
                "Messages are encrypted on your device. The sequencer stores only " +
                    "an opaque ciphertext — no one can read your message except the recipient.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Recipient field
            OutlinedTextField(
                value = recipientWalletId,
                onValueChange = { recipientWalletId = it },
                label = { Text("Recipient Wallet ID") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                trailingIcon = {
                    if (knownRecipients.isNotEmpty()) {
                        TextButton(onClick = { showRecipientPicker = true }) { Text("Pick") }
                    }
                },
            )

            // Quick recipient picker
            if (showRecipientPicker && knownRecipients.isNotEmpty()) {
                Card {
                    Column(modifier = Modifier.padding(8.dp)) {
                        Text("Select recipient:", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(8.dp))
                        knownRecipients.forEach { (type, wid) ->
                            TextButton(
                                onClick = {
                                    recipientWalletId = wid
                                    showRecipientPicker = false
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("$type: ${wid.take(20)}...", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }

            // Message body
            OutlinedTextField(
                value = messageText,
                onValueChange = { messageText = it },
                label = { Text("Message") },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 120.dp),
                maxLines = 8,
            )

            if (error != null) {
                Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick = {
                    sending = true
                    error = null
                    viewModel.sendMessage(
                        recipientWalletId = recipientWalletId,
                        messageText = messageText,
                        onSuccess = {
                            sending = false
                            onSent()
                        },
                        onError = { e ->
                            sending = false
                            error = e
                        },
                    )
                },
                enabled = recipientWalletId.isNotBlank() && messageText.isNotBlank() && !sending,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (sending) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                }
                Text("Send Message")
            }
        }
    }
}
