package care.zktrident.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.rememberNavController
import care.zktrident.app.theme.ZkTridentTheme
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

/**
 * Main entry point for all 5 zkCare app flavors.
 *
 * Each flavor provides its own FlavorApp composable via the
 * flavor-specific source set (src/member/, src/pharmacy/, etc.).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            ZkTridentTheme {
                val navController = rememberNavController()
                val sequencerVm: SequencerViewModel = viewModel()
                val sseVm: SseViewModel = viewModel()

                // Configure with default URLs from BuildConfig
                LaunchedEffect(Unit) {
                    sequencerVm.configure(BuildConfig.DEFAULT_SEQUENCER_URL)
                    if (BuildConfig.DEFAULT_SEQUENCER_URL.isNotEmpty()) {
                        sseVm.connect(BuildConfig.DEFAULT_SEQUENCER_URL)
                    }
                    sequencerVm.refreshStatus()
                }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    // FlavorApp is defined in each flavor's source set
                    FlavorApp(
                        navController = navController,
                        sequencerVm = sequencerVm,
                        sseVm = sseVm,
                    )
                }
            }
        }
    }
}
