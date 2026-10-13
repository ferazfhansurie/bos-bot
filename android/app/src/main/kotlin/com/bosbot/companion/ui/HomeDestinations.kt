package com.openmausbot.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.avatar.AvatarImageStore
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The home owns its auth, stream, model catalog, and image cache. No primary fallback. */
@Composable
internal fun HomeScope(home: Session, content: @Composable () -> Unit) {
    val base = LocalCompanion.current
    val connection by home.connection.collectAsState()
    val avatars = remember(home, connection?.id) { AvatarImageStore(home::avatarData, maxEntries = 32, maxBytes = 16 * 1024 * 1024) }
    androidx.compose.runtime.DisposableEffect(avatars) { onDispose { avatars.clearBlocking() } }
    val scoped = remember(base, home, avatars) { base.copy(session = home, avatars = avatars) }
    CompositionLocalProvider(LocalCompanion provides scoped, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeChatDestination(destination: Destination.HomeChat, navigator: CompanionNavigator) {
    val primary = LocalCompanion.current.session
    val homes by primary.homesState.collectAsState()
    val home = homes.firstOrNull { it.connection.id == destination.connectionId }?.session
    if (home == null) { ConversationSkeleton(); return }
    HomeScope(home) {
        var overview by remember { mutableStateOf<String?>(null) }
        ChatScreen(Destination.Chat(destination.target), onResolved = { navigator.selectHomeTask(destination, it) },
            onBack = navigator::pop,
            onOpenComputer = { navigator.push(Destination.Browser(it, destination.connectionId)) },
            onOpenOverview = { overview = it }, retainsDraft = navigator::retainsChatDraft,
            onOpenChat = { navigator.openHome(destination.connectionId, it) })
        overview?.let { botId -> ModalBottomSheet(onDismissRequest = { overview = null }) { BotOverviewScreen(botId, onBack = { overview = null }) } }
    }
}

@Composable
internal fun ScopedBrowserDestination(destination: Destination.Browser, navigator: CompanionNavigator) {
    val primary = LocalCompanion.current.session
    val homes by primary.homesState.collectAsState()
    val home = destination.connectionId?.let { id -> homes.firstOrNull { it.connection.id == id }?.session }
        ?: primary.takeIf { destination.connectionId == null }
    if (home == null) { ConversationSkeleton(); return }
    HomeScope(home) { BrowserDestination(destination.botId, navigator, navigator.browserChatTarget(destination.botId, destination.connectionId)) }
}

@Composable
internal fun VoiceDestination(destination: Destination.VoiceCall, navigator: CompanionNavigator) {
    val primary = LocalCompanion.current.session
    val homes by primary.homesState.collectAsState()
    val target = destination.target
    val home = homes.firstOrNull { it.connection.id == target.connectionId }?.session
    if (home == null) { Text(localized("The call's computer is no longer connected."), Modifier.padding(24.dp)); return }
    val center = com.openmausbot.companion.audio.VoiceCallCenter.get(androidx.compose.ui.platform.LocalContext.current)
    val runtimeIdentity = remember(home, target, destination.consentRuntimeIdentity) { destination.consentRuntimeIdentity ?: runCatching { home.sharedRuntimeIdentity(target.connectionId) }.getOrNull() }
    if (runtimeIdentity == null || runCatching { home.sharedRuntimeIdentity(target.connectionId) }.getOrNull() !== runtimeIdentity) { Text(localized("The call computer changed. Reopen the call."), Modifier.padding(24.dp)); return }
    val replies = remember(home, target) { voiceReplies(center, home, target) }
    HomeScope(home) {
        VoiceCallScreen(target.botName, onClose = navigator::pop, target = target, opener = destination.opener,
            autoStart = true, onMinimize = navigator::pop,
            startCall = { language, callId -> home.startVoiceCall(target.botId, language, callId, target.connectionId, runtimeIdentity) },
            sendTask = { text, callId -> home.sendVoiceTask(target.botId, target.threadId, text, callId, expectedConnectionId = target.connectionId, expectedRuntimeIdentity = runtimeIdentity) },
            sendSpokenTask = { text, job, callId -> home.sendVoiceTask(target.botId, target.threadId, text, callId, job = job, expectedConnectionId = target.connectionId, expectedRuntimeIdentity = runtimeIdentity) },
            recall = { check(home.connection.value?.id == target.connectionId && home.sharedRuntimeIdentity(target.connectionId) === runtimeIdentity) { "The call computer changed." }; buildJsonObject { put("messages", JsonArray(home.state.value.visibleTranscript(target.threadId).takeLast(12).map { JsonPrimitive(it.text.orEmpty()) })) } },
            settledReplies = replies, ownerConnection = home.connection, ownerRuntimeRevision = home.sharedRuntimeRevision,
            reportUsage = { callId, seconds -> home.reportVoiceUsage(target.botId, callId, seconds, target.connectionId, runtimeIdentity) })
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
internal fun voiceReplies(center: com.openmausbot.companion.audio.VoiceCallCenter, home: Session,
    target: com.openmausbot.companion.audio.VoiceCallTarget): kotlinx.coroutines.flow.Flow<com.openmausbot.companion.audio.LandedVoiceReply> =
    kotlinx.coroutines.flow.combine(center.call, center.target) { call, active -> call?.takeIf { active == target } }
        .flatMapLatest { call ->
            if (call == null) kotlinx.coroutines.flow.emptyFlow()
            else home.landedVoiceReplies(target.botId, target.threadId, call.callId, since = 0.0, expectedConnectionId = target.connectionId)
                .map { com.openmausbot.companion.audio.LandedVoiceReply(it.id, it.text, it.at.toLong()) }
        }

@Composable
internal fun ScopedWalkieDestination(destination: Destination.Walkie, navigator: CompanionNavigator) {
    val primary = LocalCompanion.current.session
    val homes by primary.homesState.collectAsState()
    val home = homes.firstOrNull { it.connection.id == destination.connectionId }?.session
    if (home == null) { Text(localized("The computer is no longer connected."), Modifier.padding(24.dp)); return }
    val state by home.state.collectAsState()
    val initial = when (val target = destination.target) {
        is com.openmausbot.companion.core.ChatTarget.Bot -> state.bot(target.botId)?.let { bot -> Chat.BotChat(bot) }
        is com.openmausbot.companion.core.ChatTarget.Room -> state.rooms.firstOrNull { it.id == target.roomId }?.let { Chat.RoomChat(it) }
        null -> null
    }
    HomeScope(home) { WalkieScreen(home, initial, navigator::pop) { navigator.openHome(destination.connectionId, it) } }
}

@Composable
internal fun ScopedSharedDestination(destination: Destination.SharedChat, navigator: CompanionNavigator) {
    val primary = LocalCompanion.current.session
    val homes by primary.homesState.collectAsState()
    val home = homes.firstOrNull { it.connection.id == destination.connectionId }?.session
    if (home == null) { Text(localized("The computer is no longer connected."), Modifier.padding(24.dp)); return }
    HomeScope(home) {
        SharedChatScreen(home, destination.connectionId, destination.room, destination.selfId, destination.contacts,
            onBack = navigator::pop, onRoomChanged = { navigator.updateShared(destination, it) })
    }
}
