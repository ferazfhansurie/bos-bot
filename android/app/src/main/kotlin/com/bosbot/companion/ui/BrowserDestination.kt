package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.target

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BrowserDestination(botId: String, navigator: CompanionNavigator, initialTarget: com.openmausbot.companion.core.ChatTarget.Bot? = null) {
    val session = LocalCompanion.current.session
    val connection by session.connection.collectAsState()
    val state by session.state.collectAsState()
    val bot = state.bot(botId) ?: return
    val connectionKey = connection?.id ?: return
    var showingChat by remember(botId, connectionKey) { mutableStateOf(false) }
    var controlling by remember { mutableStateOf(false) }
    var release by remember { mutableStateOf<() -> Unit>({}) }
    var target by remember(botId, connectionKey) { mutableStateOf(initialTarget ?: Chat.BotChat(bot).target) }
    BrowserLiveScreen(bot.name, connectionKey,
        openEvents = { session.browserEvents(botId, connectionKey) },
        sendAction = { viewerId, action -> session.browserAction(botId, viewerId, action, connectionKey) },
        onBack = navigator::pop, onChat = { showingChat = true },
        onControlState = { active, _, relinquish -> controlling = active; release = relinquish })
    if (showingChat) ModalBottomSheet(onDismissRequest = { showingChat = false }) {
        Column {
        if (controlling) Row(Modifier.padding(horizontal = 16.dp)) {
            Text(localized("You have browser control"), Modifier.weight(1f))
            TextButton(onClick = release) { Text(localized("Give back")) }
        }
        ChatScreen(Destination.Chat(target), onResolved = { target = it }, onBack = { showingChat = false },
            onOpenComputer = { showingChat = false }, onOpenOverview = { showingChat = false },
            retainsDraft = { true })
        }
    }
}
