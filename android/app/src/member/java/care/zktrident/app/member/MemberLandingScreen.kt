package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Landing screen — first thing a new user sees.
 * Two options: start enrollment or restore from NFC backup card.
 */
@Composable
fun MemberLandingScreen(
    onEnrollment: () -> Unit,
    onRestoreBackup: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            "zkTrident",
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "Member",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Zero-Knowledge Proof Claim Adjudication",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(64.dp))

        Button(
            onClick = onEnrollment,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
        ) {
            Text("New Enrollment", style = MaterialTheme.typography.titleMedium)
        }

        Spacer(Modifier.height(16.dp))

        OutlinedButton(
            onClick = onRestoreBackup,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
        ) {
            Text("Restore from Backup", style = MaterialTheme.typography.titleMedium)
        }

        Spacer(Modifier.height(24.dp))

        Text(
            "Restore requires your NFC recovery card and PIN",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}
