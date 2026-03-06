package care.zktrident.app.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val ZkTridentColors = lightColorScheme(
    primary = Color(0xFF1A73E8),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD2E3FC),
    secondary = Color(0xFF34A853),
    onSecondary = Color.White,
    tertiary = Color(0xFFF9AB00),
    background = Color(0xFFF8F9FA),
    surface = Color.White,
    onBackground = Color(0xFF202124),
    onSurface = Color(0xFF202124),
    error = Color(0xFFEA4335),
    outline = Color(0xFFDADCE0),
)

@Composable
fun ZkTridentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ZkTridentColors,
        typography = Typography(),
        content = content,
    )
}

/** Role-specific accent colors */
object RoleColors {
    val member = Color(0xFF1A73E8)       // Blue
    val pharmacy = Color(0xFF34A853)     // Green
    val prescriber = Color(0xFF9334E6)   // Purple
    val insurer = Color(0xFFE8710A)      // Orange
    val employer = Color(0xFF185ABC)     // Dark blue
}
