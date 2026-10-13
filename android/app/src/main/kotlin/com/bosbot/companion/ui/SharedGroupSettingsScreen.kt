package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Membership revisions and preferences are confirmed by the owning home before display changes. */
@Composable
fun SharedGroupSettingsScreen(session: Session, connectionId: String, room: SharedRoomSummary, selfId: String,
    contacts: List<SharedContact>, bots: List<SharedEligibleBot>, onBack: () -> Unit,
    onChanged: (SharedRoomSummary) -> Unit, onLeft: () -> Unit,
    onSearch: () -> Unit, onFiles: () -> Unit, onRequests: () -> Unit, runtimeIdentity: Any? = null) {
    val scope = rememberCoroutineScope()
    var current by remember(connectionId, room.id) { mutableStateOf(room) }
    var name by remember(connectionId, room.id) { mutableStateOf(room.name) }
    var replyMode by remember(connectionId, room.id) { mutableStateOf<String?>(null) }
    var preferences by remember(connectionId, room.id) { mutableStateOf<SharedConversationPreferences?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf<String?>(null) }
    val canManage = selfId == (current.createdBy ?: "${current.homeId}:person:owner") || selfId == "${current.homeId}:person:owner"
    fun action(work: suspend () -> Unit) { if (!busy) { busy = true; error = null; scope.launch { try { work() } catch (exception: CancellationException) { throw exception } catch (exception: Exception) { error = exception.message ?: "Couldn't save. Try again." } finally { busy = false } } } }
    fun members(ids: List<String>) = action {
        val updated = session.updateSharedRoom(current.id, current.revision ?: 1, memberIds = ids, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity)
        current = updated; onChanged(updated)
    }
    LaunchedEffect(connectionId, room.id) { try { preferences = session.sharedPreferences(room.id, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity) } catch (exception: CancellationException) { throw exception } catch (exception: Exception) { error = exception.message } }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) { HeaderBackButton(onBack); Text(localized("Conversation details"), style = MaterialTheme.typography.titleMedium); Spacer(Modifier.weight(1f)); if (busy) CircularProgressIndicator(Modifier.size(18.dp)) }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (current.isGroup) FormSection("Group name", if (!canManage) "Only the owner can rename the group or change members." else null) {
                OutlinedTextField(name, { name = it }, enabled = canManage && !busy, label = { Text(localized("Group name")) }, modifier = Modifier.fillMaxWidth())
                if (canManage) ActionRow("Save name", enabled = !busy && name.trim().isNotEmpty() && name.trim() != current.name) { action {
                    val updated = session.updateSharedRoom(current.id, current.revision ?: 1, name = name.trim(), expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity)
                    current = updated; name = updated.name; onChanged(updated)
                } }
            }
            FormSection("Members", "New members can see retained history and files. Removing someone stops future access; copies they already saved cannot be erased.") {
                contacts.filter { it.id in current.memberIds }.forEach { contact -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(contact.name, Modifier.weight(1f))
                    if (contact.id == (current.createdBy ?: "${current.homeId}:person:owner")) Text(localized("Owner"), style = MaterialTheme.typography.bodySmall)
                    else if (canManage && current.isGroup && contact.id != selfId) TextButton(enabled = !busy, onClick = { confirming = "remove:${contact.id}" }) { Text(localized("Remove")) }
                } }
                if (canManage && current.isGroup) contacts.filter { it.kind == "person" && it.id !in current.memberIds }.forEach { contact ->
                    ActionRow("${localized("Add")} ${contact.name}", enabled = !busy) { members(current.memberIds + contact.id) }
                }
            }
            FormSection(null) { ActionRow("Search conversation", onClick = onSearch); ActionRow("Shared files", onClick = onFiles); ActionRow("Bot requests", onClick = onRequests) }
            FormSection("Notifications") {
                ChoicePicker("Notify me", listOf(VoiceChoice("all", "All messages", null, true), VoiceChoice("mentions", "Mentions and my bot requests", null, true), VoiceChoice("muted", "Muted", null, true)), preferences?.notifications ?: "all", { selected -> action { preferences = session.sharedPreferences(current.id, notifications = selected, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity) } }, enabled = preferences != null && !busy)
            }
            if (current.isGroup) FormSection("Who replies to you", "Applies to your messages. In follow mode, mentioning a person pauses bot replies until you mention a bot again.") {
                ChoicePicker("Reply options", listOf(VoiceChoice("follow", "Follow my last @bot", null, true), VoiceChoice("fixed", "Use a chosen bot", null, true), VoiceChoice("mentions", "Only when I @mention", null, true)), replyMode ?: preferences?.replyMode ?: "follow", { selected ->
                    if (selected == "fixed" && preferences?.replyBotId.isNullOrEmpty()) { replyMode = "fixed" }
                    else action { preferences = session.sharedPreferences(current.id, replyMode = selected, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); replyMode = null }
                }, enabled = preferences != null && !busy)
                if ((replyMode ?: preferences?.replyMode) == "fixed") ChoicePicker("Reply bot", listOf(VoiceChoice("", "Choose a bot", null, false)) + bots.map { VoiceChoice(it.id, "${it.name} · ${it.ownerName ?: "Owner"}", it.availability, true) }, preferences?.replyBotId.orEmpty(), { selected -> action { preferences = session.sharedPreferences(current.id, replyMode = "fixed", replyBotId = selected, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); replyMode = null } }, enabled = preferences != null && !busy)
                Text(localized("You don’t need to add bots as members. Everyone here can see the reply. Your private bot conversations stay separate."), style = MaterialTheme.typography.bodySmall)
            }
            if (current.isGroup) FormSection(null) {
                ActionRow("Leave group", enabled = !busy, destructive = true) { confirming = "leave" }
                if (canManage) ActionRow("Delete group", enabled = !busy, destructive = true) { confirming = "delete" }
            }
            error?.let { FormSection(null) { Text(it, color = MaterialTheme.colorScheme.error); ActionRow("Retry", enabled = !busy) { action { session.sharedRooms(connectionId, runtimeIdentity).firstOrNull { it.id == current.id }?.let { current = it; name = it.name; onChanged(it) }; preferences = session.sharedPreferences(current.id, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity) } } } }
        }
    }
    confirming?.let { operation -> AlertDialog(onDismissRequest = { confirming = null }, title = { Text(localized(if (operation == "leave") "Leave group?" else if (operation == "delete") "Delete group?" else "Remove this member?")) }, text = { Text(localized(if (operation == "delete") "This removes the group and its shared conversation for everyone." else "Access to future messages and files will stop.")) },
        confirmButton = { TextButton(enabled = !busy, onClick = { confirming = null; when {
            operation.startsWith("remove:") -> members(current.memberIds - operation.removePrefix("remove:"))
            operation == "leave" -> action { session.leaveSharedRoom(current.id, current.revision ?: 1, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); onLeft() }
            else -> action { session.deleteSharedRoom(current.id, current.revision ?: 1, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); onLeft() }
        } }) { Text(localized("Confirm"), color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = { confirming = null }) { Text(localized("Cancel")) } }) }
}
