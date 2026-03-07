package care.zktrident.app.ui.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// zkTrident dark theme colors (matching dashboard CSS)
val BgPrimary = Color(0xFF0D1117)
val BgSecondary = Color(0xFF161B22)
val BgCard = Color(0xFF1C2128)
val BgHover = Color(0xFF21262D)
val Border = Color(0xFF30363D)
val TextPrimary = Color(0xFFE6EDF3)
val TextSecondary = Color(0xFF8B949E)
val TextMuted = Color(0xFF484F58)
val Accent = Color(0xFF00D4AA)
val AccentHover = Color(0xFF00F0C0)
val Blue = Color(0xFF58A6FF)
val Green = Color(0xFF3FB950)
val Yellow = Color(0xFFD29922)
val Red = Color(0xFFF85149)
val Orange = Color(0xFFDB6D28)
val Purple = Color(0xFFBC8CFF)

private val DarkColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = BgPrimary,
    primaryContainer = Color(0x3300D4AA),
    secondary = Blue,
    onSecondary = BgPrimary,
    background = BgPrimary,
    onBackground = TextPrimary,
    surface = BgCard,
    onSurface = TextPrimary,
    surfaceVariant = BgSecondary,
    onSurfaceVariant = TextSecondary,
    outline = Border,
    error = Red,
    onError = BgPrimary,
)

@Composable
fun ZkTridentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = Typography(),
        content = content
    )
}
