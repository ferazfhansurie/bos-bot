package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.util.Locale

internal val themeNames = linkedMapOf("midnight" to "Classic", "pink" to "Sakura", "atelier" to "Atelier",
    "foundry" to "Foundry", "lagoon" to "Lagoon", "graphite" to "Graphite", "linen" to "Linen",
    "dusk" to "Dusk", "matcha" to "Matcha", "sunset" to "Sunset")

internal val LocalInterfaceLanguage = androidx.compose.runtime.staticCompositionLocalOf { "system" }

/** Static interface strings only; transcripts and user labels never enter this table. */
@Composable
internal fun localized(value: String): String {
    val language = LocalInterfaceLanguage.current
    val context = LocalContext.current
    val table = remember { JSONObject(context.assets.open("strings-pt-BR.json").bufferedReader().use { it.readText() }) }
    val resolved = if (language == "system") Locale.getDefault().toLanguageTag() else language
    return if (resolved.startsWith("pt", ignoreCase = true)) table.optString(value, value) else value
}

@Composable
fun AppearanceScreen(onBack: () -> Unit) {
    val prefs = LocalCompanion.current.chatPreferences
    val theme by prefs.theme.collectAsState()
    val brightness by prefs.brightness.collectAsState()
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            HeaderBackButton(onBack)
            Text(localized("Appearance"), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(localized("Make BOS yours."), fontWeight = FontWeight.Bold, fontSize = 28.sp)
            Text(localized("Pick a theme, then how bright you want it."), color = secondaryTint)
            Text(localized("Theme"), fontWeight = FontWeight.SemiBold)
            themeNames.entries.chunked(2).forEach { pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    pair.forEach { (id, name) ->
                        Column(Modifier.weight(1f).border(if (theme == id) 2.dp else 1.dp,
                            if (theme == id) MaterialTheme.colorScheme.primary else secondaryTint.copy(alpha = .18f), RoundedCornerShape(20.dp))
                            .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(20.dp))
                            .semantics { selected = theme == id }
                            .clickable(role = Role.RadioButton) { prefs.setTheme(id) }.padding(18.dp),
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            GlyphAvatar("green", null, 38.dp, MausState.IDLE, false, Modifier)
                            Text(localized(name), fontWeight = if (theme == id) FontWeight.Bold else FontWeight.Normal)
                        }
                    }
                }
            }
            Text(localized("Brightness"), fontWeight = FontWeight.SemiBold)
            Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape)) {
                listOf("system" to "Automatic", "light" to "Light", "dark" to "Dark").forEach { (id, title) ->
                    Text(localized(title), modifier = Modifier.weight(1f).semantics { selected = brightness == id }
                        .background(if (brightness == id) MaterialTheme.colorScheme.primary.copy(alpha = .14f) else Color.Transparent, CircleShape)
                        .clickable(role = Role.RadioButton) { prefs.setBrightness(id) }.padding(horizontal = 10.dp, vertical = 16.dp))
                }
            }
        }
    }
}
