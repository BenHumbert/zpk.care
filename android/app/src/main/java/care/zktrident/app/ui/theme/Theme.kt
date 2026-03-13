package care.zktrident.app.ui.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import care.zktrident.app.BuildConfig

// zkTrident dark theme — shared foundation (matching dashboard CSS)
val BgPrimary = Color(0xFF0D1117)
val BgSecondary = Color(0xFF161B22)
val BgCard = Color(0xFF1C2128)
val BgHover = Color(0xFF21262D)
val Border = Color(0xFF30363D)
val TextPrimary = Color(0xFFE6EDF3)
val TextSecondary = Color(0xFF8B949E)
val TextMuted = Color(0xFF484F58)
val Green = Color(0xFF3FB950)
val Yellow = Color(0xFFD29922)
val Red = Color(0xFFF85149)
val Orange = Color(0xFFDB6D28)
val Purple = Color(0xFFBC8CFF)

// Role-specific accent colors
val MemberAccent = Color(0xFF00D4AA)       // Teal — patient/individual
val MemberAccentHover = Color(0xFF2EEBC4)
val PrescriberAccent = Color(0xFF818CF8)   // Indigo — clinical authority
val PrescriberAccentHover = Color(0xFFA5B4FC)
val PharmacyAccent = Color(0xFFF59E0B)     // Amber — operational/action
val PharmacyAccentHover = Color(0xFFFBBF24)
val InsurerAccent = Color(0xFF60A5FA)      // Blue — institutional trust
val InsurerAccentHover = Color(0xFF93C5FD)
val EmployerAccent = Color(0xFF34D399)     // Emerald — organizational health
val EmployerAccentHover = Color(0xFF6EE7B7)

// Resolve accent from build flavor
val Accent: Color get() = when (BuildConfig.ROLE) {
    "prescriber" -> PrescriberAccent
    "pharmacy" -> PharmacyAccent
    "insurer" -> InsurerAccent
    "employer" -> EmployerAccent
    else -> MemberAccent  // member is the default/brand signature
}

val AccentHover: Color get() = when (BuildConfig.ROLE) {
    "prescriber" -> PrescriberAccentHover
    "pharmacy" -> PharmacyAccentHover
    "insurer" -> InsurerAccentHover
    "employer" -> EmployerAccentHover
    else -> MemberAccentHover
}

val Blue = Color(0xFF58A6FF)

private fun buildColorScheme(): ColorScheme {
    val accent = Accent
    return darkColorScheme(
        primary = accent,
        onPrimary = BgPrimary,
        primaryContainer = accent.copy(alpha = 0.2f),
        secondary = Color(0xFF58A6FF),
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
}

@Composable
fun ZkTridentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = buildColorScheme(),
        typography = Typography(),
        content = content
    )
}
