package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private data class SharedRosterEntry(val key: String, val name: String, val room: SharedRoomSummary?, val person: SharedContact?)

/** Group rows and pinned tiles remain visible when the separate people section is folded. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun SharedRosterPanel(session: Session, connectionId: String, homeLabel: String? = null,
    onOpen: (SharedRoomSummary, String, List<SharedContact>) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val layout = remember(context) { context.getSharedPreferences("shared-roster-layout", android.content.Context.MODE_PRIVATE) }
    var runtimeIdentity by remember(session, connectionId) { mutableStateOf(runCatching { session.sharedRuntimeIdentity(connectionId) }.getOrNull()) }
    val runtimeRevision by session.sharedRuntimeRevision.collectAsState()
    @Suppress("UNUSED_VARIABLE") val observedRevision = runtimeRevision
    val runtimeValid = runtimeIdentity == null || runCatching { session.sharedRuntimeIdentity(connectionId) === runtimeIdentity }.getOrDefault(false)
    var expanded by remember(connectionId) { mutableStateOf(false) }
    var roster by remember(connectionId) { mutableStateOf<SharedRoster?>(null) }
    var loading by remember(connectionId) { mutableStateOf(false) }
    var error by remember(connectionId) { mutableStateOf<String?>(null) }
    var creating by remember(connectionId) { mutableStateOf(false) }
    var name by remember(connectionId) { mutableStateOf("") }
    var selected by remember(connectionId) { mutableStateOf(emptySet<String>()) }
    var menu by remember(connectionId) { mutableStateOf<SharedRosterEntry?>(null) }
    var showingHidden by remember(connectionId) { mutableStateOf(false) }
    val actor = roster?.me?.actorId
    val layoutKey = "$connectionId.$actor"
    var pins by remember(layoutKey) { mutableStateOf(layout.getStringSet("$layoutKey.pins", emptySet()).orEmpty().toSet()) }
    var hidden by remember(layoutKey) { mutableStateOf(layout.getStringSet("$layoutKey.hidden", emptySet()).orEmpty().toSet()) }
    fun load() { if (!loading) scope.launch { loading = true; error = null; try {
        if (runtimeIdentity == null) runtimeIdentity = session.sharedRuntimeIdentity(connectionId)
        roster = session.sharedRoster(connectionId, runtimeIdentity)
    } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "Couldn't load people." } finally { loading = false } } }
    LaunchedEffect(connectionId) { load() }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (!runtimeValid) {
            Text(localized("This computer’s sign-in changed. Reopen people."))
            TextButton(onClick = { roster = null; runtimeIdentity = null; menu = null; load() }) { Text(localized("Refresh")) }
        } else roster?.let { data ->
            val selfId = data.me.actorId
            if (selfId == null) { Text(localized("Multiplayer is unavailable on this computer.")); return@let }
            val groups = data.rooms.filter { it.isGroup }.map { SharedRosterEntry("room:${it.id}", it.displayName(data.contacts, selfId), it, null) }
            val people = data.contacts.filter { it.kind == "person" && it.id != selfId }.map { contact ->
                SharedRosterEntry("person:${contact.id}", contact.name, data.rooms.firstOrNull { !it.isGroup && contact.id in it.memberIds }, contact)
            }
            val entries = groups + people
            fun open(entry: SharedRosterEntry) {
                if (entry.room != null) onOpen(entry.room, selfId, data.contacts)
                else scope.launch { loading = true; error = null; try {
                    val room = session.openSharedDM(requireNotNull(entry.person).id, connectionId, runtimeIdentity)
                    onOpen(room, selfId, data.contacts)
                } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } finally { loading = false } }
            }
            val pinned = entries.filter { it.key in pins && it.key !in hidden }
            if (pinned.isNotEmpty()) Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                pinned.chunked(3).forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    row.forEach { entry -> Column(Modifier.weight(1f).combinedClickable(enabled = !loading, onClick = { open(entry) }, onLongClick = { menu = entry }), horizontalAlignment = Alignment.CenterHorizontally) {
                        SharedRosterMark(entry.name, entry.room?.isGroup == true, 72)
                        Text(entry.name, maxLines = 1, style = MaterialTheme.typography.labelLarge)
                        if ((entry.room?.unreadCount ?: 0) > 0) Text(entry.room?.unreadCount.toString(), color = MaterialTheme.colorScheme.primary)
                    } }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                } }
            }
            groups.filter { it.key !in pins && it.key !in hidden }.forEach { entry -> SharedRosterRow(entry.name, entry.room, homeLabel, !loading, { open(entry) }, { menu = entry }) }
            val foldedPeople = people.filter { it.key !in pins && it.key !in hidden }
            val unread = foldedPeople.count { (it.room?.unreadCount ?: 0) > 0 }
            Row(Modifier.fillMaxWidth().semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                .combinedClickable(role = Role.Button, onClick = { expanded = !expanded }, onLongClick = {}).padding(vertical = 12.dp)) {
                Text(localized("People") + " · ${people.size}" + (homeLabel?.let { " · $it" } ?: ""), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                if (!expanded && unread > 0) Text(unread.toString(), color = MaterialTheme.colorScheme.primary)
                Text(if (expanded) "−" else "+")
            }
            if (expanded) foldedPeople.forEach { entry -> SharedRosterRow(entry.name, entry.room, null, !loading, { open(entry) }, { menu = entry }) }
            if (entries.any { it.key in hidden }) {
                TextButton(onClick = { showingHidden = !showingHidden }) { Text(localized(if (showingHidden) "Hide hidden chats" else "Show hidden chats")) }
                if (showingHidden) entries.filter { it.key in hidden }.forEach { entry -> SharedRosterRow(entry.name, entry.room, homeLabel, !loading, { open(entry) }, { menu = entry }) }
            }
            if (expanded) {
                if (people.isEmpty()) Text(localized("No people yet"), style = MaterialTheme.typography.bodySmall)
                TextButton(enabled = !loading, onClick = { creating = true }) { Text(localized("New group")) }
                TextButton(enabled = !loading, onClick = ::load) { Text(localized("Refresh")) }
            }
            menu?.let { entry -> AlertDialog(onDismissRequest = { menu = null }, title = { Text(entry.name) }, text = { Column {
                TextButton(onClick = { pins = if (entry.key in pins) pins - entry.key else pins + entry.key; layout.edit().putStringSet("$layoutKey.pins", pins).commit(); menu = null }) { Text(localized(if (entry.key in pins) "Unpin chat" else "Pin chat")) }
                TextButton(onClick = { hidden = if (entry.key in hidden) hidden - entry.key else hidden + entry.key; layout.edit().putStringSet("$layoutKey.hidden", hidden).commit(); menu = null }) { Text(localized(if (entry.key in hidden) "Show chat" else "Hide chat")) }
            } }, confirmButton = { TextButton(onClick = { menu = null }) { Text(localized("Done")) } }) }
            if (creating) AlertDialog(onDismissRequest = { if (!loading) creating = false }, title = { Text(localized("New group")) }, text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    OutlinedTextField(name, { name = it }, label = { Text(localized("Group name")) })
                    people.forEach { entry -> val contact = requireNotNull(entry.person); Row { Checkbox(contact.id in selected, { selected = if (it) selected + contact.id else selected - contact.id }); Text(contact.name, Modifier.padding(top = 12.dp)) } }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }, confirmButton = { TextButton(enabled = !loading && name.trim().isNotEmpty() && selected.isNotEmpty(), onClick = {
                scope.launch { loading = true; error = null; try { val room = session.createSharedRoom(name.trim(), (selected + selfId).sorted(), connectionId, runtimeIdentity); creating = false; onOpen(room, selfId, data.contacts) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } finally { loading = false } }
            }) { Text(localized("Create")) } }, dismissButton = { TextButton(enabled = !loading, onClick = { creating = false }) { Text(localized("Cancel")) } })
        }
        if (loading) CircularProgressIndicator(Modifier.size(22.dp))
        error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = ::load) { Text(localized("Retry")) } }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun SharedRosterRow(name: String, room: SharedRoomSummary?, homeLabel: String?, enabled: Boolean, onOpen: () -> Unit, onMenu: () -> Unit) {
    Row(Modifier.fillMaxWidth().combinedClickable(enabled = enabled, onClick = onOpen, onLongClick = onMenu).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        SharedRosterMark(name, room?.isGroup == true, 48)
        Column(Modifier.weight(1f).padding(start = 12.dp)) { Text(name, style = MaterialTheme.typography.titleSmall); Text(room?.preview?.takeIf { it.isNotBlank() } ?: localized("No messages yet"), maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); homeLabel?.let { Text(it, style = MaterialTheme.typography.labelSmall) } }
        if ((room?.unreadCount ?: 0) > 0) Text(room?.unreadCount.toString(), color = MaterialTheme.colorScheme.primary)
    }
}
@Composable
private fun SharedRosterMark(name: String, group: Boolean, size: Int) {
    Box(Modifier.size(size.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape), contentAlignment = Alignment.Center) {
        Text(if (group) name.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1).uppercase() } else name.take(1).uppercase(), style = MaterialTheme.typography.titleLarge)
    }
}
