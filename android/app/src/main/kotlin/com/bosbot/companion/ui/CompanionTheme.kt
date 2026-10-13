package com.openmausbot.companion.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import org.json.JSONObject
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDirection

/**
 * The app's colours. Deliberately small: the roster and chat draw almost
 * everything from `secondary` opacities the way the SwiftUI screens draw from
 * `Color.secondary`, and the one branded colour is the mascot green the desktop
 * uses for the profile avatar.
 */
private val Green = Color(MausPalette.argb("green"))

private val LightColors = lightColorScheme(
    primary = Color(0xFF377FE6), onPrimary = Color.White,
    secondary = Color(0xFF8E8E93), onSecondary = Color.White,
    background = Color.White, surface = Color.White,
    surfaceVariant = Color(0xFFF2F2F7), surfaceContainerHigh = Color(0xFFF2F2F7),
    onSurface = Color(0xFF111111), onSurfaceVariant = Color(0xFF6C6C70),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF377FE6), onPrimary = Color.White,
    secondary = Color(0xFF8E8E93), onSecondary = Color.White,
    background = Color.Black, surface = Color.Black,
    surfaceVariant = Color(0xFF1C1C1E), surfaceContainerHigh = Color(0xFF1C1C1E),
    onSurface = Color.White, onSurfaceVariant = Color(0xFF98989E),
)

/**
 * Reading direction comes from the words, not from the locale's layout.
 *
 * Compose's default is [TextDirection.Unspecified], and — unlike the platform's
 * own `TextView`, whose default is `TEXT_DIRECTION_FIRST_STRONG` — it resolves
 * straight off `LocalLayoutDirection`: an RTL locale gives *every* paragraph an
 * RTL base level, English or not. On an `ar-EG` device that produced three
 * measured defects, all of them the same bidi reordering:
 *
 *  - trailing punctuation jumped to the front — *"What do you mostly want help
 *    with?"* drew as *"?What do you mostly want help with"*, because a neutral
 *    `?` at the end of an LTR run inside an RTL paragraph resolves to the
 *    paragraph level and is reordered to the paragraph's leading edge;
 *  - a counted list came out backwards — the bot's *"1 2 3 … 20"* drew as
 *    *"16 15 … 1"*, because digits are weak, the spaces between them resolve to
 *    R, and the whole sequence lays out right to left;
 *  - one-line roster previews lost their opening characters — *"error: CUA
 *    Driver is not ready…"* drew as *"ror: CUA Driver…"*, the line being aligned
 *    to the right and ellipsised at what the paragraph thought was its start.
 *
 * [TextDirection.ContentOrLtr] resolves the base level from the first strong
 * character instead: English stays LTR with its punctuation in place, Arabic a
 * user types stays RTL, and text with no strong character at all — a bare
 * number, a timestamp, a path — falls back to LTR rather than to the locale.
 * That last fallback is the one place this goes past `TextView`'s
 * `FIRST_STRONG` (which falls back to the layout direction), and it is what
 * fixes the counted list.
 *
 * It is a choice about this product, not a fact about text, and it has a price:
 * a paragraph with no strong character is anchored LTR even when an Arabic user
 * typed it — Arabic-Indic digits, an emoji-only line, bare punctuation from the
 * composer. The choice is made for what this app actually carries: counts,
 * clock times, file paths, code and command output, read left to right whoever
 * is holding the phone. If the app ever ships an RTL translation, or grows text
 * where a neutral line should follow the reader rather than the content, this
 * is the line to come back to.
 *
 * This is only about the direction glyphs are *ordered* in. Where the box sits
 * is untouched: `Row`/`Column`, `padding(start=)`, `placeRelative` and the
 * auto-mirrored icons all keep reading `LocalLayoutDirection`, so the chrome,
 * the bubble sides and the table's mirrored columns still follow the locale.
 *
 * It is set on the theme's [Typography] rather than at every call site, so it
 * reaches whatever Compose draws under this theme — the message bubbles, the
 * roster previews, the labels — by way of `LocalTextStyle` and the
 * `MaterialTheme.typography` slots, with nothing new to remember at the next
 * call site.
 *
 * Its reach ends where the theme does. Notifications are drawn by SystemUI in
 * its own window, from strings that never pass through a Compose typography, so
 * the same policy has to be carried there inside the string itself — see
 * `notifications.NotificationText`, which anchors each notification paragraph
 * that would otherwise take the shade's base direction.
 */
private fun TextStyle.readingFromContent(): TextStyle =
    copy(textDirection = TextDirection.ContentOrLtr)

private val ContentDirectedTypography: Typography = Typography().run {
    copy(
        displayLarge = displayLarge.readingFromContent(),
        displayMedium = displayMedium.readingFromContent(),
        displaySmall = displaySmall.readingFromContent(),
        headlineLarge = headlineLarge.readingFromContent(),
        headlineMedium = headlineMedium.readingFromContent(),
        headlineSmall = headlineSmall.readingFromContent(),
        titleLarge = titleLarge.readingFromContent(),
        titleMedium = titleMedium.readingFromContent(),
        titleSmall = titleSmall.readingFromContent(),
        bodyLarge = bodyLarge.readingFromContent(),
        bodyMedium = bodyMedium.readingFromContent(),
        bodySmall = bodySmall.readingFromContent(),
        labelLarge = labelLarge.readingFromContent(),
        labelMedium = labelMedium.readingFromContent(),
        labelSmall = labelSmall.readingFromContent(),
    )
}

internal val LocalThemeName = androidx.compose.runtime.staticCompositionLocalOf { "midnight" }

@Composable
fun CompanionTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    theme: String = "midnight",
    brightness: String = "system",
    content: @Composable () -> Unit,
) {
    val resolvedDark = when (brightness) { "light" -> false; "dark" -> true; else -> darkTheme }
    androidx.compose.runtime.CompositionLocalProvider(LocalThemeName provides theme) {
    MaterialTheme(
        colorScheme = themedColorScheme(resolvedDark, theme),
        typography = ContentDirectedTypography,
        content = content,
    )
    }
}

/** SwiftUI's `Color.secondary` — the muted foreground everything quiet uses. */
val secondaryTint: Color
    @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data

@Composable
private fun themedColorScheme(dark: Boolean, theme: String): androidx.compose.material3.ColorScheme {
    val context = LocalContext.current
    val table = remember { JSONObject(context.assets.open("theme-palettes.json").bufferedReader().use { it.readText() }) }
    val base = if (dark) DarkColors else LightColors
    val palette = table.optJSONObject(theme)?.optJSONObject(if (dark) "dark" else "light") ?: return base
    fun paint(key: String) = Color(android.graphics.Color.parseColor(palette.getString(key)))
    return base.copy(background = paint("app"), surface = paint("app"), surfaceVariant = paint("panel"),
        surfaceContainerHigh = paint("raised"), primary = paint("accent"))
}
