package care.zktrident.app.member

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import care.zktrident.app.ui.theme.*
import care.zktrident.shared.model.MessageStoreEntry
import java.text.SimpleDateFormat
import java.util.*

/** Well-known synthetic thread ID for the system conversation */
const val SYSTEM_THREAD_ID = "__zkpcare_system__"
private const val SYSTEM_DISPLAY_NAME = "zkp.Care System"

/**
 * Messages screen — contact/conversation list view.
 * "zkp.Care System" is always pinned first (read-only activity log).
 * Then real conversations grouped by thread.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberMessagesScreen(
    viewModel: MemberDashboardViewModel,
    onBack: () -> Unit,
    onCompose: (() -> Unit)? = null,
    onConversation: ((threadId: String) -> Unit)? = null,
) {
    val messages by viewModel.messages.collectAsState()
    val providers by viewModel.providers.collectAsState()
    val systemEvents by viewModel.systemEvents.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.refreshMessages()
        viewModel.refreshProviders()
    }

    // Build provider name lookup
    val providerNames = remember(providers) {
        providers.associate { it.walletId to it.displayName }
    }

    // Group messages by threadIdHash into conversations
    val conversations = remember(messages) {
        messages
            .groupBy { it.message.threadIdHash }
            .map { (threadId, msgs) ->
                val sorted = msgs.sortedByDescending { it.payload?.timestamp ?: 0L }
                val latest = sorted.first()
                val participants = msgs.flatMap {
                    listOf(it.message.senderWalletId, it.message.recipientWalletId)
                }.distinct()
                ConversationSummary(
                    threadId = threadId,
                    participants = participants,
                    messageCount = msgs.size,
                    lastTimestamp = latest.payload?.timestamp ?: 0L,
                    lastSenderWalletId = latest.message.senderWalletId,
                )
            }
            .sortedByDescending { it.lastTimestamp }
    }

    // System conversation summary (always present)
    val systemConvo = remember(systemEvents) {
        ConversationSummary(
            threadId = SYSTEM_THREAD_ID,
            participants = emptyList(),
            messageCount = systemEvents.size,
            lastTimestamp = systemEvents.lastOrNull()?.timestamp ?: 0L,
            lastSenderWalletId = "",
            isSystem = true,
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Messages") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = {
                    if (onCompose != null) {
                        TextButton(onClick = onCompose) { Text("New") }
                    }
                    TextButton(onClick = { viewModel.refreshMessages() }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // Always show system contact first (pinned)
            item {
                SystemConversationCard(
                    eventCount = systemEvents.size,
                    lastTimestamp = systemEvents.lastOrNull()?.timestamp ?: 0L,
                    lastEvent = systemEvents.lastOrNull()?.summary,
                    onClick = { onConversation?.invoke(SYSTEM_THREAD_ID) },
                )
            }

            if (conversations.isNotEmpty()) {
                item {
                    Text(
                        "${conversations.size} conversations",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextSecondary,
                        modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                    )
                }
                items(conversations) { convo ->
                    ConversationCard(
                        convo = convo,
                        providerNames = providerNames,
                        onClick = { onConversation?.invoke(convo.threadId) },
                    )
                }
            }

            if (conversations.isEmpty()) {
                item {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            "No provider conversations yet",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Message a provider from the Providers screen",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextMuted,
                        )
                        if (onCompose != null) {
                            Spacer(Modifier.height(12.dp))
                            OutlinedButton(onClick = onCompose) { Text("New Message") }
                        }
                    }
                }
            }
        }
    }
}

private data class ConversationSummary(
    val threadId: String,
    val participants: List<String>,
    val messageCount: Int,
    val lastTimestamp: Long,
    val lastSenderWalletId: String,
    val isSystem: Boolean = false,
)

/** Pinned system contact card — always first, distinct visual treatment */
@Composable
private fun SystemConversationCard(
    eventCount: Int,
    lastTimestamp: Long,
    lastEvent: String?,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = Accent.copy(alpha = 0.08f)),
    ) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // System avatar — shield-like with accent border
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Accent.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Z",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = Accent,
                )
            }

            Spacer(Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        SYSTEM_DISPLAY_NAME,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    if (lastTimestamp > 0) {
                        Text(
                            formatTimestamp(lastTimestamp),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextSecondary,
                        )
                    }
                }
                Spacer(Modifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(3.dp))
                            .background(Accent.copy(alpha = 0.15f))
                            .padding(horizontal = 4.dp, vertical = 1.dp),
                    ) {
                        Text(
                            "System",
                            style = MaterialTheme.typography.labelSmall,
                            color = Accent,
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                    Text(
                        lastEvent ?: if (eventCount == 0) "Activity log" else "$eventCount events",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun ConversationCard(
    convo: ConversationSummary,
    providerNames: Map<String, String>,
    onClick: () -> Unit,
) {
    val displayName = convo.participants
        .firstNotNullOfOrNull { wid -> providerNames[wid]?.let { it to wid } }

    val name = displayName?.first ?: "Contact ${convo.threadId.take(8)}"
    val role = convo.participants.firstNotNullOfOrNull { wid ->
        providerNames[wid]
    }?.let { "Provider" }

    val avatarColor = when ((name.hashCode() and 0x7FFFFFFF) % 5) {
        0 -> Accent
        1 -> Blue
        2 -> Purple
        3 -> Green
        else -> Orange
    }

    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(avatarColor.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    name.take(1).uppercase(),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = avatarColor,
                )
            }

            Spacer(Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        name,
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (convo.lastTimestamp > 0) {
                        Text(
                            formatTimestamp(convo.lastTimestamp),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextSecondary,
                        )
                    }
                }
                Spacer(Modifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (role != null) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(3.dp))
                                .background(avatarColor.copy(alpha = 0.15f))
                                .padding(horizontal = 4.dp, vertical = 1.dp),
                        ) {
                            Text(
                                role,
                                style = MaterialTheme.typography.labelSmall,
                                color = avatarColor,
                            )
                        }
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        "${convo.messageCount} messages",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextSecondary,
                    )
                }
            }
        }
    }
}

