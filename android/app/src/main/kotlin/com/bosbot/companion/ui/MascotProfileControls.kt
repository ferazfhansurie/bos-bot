package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotProfilePatch
import org.json.JSONArray

@Composable
internal fun MascotProfileControls(bot: Bot, busy: Boolean, onPatch: (BotProfilePatch) -> Unit) {
    ChoicePicker("Eyes", listOf("glyph", "classic", "round", "arches", "angled").map { VoiceChoice(it, it.replaceFirstChar(Char::uppercase), null, true) }, bot.mascotEyes ?: "glyph", { onPatch(BotProfilePatch(mascotEyes = it)) }, enabled = !busy)
    val colors = MausPalette.names.toList()
    colors.chunked(5).forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
        row.forEach { name -> Box(Modifier.size(44.dp).semantics { contentDescription = name; selected = name == bot.color }
            .clickable(enabled = !busy, role = Role.Button) { onPatch(BotProfilePatch(color = name)) }.padding(6.dp)
            .border(if (name == bot.color) 2.dp else 0.dp, MaterialTheme.colorScheme.onSurface, CircleShape).padding(4.dp).background(Color(MausPalette.argb(name)), CircleShape)) }
    } }
    val context = LocalContext.current
    val bodies = remember(context.applicationContext) {
        val json = JSONArray(context.assets.open("flat-mascot-bodies.json").bufferedReader().use { it.readText() })
        (0 until json.length()).map { json.getJSONObject(it) }.map { Triple(it.getString("id"), it.getString("name"), it.getString("group")) }
    }
    bodies.groupBy { it.third }.forEach { (group, members) ->
        Text(group, style = MaterialTheme.typography.titleSmall)
        members.chunked(4).forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { (id, name, _) -> Column(Modifier.weight(1f).semantics { contentDescription = name; selected = id == (bot.mascotBody ?: "cursor") }
                .clickable(enabled = !busy, role = Role.Button) { onPatch(BotProfilePatch(mascotBody = id)) }, horizontalAlignment = Alignment.CenterHorizontally) {
                GlyphAvatar(bot.color, id, 58.dp, MausState.IDLE, false, Modifier.padding(6.dp).border(if (id == (bot.mascotBody ?: "cursor")) 2.dp else 0.dp, MaterialTheme.colorScheme.outline, CircleShape), eyeStyle = bot.mascotEyes ?: "glyph")
                Text(name, style = MaterialTheme.typography.labelSmall)
            } }
            repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
        } }
    }
}
