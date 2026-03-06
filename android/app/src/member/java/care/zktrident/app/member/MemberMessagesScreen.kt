package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberMessagesScreen(viewModel: MemberDashboardViewModel, onBack: () -> Unit) {
    val messages by viewModel.messages.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshMessages() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Messages") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        if (messages.isEmpty()) {
            Box(modifier = Modifier.padding(padding).fillMaxSize().padding(32.dp)) {
                Text("No messages yet", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(
                modifier = Modifier.padding(padding).fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(messages) { entry ->
                    val msg = entry.message
                    val payload = entry.payload
                    Card {
                        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("From: ${msg.senderWalletId.take(12)}...", style = MaterialTheme.typography.labelSmall)
                                if (payload != null) {
                                    Text(formatTimestamp(payload.timestamp), style = MaterialTheme.typography.labelSmall)
                                }
                            }
                            Spacer(Modifier.height(4.dp))
                            Text("Thread: ${msg.threadIdHash.take(12)}...", style = MaterialTheme.typography.bodySmall)
                            Text("[Encrypted — decrypt locally]", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

private fun formatTimestamp(ts: Long): String {
    return SimpleDateFormat("MMM dd, HH:mm", Locale.US).format(Date(ts))
}