/**
 * Conversation detail — shows message bubbles for a specific thread.
 * For SYSTEM_THREAD_ID, shows the local activity log instead.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberConversationScreen(
    viewModel: MemberDashboardViewModel,
    threadId: String,
    onBack: () -> Unit,
    onCompose: (() -> Unit)? = null,
) {
    // System conversation — special handling
    if (threadId == SYSTEM_THREAD_ID) {
        SystemConversationScreen(viewModel = viewModel, onBack = onBack)
        return
    }

    val messages by viewModel.messages.collectAsState()
    val providers by viewModel.providers.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.refreshMessages()
        viewModel.refreshProviders()
    }

    val providerNames = remember(providers) {
        providers.associate { it.walletId to it.displayName }
    }

    val threadMessages = remember(messages, threadId) {
        messages
            .filter { it.message.threadIdHash == threadId }
            .sortedBy { it.payload?.timestamp ?: 0L }
    }

    val otherName = remember(threadMessages, providerNames) {
        threadMessages
            .flatMap { listOf(it.message.senderWalletId, it.message.recipientWalletId) }
            .distinct()
            .firstNotNullOfOrNull { wid -> providerNames[wid] }
            ?: "Contact"
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(otherName) },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = {
                    if (onCompose != null) {
                        TextButton(onClick = onCompose) { Text("Reply") }
                    }
                },
            )
        },
    ) { padding ->
        if (threadMessages.isEmpty()) {
            Box(
                modifier = Modifier.padding(padding).fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text("No messages in this thread", color = TextSecondary)
            }
        } else {
            LazyColumn(
                modifier = Modifier.padding(padding).fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(threadMessages) { entry ->
                    MessageBubble(entry = entry, providerNames = providerNames)
                }
            }
        }
    }
}

/**
 * System conversation — read-only activity log.
 * Shows all system events (PCP assign, access grant, messages sent, etc.)
 * No reply button. Cannot compose to system.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SystemConversationScreen(
    viewModel: MemberDashboardViewModel,
    onBack: () -> Unit,
) {
    val systemEvents by viewModel.systemEvents.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("zkp.Care System") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                // No reply/compose action — read-only
            )
        },
    ) { padding ->
        if (systemEvents.isEmpty()) {
            Column(
                modifier = Modifier.padding(padding).fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "No activity yet",
                    style = MaterialTheme.typography.titleMedium,
                    color = TextSecondary,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "System events will appear here as you use the app.\nPCP assignments, access grants, messages sent,\nand other actions are logged automatically.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.padding(padding).fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item {
                    Text(
                        "Activity Log",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextSecondary,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                }
                items(systemEvents.reversed()) { event ->
                    SystemEventBubble(event)
                }
            }
        }
    }
}

@Composable
private fun SystemEventBubble(event: SystemEvent) {
    val iconColor = when (event.type) {
        "pcp_assign" -> Blue
        "access_grant" -> Green
        "message_sent" -> Accent
        "enrollment" -> Purple
        "nfc_backup" -> Orange
        else -> TextSecondary
    }
    val typeLabel = when (event.type) {
        "pcp_assign" -> "PCP Assignment"
        "access_grant" -> "Access Grant"
        "message_sent" -> "Message Sent"
        "enrollment" -> "Enrollment"
        "nfc_backup" -> "NFC Backup"
        else -> event.type
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        // Always left-aligned (system messages)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(BgHover)
                .padding(12.dp),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                // Type indicator dot
                Box(
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(iconColor),
                )
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            typeLabel,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            color = iconColor,
                        )
                        Text(
                            formatTimestamp(event.timestamp),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextMuted,
                        )
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        event.summary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (event.detail.isNotEmpty()) {
                        Text(
                            event.detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = TextSecondary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(
    entry: MessageStoreEntry,
    providerNames: Map<String, String>,
) {
    val msg = entry.message
    val payload = entry.payload
    val senderName = providerNames[msg.senderWalletId]
    val isIncoming = senderName != null
    val bubbleColor = if (isIncoming) BgHover else Accent.copy(alpha = 0.2f)

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isIncoming) Alignment.Start else Alignment.End,
    ) {
        if (isIncoming && senderName != null) {
            Text(
                senderName,
                style = MaterialTheme.typography.labelSmall,
                color = Accent,
                modifier = Modifier.padding(bottom = 2.dp, start = 4.dp),
            )
        }

        Box(
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 12.dp,
                        topEnd = 12.dp,
                        bottomStart = if (isIncoming) 4.dp else 12.dp,
                        bottomEnd = if (isIncoming) 12.dp else 4.dp,
                    ),
                )
                .background(bubbleColor)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Column {
                Text(
                    "[Encrypted message]",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextSecondary,
                )
                Text(
                    "End-to-end encrypted",
                    style = MaterialTheme.typography.labelSmall,
                    color = TextMuted,
                )
            }
        }

        if (payload != null && payload.timestamp > 0) {
            Text(
                formatTimestamp(payload.timestamp),
                style = MaterialTheme.typography.labelSmall,
                color = TextMuted,
                modifier = Modifier.padding(top = 2.dp, start = 4.dp, end = 4.dp),
            )
        }
    }
}

private fun formatTimestamp(ts: Long): String {
    val now = System.currentTimeMillis()
    val diff = now - ts
    return when {
        diff < 60_000 -> "just now"
        diff < 3_600_000 -> "${diff / 60_000}m ago"
        diff < 86_400_000 -> SimpleDateFormat("h:mm a", Locale.US).format(Date(ts))
        else -> SimpleDateFormat("MMM d, h:mm a", Locale.US).format(Date(ts))
    }
}
