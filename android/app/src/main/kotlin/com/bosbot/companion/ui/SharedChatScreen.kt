package com.openmausbot.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.core.*
import kotlinx.coroutines.*

/** A conversation is scoped to its original paired home for its entire lifetime. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun SharedChatScreen(session: Session, connectionId: String, room: SharedRoomSummary, selfId: String,
    contacts: List<SharedContact>, onBack: () -> Unit, onRoomChanged: (SharedRoomSummary) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val runtimeCapture = remember(session, connectionId, selfId) { runCatching { session.sharedRuntimeIdentity(connectionId) } }
    val runtimeIdentity = runtimeCapture.getOrNull()
    val runtimeRevision by session.sharedRuntimeRevision.collectAsState()
    val runtimeValid = runtimeIdentity != null && runCatching { session.sharedRuntimeIdentity(connectionId) === runtimeIdentity }.getOrDefault(false)
    var actorVerified by remember(runtimeIdentity) { mutableStateOf(false) }
    var actorError by remember(runtimeIdentity) { mutableStateOf<String?>(null) }
    var validationRetry by remember { mutableStateOf(0) }
    LaunchedEffect(runtimeIdentity, runtimeRevision, validationRetry) { actorVerified = false; actorError = null; if (runtimeValid && runtimeIdentity != null) try { actorVerified = session.validateSharedActor(connectionId, selfId, runtimeIdentity); if (!actorVerified) actorError = "The signed-in person changed. Reopen this conversation." } catch (e: CancellationException) { throw e } catch (e: Exception) { actorError = e.message } }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val lifecycle = lifecycleOwner.lifecycle
    val dictation = LocalCompanion.current.dictation
    val listening by dictation.isListening.collectAsState()
    val starting by dictation.isStarting.collectAsState()
    val dictationError by dictation.error.collectAsState()
    LaunchedEffect(runtimeValid) { if (!runtimeValid) dictation.stop() }
    DisposableEffect(dictation, lifecycleOwner) { dictation.bind(lifecycleOwner); onDispose { dictation.stop(); dictation.unbind(lifecycleOwner) } }
    var active by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle) { val observer = LifecycleEventObserver { _, _ -> active = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }; lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) } }
    var current by remember(connectionId, room.id) { mutableStateOf(room) }
    var messages by remember(connectionId, room.id) { mutableStateOf(emptyList<SharedChatMessage>()) }
    var bots by remember(connectionId, room.id) { mutableStateOf(emptyList<SharedEligibleBot>()) }
    var version by remember { mutableStateOf(0) }
    var loaded by remember { mutableStateOf(false) }
    var restoring by remember { mutableStateOf(true) }
    var older by remember { mutableStateOf(false) }
    var hasMore by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var preparing by remember { mutableStateOf(false) }
    var openingFile by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    val draftStore = remember(connectionId, room.id, selfId) { SharedDraftStore(context.filesDir, connectionId, room.id, selfId) }
    val restoration = remember(draftStore) { runCatching { draftStore.restore() } }
    val saved = remember(draftStore) { restoration.getOrElse { SharedDraftCheckpoint() } }
    var storageError by remember(draftStore) { mutableStateOf(restoration.exceptionOrNull()?.message) }
    var recoveryBlocked by remember(draftStore) { mutableStateOf(restoration.isFailure) }
    var discarding by remember { mutableStateOf(false) }
    var typedText by remember(draftStore) { mutableStateOf(saved.typedText) }
    var text by remember(draftStore) { mutableStateOf(saved.delivery?.text?.takeUnless { saved.editedSinceDelivery } ?: saved.typedText) }
    var pending by remember(draftStore) { mutableStateOf(draftStore.pending(saved)) }
    var editedSinceDelivery by remember(draftStore) { mutableStateOf(saved.editedSinceDelivery) }
    var savedReplyTo by remember(draftStore) { mutableStateOf(saved.replyTo) }
    var reply by remember { mutableStateOf<SharedChatMessage?>(null) }
    var selected by remember { mutableStateOf<SharedChatMessage?>(null) }
    var editing by remember { mutableStateOf<SharedChatMessage?>(null) }
    var editedText by remember { mutableStateOf("") }
    var removing by remember { mutableStateOf<SharedChatMessage?>(null) }
    var typing by remember { mutableStateOf(emptyList<String>()) }
    var preferences by remember { mutableStateOf<SharedConversationPreferences?>(null) }
    var page by remember { mutableStateOf("chat") }
    var choosingAttachment by remember { mutableStateOf(false) }
    LaunchedEffect(page) { if (page != "chat") dictation.stop() }
    LaunchedEffect(dictation) { var first = true; dictation.transcript.collect { next -> if (first) first = false else text = Dictation.draft(dictation.base, next) } }
    var failedDraft by remember { mutableStateOf(saved.delivery) }
    var previousSendId by remember { mutableStateOf(saved.sendId) }
    val uploaded = remember(connectionId, room.id) { saved.uploaded.toMutableMap() }
    fun checkpoint() { try { check(!recoveryBlocked) { "The saved draft must be recovered or explicitly discarded first." }; draftStore.save(SharedDraftCheckpoint(typedText, draftStore.records(pending), savedReplyTo, failedDraft, previousSendId, uploaded.toMap(), editedSinceDelivery)); storageError = null } catch (e: Exception) { storageError = e.message ?: "Couldn't save the draft."; throw e } }
    LaunchedEffect(messages, savedReplyTo) { if (savedReplyTo != null) reply = messages.firstOrNull { it.id == savedReplyTo } }
    val list = rememberLazyListState()
    val visible = SharedChatMessage.visible(messages)
    val atBottom by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index == list.layoutInfo.totalItemsCount - 1 } }
    val previews = remember(context, connectionId, room.id) { FilePreviews(context) }
    var preview by remember { mutableStateOf<FilePreviewItem?>(null) }
    val readingStore = remember(context) { context.getSharedPreferences("shared-reading", android.content.Context.MODE_PRIVATE) }
    val readingKey = "$connectionId.${room.id}.$selfId"
    fun merge(values: List<SharedChatMessage>) { messages = (messages.associateBy { it.id } + values.associateBy { it.id }).values.sortedBy { it.sequence } }
    fun action(work: suspend () -> Unit) { scope.launch { error = null; try { work() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "Couldn't complete that action." } } }
    suspend fun refresh(initial: Boolean = false) {
        val following = loaded && atBottom && page == "chat" && !older
        val result = session.sharedMessagePage(room.id, after = if (initial) 0 else messages.maxOfOrNull { it.sequence } ?: 0, version = version, latest = initial, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity)
        merge(result.messages + result.changes.orEmpty()); version = result.version ?: version; typing = result.typing.orEmpty().filter { it != selfId }
        if (initial) hasMore = result.hasMore == true
        loaded = true
        if (following && result.messages.isNotEmpty()) list.scrollToItem(SharedChatMessage.visible(messages).size)
    }
    fun openFile(attachment: SharedAttachment) = action {
        openingFile = true
        try {
            val generation = previews.beginRequest()
            val download = session.sharedAttachment(room.id, attachment.id, connectionId, runtimeIdentity)
            val safeName = FilePreviewRules.nameForOpening(download.attachment.name).takeIf { it.isNotBlank() && it != "." && it != ".." } ?: "Attachment"
            preview = previews.store(DownloadedFile(download.bytes(), safeName, download.attachment.mime), generation)
        } finally { openingFile = false }
    }
    LaunchedEffect(connectionId, room.id, active, retry, actorVerified) {
        if (!active || !actorVerified || !runtimeValid) return@LaunchedEffect
        try {
            if (!loaded) {
                bots = try { session.sharedBots(room.id, connectionId, runtimeIdentity) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptyList() }
                preferences = session.sharedPreferences(room.id, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity)
                refresh(true)
                val anchor = readingStore.getString(readingKey, null)
                if (anchor != null) {
                    var count = 0
                    while (messages.none { it.id == anchor } && hasMore && count++ < 20) {
                        val result = session.sharedMessagePage(room.id, before = messages.firstOrNull()?.sequence, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity)
                        merge(result.messages); hasMore = result.hasMore == true
                    }
                    val index = SharedChatMessage.visible(messages).indexOfFirst { it.id == anchor }
                    if (index >= 0) list.scrollToItem(index + 1) else if (messages.isNotEmpty()) list.scrollToItem(SharedChatMessage.visible(messages).size)
                } else if (messages.isNotEmpty()) list.scrollToItem(SharedChatMessage.visible(messages).size)
            }
            restoring = false
            while (isActive) { refresh(); delay(2_000) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "Couldn't load conversation." }
    }
    LaunchedEffect(active, atBottom, messages.lastOrNull()?.sequence, page, older, restoring, preview) {
        if (active && actorVerified && runtimeValid && loaded && atBottom && page == "chat" && !older && !restoring && preview == null) {
            val seen = messages.maxOfOrNull { it.sequence } ?: 0
            if (seen > (preferences?.readSequence ?: 0)) try { preferences = session.sharedPreferences(room.id, readSequence = seen, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
    }
    LaunchedEffect(list.firstVisibleItemIndex, list.isScrollInProgress) { if (loaded && !older && !restoring) visible.getOrNull((list.firstVisibleItemIndex - 1).coerceAtLeast(0))?.let { readingStore.edit().putString(readingKey, it.id).apply() } }
    LaunchedEffect(text, active, actorVerified, runtimeValid) {
        if (active && actorVerified && runtimeValid) { delay(300); do { try { session.sharedTyping(room.id, text.isNotBlank(), connectionId, runtimeIdentity) } catch (e: CancellationException) { throw e } catch (_: Exception) { }; if (text.isBlank()) break; delay(3_000) } while (isActive) }
    }
    DisposableEffect(connectionId, room.id) { onDispose { CoroutineScope(Dispatchers.IO).launch { runCatching { session.sharedTyping(room.id, false, connectionId, runtimeIdentity) } } } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) action { preparing = true; try {
            for (uri in uris.take(AttachmentPolicy.MAXIMUM_ITEMS - pending.size)) {
                val item = withContext(Dispatchers.IO) { AttachmentImport.readDocument(context.contentResolver, uri, AttachmentImportRules.remainingBytes(pending), context.cacheDir) }
                try { SharedChatUiPolicy.validateFile(item, pending); val retained = withContext(Dispatchers.IO) { draftStore.adopt(item) }; pending = pending + retained; editedSinceDelivery = true; checkpoint(); item.file?.delete() } catch (e: Exception) { item.file?.delete(); throw e }
            }
        } finally { preparing = false } }
    }
    val someone = localized("Someone")
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(AttachmentPolicy.MAXIMUM_ITEMS)) { uris ->
        if (uris.isNotEmpty()) action { preparing = true; try { for ((index, uri) in uris.take(AttachmentPolicy.MAXIMUM_ITEMS - pending.size).withIndex()) {
            val item = withContext(Dispatchers.IO) { if (context.contentResolver.getType(uri)?.startsWith("video/") == true) AttachmentImport.readDocument(context.contentResolver, uri, AttachmentImportRules.remainingBytes(pending), context.cacheDir) else AttachmentImport.readPhoto(context.contentResolver, uri, index, uris.size, AttachmentImportRules.remainingBytes(pending)) }
            try { SharedChatUiPolicy.validateFile(item, pending); val retained = withContext(Dispatchers.IO) { draftStore.adopt(item) }; pending = pending + retained; editedSinceDelivery = true; checkpoint(); item.file?.delete() } catch (e: Exception) { item.file?.delete(); throw e }
        } } finally { preparing = false } }
    }
    if (!runtimeValid || !actorVerified) { Column(Modifier.fillMaxSize().padding(16.dp)) { HeaderBackButton(onBack); if (runtimeValid && actorError == null) CircularProgressIndicator() else { Text(actorError ?: localized("This computer’s sign-in changed. Reopen the conversation.")); if (runtimeValid) TextButton(onClick = { validationRetry++ }) { Text(localized("Retry")) } } }; return }
    preview?.let { item -> FilePreviewSheet(item, onDismiss = { previews.dismiss(item); preview = null }, onShare = { previews.share(item) }, onOpen = { previews.openWithSystem(item) }) }
    if (choosingAttachment) AlertDialog(onDismissRequest = { choosingAttachment = false }, title = { Text(localized("Attach")) }, text = { Column {
        TextButton(onClick = { choosingAttachment = false; photos.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }) { Text(localized("Photos & videos")) }
        TextButton(onClick = { choosingAttachment = false; picker.launch(arrayOf("*/*")) }) { Text(localized("Files")) }
    } }, confirmButton = { TextButton(onClick = { choosingAttachment = false }) { Text(localized("Cancel")) } })
    if (page == "details") { SharedGroupSettingsScreen(session, connectionId, current, selfId, contacts, bots, { page = "chat" }, { current = it; onRoomChanged(it) }, onBack, { page = "search" }, { page = "files" }, { page = "requests" }, runtimeIdentity); return }
    if (page != "chat") { SharedConversationCollection(session, connectionId, room.id, page, selfId, contacts, bots, { page = "chat" }, { message -> page = "chat"; action { merge(listOf(message)); val index = SharedChatMessage.visible(messages).indexOfFirst { it.id == message.id }; if (index >= 0) list.scrollToItem(index + 1) } }, ::openFile, runtimeIdentity, error, openingFile); return }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) { HeaderBackButton(onBack); Text(current.displayName(contacts, selfId), modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); TextButton(onClick = { page = "details" }) { Text(localized("Details")) } }
        if (!loaded && error == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        else LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { if (hasMore) TextButton(enabled = !older, onClick = { action { older = true; try { val first = messages.firstOrNull(); val result = session.sharedMessagePage(room.id, before = first?.sequence, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); merge(result.messages); hasMore = result.hasMore == true; first?.let { anchor -> list.scrollToItem(SharedChatMessage.visible(messages).indexOfFirst { it.id == anchor.id } + 1) } } finally { older = false } } }) { Text(localized(if (older) "Loading…" else "Earlier messages")) } }
            items(visible, key = { it.id }) { message ->
                val actorName = contacts.firstOrNull { it.id == message.actor.id }?.name ?: bots.firstOrNull { it.id == message.actor.id }?.let { "${it.name} · ${it.ownerName.orEmpty()}" } ?: message.actor.localId
                val mine = message.actor.id == selfId
                Column(Modifier.fillMaxWidth().combinedClickable(onClick = {}, onLongClick = { selected = message }), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
                    if (!mine && !message.isActivity) Text(actorName, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    message.replyReference?.let { id -> messages.firstOrNull { it.id == id }?.let { quote -> TextButton(onClick = { action { val index = visible.indexOfFirst { it.id == id }; if (index >= 0) list.animateScrollToItem(index + 1) } }) { Text(quote.text.take(140), maxLines = 2) } } }
                    if (message.isActivity) Text("$actorName · ${message.activityLabel.orEmpty()}", style = MaterialTheme.typography.bodySmall)
                    else if (message.deletedAt != null) Text(localized("Message removed"), style = MaterialTheme.typography.bodySmall)
                    else if (message.text.isNotEmpty()) Surface(Modifier.widthIn(max = 360.dp), shape = androidx.compose.foundation.shape.RoundedCornerShape(22.dp), color = if (mine) BubbleColor.mine else BubbleColor.theirs, contentColor = if (mine) BubbleColor.mineText else MaterialTheme.colorScheme.onSurface) {
                        SelectionContainer { if (message.actor.kind == "bot") MarkdownText(message.text, Modifier.padding(horizontal = 15.dp, vertical = 11.dp)) else Text(message.text, Modifier.padding(horizontal = 15.dp, vertical = 11.dp), style = MaterialTheme.typography.bodyLarge) }
                    }
                    if (message.deletedAt == null) message.attachments.orEmpty().forEach { attachment -> TextButton(onClick = { openFile(attachment) }) { Text(attachment.name) } }
                    Row { Text(RelativeStamp.dateAndTime(message.at), style = MaterialTheme.typography.labelSmall); if (message.editedAt != null && message.deletedAt == null) Text(" · ${localized("edited")}", style = MaterialTheme.typography.labelSmall); if (!message.pinnedBy.isNullOrEmpty()) Text(" · ${localized("Pinned")}", style = MaterialTheme.typography.labelSmall) }
                    message.reactions.orEmpty().forEach { (reaction, actors) -> if (actors.isNotEmpty()) TextButton(onClick = { action { session.annotateSharedMessage(room.id, message.id, reaction = reaction, active = selfId !in actors, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); refresh() } }) { Text("$reaction ${actors.size}") } }
                }
            }
        }
        if (openingFile) LinearProgressIndicator(Modifier.fillMaxWidth())
        storageError?.let { Column(Modifier.padding(16.dp)) { Text(it, color = MaterialTheme.colorScheme.error); if (restoration.isSuccess) TextButton(onClick = { runCatching { checkpoint() } }) { Text(localized("Retry saving draft")) }; TextButton(onClick = { discarding = true }) { Text(localized("Discard saved draft")) } } }
        dictationError?.let { Text(it, Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error) }
        error?.let { Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) { Text(it, Modifier.weight(1f), color = MaterialTheme.colorScheme.error); TextButton(onClick = { retry++ }) { Text(localized("Retry")) } } }
        if (typing.isNotEmpty()) Text(typing.joinToString { contacts.firstOrNull { c -> c.id == it }?.name ?: someone } + " ${localized("is typing…")}", Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
        reply?.let { message -> Row(Modifier.padding(horizontal = 16.dp)) { Text("${localized("Replying to")} ${message.text.take(100)}", Modifier.weight(1f)); TextButton(onClick = { reply = null; savedReplyTo = null; editedSinceDelivery = true; runCatching { checkpoint() } }) { Text(localized("Cancel")) } } }
        if (loaded && !atBottom && visible.isNotEmpty()) TextButton(onClick = { action { list.animateScrollToItem(visible.size) } }) { Text(localized("Jump to latest")) }
        pending.forEach { item -> PendingAttachmentChip(item, !sending && !preparing) { pending = pending - item; editedSinceDelivery = true; uploaded.remove(item.id); runCatching { checkpoint() }.onSuccess { draftStore.remove(item.id) } } }
        val mentionChoices = SharedMentionChoice.choices(contacts, current.memberIds, bots)
        val mention = SharedChatUiPolicy.query(text)?.takeUnless { (_, tail) -> mentionChoices.any { tail == it.label + " " } }
        if (mention != null && !sending) androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(mentionChoices.filter { it.label.contains(mention.second.trim(), true) || it.detail.contains(mention.second.trim(), true) }, key = { it.id }) { choice -> TextButton(onClick = { text = text.take(mention.first) + "@${choice.label} "; typedText = text; editedSinceDelivery = true; runCatching { checkpoint() } }) { Column { Text("@${choice.label}"); Text(choice.detail, style = MaterialTheme.typography.labelSmall); choice.availabilityLabel?.let { Text(localized(it), style = MaterialTheme.typography.labelSmall) } } } }
        }
        if (current.isGroup) Text(localized(if (preferences?.replyMode == "mentions") "Mention a bot for a reply" else "@mention a bot to choose who replies"), Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(enabled = storageError == null && !sending && !preparing && pending.size < AttachmentPolicy.MAXIMUM_ITEMS, onClick = { dictation.stop(); choosingAttachment = true }) { Text("+") }
            OutlinedTextField(text, { text = it; typedText = it; editedSinceDelivery = true; runCatching { checkpoint() } }, Modifier.weight(1f), enabled = storageError == null && !sending && !listening && !starting, placeholder = { Text(localized("Message")) }, maxLines = 6)
            TextButton(enabled = storageError == null && !sending && !preparing, onClick = { dictation.toggle(capturing = text) }) { Text(localized(if (listening || starting) "Stop" else "Dictate")) }
            TextButton(enabled = storageError == null && AttachmentImportRules.canSend(text, pending.size, preparing, sending), onClick = { action {
                dictation.stop(); sending = true
                val snapshot = SharedSendDraft(text.trim(), pending.map { it.id }, savedReplyTo)
                val sendId = snapshot.sendID(failedDraft, previousSendId); failedDraft = snapshot; previousSendId = sendId; editedSinceDelivery = false
                try {
                    checkpoint()
                    val attachments = pending.map { item -> uploaded[item.id] ?: session.uploadSharedAttachment(room.id, item.name, item.mime, withContext(Dispatchers.IO) { item.file?.readBytes() ?: item.data }, connectionId, runtimeIdentity).also { uploaded[item.id] = it; checkpoint() } }
                    session.sendSharedMessage(room.id, snapshot.text, sendId, attachments, snapshot.replyTo, connectionId, runtimeIdentity)
                    draftStore.save(SharedDraftCheckpoint())
                    pending.forEach { draftStore.remove(it.id) }; pending = emptyList(); uploaded.clear(); text = ""; typedText = ""; reply = null; savedReplyTo = null; failedDraft = null; previousSendId = null
                    refresh(); list.animateScrollToItem(SharedChatMessage.visible(messages).size)
                } finally { sending = false }
            } }) { if (sending || preparing) CircularProgressIndicator(Modifier.size(18.dp)) else Text(localized("Send")) }
        }
    }
    if (discarding) AlertDialog(onDismissRequest = { discarding = false }, title = { Text(localized("Discard saved draft?")) }, text = { Text(localized("An earlier send may already have arrived. Discarding removes its retry identity and pending files.")) }, confirmButton = { TextButton(onClick = { action { draftStore.discard(); draftStore.save(SharedDraftCheckpoint()); pending = emptyList(); uploaded.clear(); text = ""; typedText = ""; savedReplyTo = null; reply = null; failedDraft = null; previousSendId = null; recoveryBlocked = false; storageError = null; discarding = false } }) { Text(localized("Discard")) } }, dismissButton = { TextButton(onClick = { discarding = false }) { Text(localized("Cancel")) } })
    selected?.let { message -> AlertDialog(onDismissRequest = { selected = null }, title = { Text(localized("Message")) }, text = { Column {
        TextButton(enabled = message.deletedAt == null, onClick = { reply = message; savedReplyTo = message.id; editedSinceDelivery = true; runCatching { checkpoint() }; selected = null }) { Text(localized("Reply")) }
        listOf("👍", "❤️", "✅").forEach { reaction -> TextButton(onClick = { selected = null; action { session.annotateSharedMessage(room.id, message.id, reaction = reaction, active = selfId !in message.reactions.orEmpty()[reaction].orEmpty(), expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); refresh() } }) { Text(reaction) } }
        TextButton(onClick = { selected = null; action { session.annotateSharedMessage(room.id, message.id, pinned = message.pinnedBy == null, expectedConnectionId = connectionId, expectedRuntimeIdentity = runtimeIdentity); refresh() } }) { Text(localized(if (message.pinnedBy != null) "Unpin message" else "Pin message")) }
        TextButton(onClick = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(message.text)); selected = null }) { Text(localized("Copy")) }
        if (message.actor.id == selfId && message.deletedAt == null) { TextButton(onClick = { editing = message; editedText = message.text; selected = null }) { Text(localized("Edit")) }; TextButton(onClick = { removing = message; selected = null }) { Text(localized("Remove")) } }
    } }, confirmButton = { TextButton(onClick = { selected = null }) { Text(localized("Done")) } }) }
    editing?.let { message -> AlertDialog(onDismissRequest = { editing = null }, title = { Text(localized("Edit message")) }, text = { OutlinedTextField(editedText, { editedText = it }) }, confirmButton = { TextButton(enabled = editedText.trim().isNotEmpty() && editedText != message.text, onClick = { action { merge(listOf(session.editSharedMessage(room.id, message.id, editedText.trim(), connectionId, runtimeIdentity))); editing = null; refresh() } }) { Text(localized("Save")) } }, dismissButton = { TextButton(onClick = { editing = null }) { Text(localized("Cancel")) } }) }
    removing?.let { message -> AlertDialog(onDismissRequest = { removing = null }, title = { Text(localized("Remove message?")) }, text = { Text(localized("This removes the message for everyone.")) }, confirmButton = { TextButton(onClick = { action { merge(listOf(session.editSharedMessage(room.id, message.id, null, connectionId, runtimeIdentity))); removing = null; refresh() } }) { Text(localized("Remove")) } }, dismissButton = { TextButton(onClick = { removing = null }) { Text(localized("Cancel")) } }) }
}
