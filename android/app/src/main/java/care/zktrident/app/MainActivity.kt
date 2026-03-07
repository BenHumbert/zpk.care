package care.zktrident.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.rememberNavController
import care.zktrident.app.ui.theme.ZkTridentTheme
import care.zktrident.app.viewmodel.SequencerViewModel
import care.zktrident.app.viewmodel.SseViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ZkTridentTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val navController = rememberNavController()
                    val sequencerVm: SequencerViewModel = viewModel()
                    val sseVm: SseViewModel = viewModel()

                    // FlavorApp is provided per product flavor (member, pharmacy, etc.)
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
