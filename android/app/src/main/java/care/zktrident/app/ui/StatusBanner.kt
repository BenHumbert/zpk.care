package care.zktrident.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

/**
 * Connection status banner — shows at the top of the dashboard.
 * Green when connected + SSE streaming, red when disconnected.
 */
@Composable
fun StatusBanner(
    sequencerVm: SequencerViewModel,
    sseVm: SseViewModel,
    modifier: Modifier = Modifier,
) {
    val status by sequencerVm.status.collectAsState()
    val sseConnected by sseVm.connected.collectAsState()
    val error by sequencerVm.error.collectAsState()

    val connected = status != null
    val color = when {
        error != null -> MaterialTheme.colorScheme.error
        connected && sseConnected -> Color(0xFF34A853)
        connected -> Color(0xFFF9AB00)
        else -> MaterialTheme.colorScheme.outline
    }
    val label = when {
        error != null -> "Disconnected"
        connected && sseConnected -> "Live"
        connected -> "Connected (no SSE)"
        else -> "Not connected"
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.1f))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(color, shape = MaterialTheme.shapes.small),
            )
            Spacer(Modifier.width(8.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = color)
        }

        if (status != null) {
            Text(
                "H:${status!!.chainHeight} B:${status!!.batchCount}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
