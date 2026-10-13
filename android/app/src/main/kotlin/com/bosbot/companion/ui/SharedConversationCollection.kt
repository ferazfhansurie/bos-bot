package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Search and file pages use server cursors, so older retained items stay reachable. */
@Composable
internal fun SharedConversationCollection(session: Session, connectionId: String, roomId: String, mode: String, selfId: String,
    contacts: List<SharedContact>, bots: List<SharedEligibleBot>, onBack: () -> Unit,
    onMessage: (SharedChatMessage) -> Unit, onFile: (SharedAttachment) -> Unit, runtimeIdentity: Any? = null, externalError: String? = null, openingFile: Boolean = false) {
    val scope = rememberCoroutineScope()
    var requests by remember { mutableStateOf(emptyList<SharedBotRequest>()) }
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf(emptyList<SharedChatMessage>()) }
    var files by remember { mutableStateOf(emptyList<SharedFile>()) }
    var cursor by remember { mutableStateOf<Int?>(null) }
    var more by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun load(earlier: Boolean = false) { if (!busy) scope.launch { busy = true; error = null; try {
        if (mode == "requests") { val page = session.sharedRequests(roomId, if (earlier) cursor else null, connectionId, runtimeIdentity); requests = if (earlier) (requests + page.requests).distinctBy { it.id } else page.requests; cursor = page.before; more = page.hasMore }
        else if (mode == "files") { val page = session.sharedFiles(roomId, if (earlier) cursor else null, connectionId, runtimeIdentity); files = if (earlier) (files + page.files).distinctBy { it.id } else page.files; cursor = page.before; more = page.hasMore }
        else { val page = session.searchSharedMessages(roomId, query.trim(), before = if (earlier) cursor else null, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); results = if (earlier) (results + page.messages).distinctBy { it.id } else page.messages; cursor = page.before; more = page.hasMore }
    } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "Couldn't load conversation." } finally { busy = false } } }
    LaunchedEffect(connectionId, roomId, mode) { if (mode != "search") load() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(8.dp)) { HeaderBackButton(onBack); Text(localized(if (mode == "files") "Shared files" else if (mode == "requests") "Bot requests" else "Search conversation"), style = MaterialTheme.typography.titleMedium) }
        if (mode == "search") Row(Modifier.padding(12.dp)) { OutlinedTextField(query, { query = it }, Modifier.weight(1f), label = { Text(localized("Search")) }); TextButton(enabled = !busy && query.trim().isNotEmpty(), onClick = { load() }) { Text(localized("Search")) } }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp)) {
            if (mode == "requests") items(requests, key = { it.id }) { request -> Column(Modifier.padding(vertical = 8.dp)) { Text("${request.botName} · ${request.ownerName}"); Text(localized(request.stateLabel)); request.explanation?.let { Text(it, style = MaterialTheme.typography.bodySmall) }; if (request.canCancel(selfId)) TextButton(enabled = !busy, onClick = { scope.launch { busy = true; try { val updated = session.cancelSharedRequest(roomId, request.id, connectionId, runtimeIdentity); requests = requests.map { if (it.id == updated.id) updated else it } } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } finally { busy = false } } }) { Text(localized("Stop request")) } } }
            else if (mode == "files") items(files, key = { it.id }) { file -> TextButton(enabled = !openingFile, onClick = { onFile(file.attachment) }) { Column(Modifier.fillMaxWidth()) { Text(file.attachment.name); Text(AttachmentImportRules.formatBytes(file.attachment.size.toLong()), style = MaterialTheme.typography.bodySmall) } } }
            else items(results, key = { it.id }) { message -> TextButton(onClick = { onMessage(message) }) { Column(Modifier.fillMaxWidth()) { Text(contacts.firstOrNull { it.id == message.actor.id }?.name ?: bots.firstOrNull { it.id == message.actor.id }?.name ?: message.actor.localId); Text(if (message.deletedAt != null) localized("Message removed") else message.text, maxLines = 4) } } }
            item { if (more) TextButton(enabled = !busy, onClick = { load(true) }) { Text(localized("Load more")) } }
        }
        if (busy || openingFile) CircularProgressIndicator(Modifier.padding(16.dp).size(24.dp))
        (error ?: externalError)?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error); TextButton(onClick = { load() }) { Text(localized("Retry")) } }
    }
}
