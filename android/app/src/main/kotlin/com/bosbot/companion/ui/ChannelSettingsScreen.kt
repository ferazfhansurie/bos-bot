package com.openmausbot.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Local room settings stay bound to the computer on which the sheet opened. */
@Composable
fun ChannelSettingsScreen(roomId: String, onClose: () -> Unit) {
    val session = LocalCompanion.current.session
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val source = remember(session, roomId) { session.connection.value?.id }
    val room = state.rooms.firstOrNull { it.id == roomId }
    var name by remember(roomId) { mutableStateOf(room?.name.orEmpty()) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var removingBot by remember { mutableStateOf<Bot?>(null) }
    var removingPerson by remember { mutableStateOf<String?>(null) }
    var invite by remember { mutableStateOf<String?>(null) }
    var grants by remember { mutableStateOf<List<String>?>(null) }
    var roomHomeId by remember { mutableStateOf<String?>(null) }
    var contacts by remember { mutableStateOf<List<SharedContact>>(emptyList()) }
    var addingPerson by remember { mutableStateOf(false) }
    val canManage = session.canAdminister && room?.home == null && source != null && connection?.id == source
    LaunchedEffect(connection?.id) { if (connection?.id != source) onClose() }
    fun runAction(block: suspend () -> Unit) {
        if (saving || !canManage || source == null) return
        saving = true; error = null
        scope.launch { try { block() } catch (failure: Exception) { if (failure is kotlinx.coroutines.CancellationException) throw failure; error = failure.message ?: "Couldn't save. Try again." } finally { saving = false } }
    }
    fun patch(field: String, value: JsonElement) = runAction { session.updateRoomSettings(roomId, buildJsonObject { put(field, value) }, source!!) }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) runAction {
            val photo = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                context.contentResolver.openInputStream(uri)?.use { readRoomPhoto(it, AttachmentPolicy.MAXIMUM_IMAGE_BYTES) } ?: error("Couldn't read the photo.")
            }
            session.uploadRoomPhoto(roomId, photo, context.contentResolver.getType(uri) ?: "image/jpeg", source!!)
        }
    }
    LaunchedEffect(roomId, source) {
        if (canManage && source != null) {
            roomHomeId = runCatching { session.sharedMe(source)?.homeId }.getOrNull()
            grants = runCatching { session.roomBotGrants(roomId, source) }.getOrNull()
            contacts = runCatching { session.sharedContacts(source) }.getOrDefault(emptyList())
        }
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(12.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) { HeaderBackButton(onClose); Text(localized("Group settings"), style = MaterialTheme.typography.titleMedium) }
        if (room == null) { ConversationSkeleton(); return@Column }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            ChatAvatar(Chat.RoomChat(room), 72.dp)
            if (canManage) {
                TextButton(enabled = !saving, onClick = { photoPicker.launch("image/*") }) { Text(localized("Choose group photo")) }
                if (room.avatarUrl != null) TextButton(enabled = !saving, onClick = { patch("avatarUrl", JsonNull) }) { Text(localized("Remove group photo")) }
            }
            OutlinedTextField(name, { name = it }, label = { Text(localized("Group name")) }, enabled = canManage && !saving, modifier = Modifier.fillMaxWidth())
            TextButton(enabled = canManage && !saving && name.trim().isNotEmpty() && name.trim() != room.name, onClick = { patch("name", JsonPrimitive(name.trim())) }) { Text(localized("Save name")) }
            if (room.dm != true) {
                Text(localized("Members"), style = MaterialTheme.typography.titleMedium)
                state.bots.filter { it.id in room.memberIds }.forEach { bot ->
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        BotAvatar(bot, 32.dp); Text(bot.name, Modifier.weight(1f).padding(start = 10.dp))
                        if (canManage && room.memberIds.size > 1) TextButton(enabled = !saving, onClick = { removingBot = bot }) { Text(localized("Remove")) }
                    }
                    if (canManage) Row {
                        listOf("always" to "Always", "mentions" to "Only when tagged").forEach { (mode, title) ->
                            FilterChip(selected = (room.memberReplyModes?.get(bot.id) ?: if (room.defaultResponder.botId == bot.id) "always" else "mentions") == mode,
                                enabled = !saving, onClick = {
                                    val modes = room.memberReplyModes.orEmpty() + (bot.id to mode)
                                    patch("memberReplyModes", JsonObject(modes.mapValues { JsonPrimitive(it.value) }))
                                }, label = { Text(localized(title)) })
                        }
                    }
                }
                Text(localized("Removing a bot stops future participation. The conversation history stays here."), style = MaterialTheme.typography.bodySmall)
                if (room.people != null || room.peopleIds != null) {
                    Text(localized("People"), style = MaterialTheme.typography.titleMedium)
                    val people = room.people.orEmpty()
                    room.peopleIds.orEmpty().ifEmpty { people.map { it.id } }.forEach { personId ->
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Text(people.firstOrNull { it.id == personId }?.name ?: personId, Modifier.weight(1f))
                            if (canManage && personId != (room.peopleIds?.firstOrNull() ?: people.firstOrNull()?.id)) TextButton(enabled = !saving, onClick = { removingPerson = personId }) { Text(localized("Remove")) }
                        }
                    }
                    if (canManage) {
                        val present = room.peopleIds.orEmpty().ifEmpty { people.map { it.id } }.toSet()
                        val addable = contacts.filter { it.kind == "person" && it.id !in present }
                        if (addable.isNotEmpty()) Box {
                            TextButton(enabled = !saving, onClick = { addingPerson = true }) { Text(localized("Add person")) }
                            DropdownMenu(expanded = addingPerson, onDismissRequest = { addingPerson = false }) {
                                addable.forEach { person -> DropdownMenuItem(text = { Text(person.name) }, onClick = { addingPerson = false; runAction { session.addRoomPerson(roomId, person.id, source!!) } }) }
                            }
                        }
                        TextButton(enabled = !saving, onClick = { runAction { invite = session.createRoomInvite(listOf(roomId), source!!).url } }) { Text(localized("Create invite link")) }
                        invite?.let { url -> TextButton(onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(android.content.ClipData.newPlainText("BOS room invite", url))) } }) { Text(localized("Copy invite link")) } }
                        grants?.let { allowed ->
                            Text(localized("Bots that answer people"), style = MaterialTheme.typography.titleMedium)
                            state.bots.filter { it.id in room.memberIds }.forEach { bot ->
                                val homeId = roomHomeId
                                if (homeId != null) {
                                    val id = "$homeId:bot:${bot.id}"
                                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                        Text(bot.name, Modifier.weight(1f))
                                        Switch(id in allowed, enabled = !saving, onCheckedChange = { on -> runAction { grants = session.setRoomBotGrants(roomId, if (on) allowed + id else allowed - id, source!!) } })
                                    }
                                }
                            }
                        }
                    }
                    Text(localized("People see this room's conversation. Bots only answer them where allowed below."), style = MaterialTheme.typography.bodySmall)
                }
            }
            if (canManage) {
                Text(localized("Notifications"), style = MaterialTheme.typography.titleMedium)
                listOf("all" to "All messages", "mentions" to "Mentions only", "muted" to "Muted").forEach { (value, title) ->
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        RadioButton(selected = (room.notifications ?: "all") == value, enabled = !saving, onClick = { patch("notifications", JsonPrimitive(value)) })
                        Text(localized(title))
                    }
                }
            }
            if (saving) CircularProgressIndicator(Modifier.size(20.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
    removingBot?.let { bot -> AlertDialog(onDismissRequest = { removingBot = null }, title = { Text(localized("Remove ${bot.name}?")) }, text = { Text(localized("The conversation history stays here.")) }, confirmButton = { TextButton(onClick = { removingBot = null; patch("memberIds", JsonArray(room!!.memberIds.filterNot { it == bot.id }.map(::JsonPrimitive))) }) { Text(localized("Remove")) } }, dismissButton = { TextButton(onClick = { removingBot = null }) { Text(localized("Cancel")) } }) }
    removingPerson?.let { id -> AlertDialog(onDismissRequest = { removingPerson = null }, title = { Text(localized("Remove person?")) }, confirmButton = { TextButton(onClick = { removingPerson = null; runAction { session.removeRoomPerson(roomId, id, source!!) } }) { Text(localized("Remove")) } }, dismissButton = { TextButton(onClick = { removingPerson = null }) { Text(localized("Cancel")) } }) }
}

private fun readRoomPhoto(input: java.io.InputStream, limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size().toLong() + n <= limit) { "The photo is too large." }; output.write(buffer, 0, n) }
    return output.toByteArray()
}
