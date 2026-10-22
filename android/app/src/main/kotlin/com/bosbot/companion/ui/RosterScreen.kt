package com.openmausbot.companion.ui

import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import com.openmausbot.companion.core.target
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.TextButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import com.openmausbot.companion.core.canMarkDone
import com.openmausbot.companion.audio.VoiceCallTarget
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatSummary
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.SearchHit
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.chat
import com.openmausbot.companion.core.chatSummaries
import com.openmausbot.companion.core.forTask
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * The roster — the port of `ios/App/ChatListView.swift`.
 *
 * Messages-shaped: a header with you on the left and settings on the right, your
 * groups across the top, every bot below with the unread dot in the bot's own
 * colour at the left edge, and a bar floating at the bottom. The bar's pill is
 * Updates — only the bots that need you, are working, or have something you have
 * not read — beside round search and new-bot buttons. Everything scrolls under
 * the bar, which is why the list leaves [BAR_CLEARANCE] below its last row.
 *
 * Ordering is not decided here. `chatSummaries` (`:core`) folds pinned → unread →
 * last activity and hides hidden bots; [RosterLayout] decides which of those are
 * rows and which are tiles; the screen renders what it is handed.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun RosterScreen(navigator: CompanionNavigator) {
    val environment = LocalCompanion.current
    val session = environment.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    // A streaming bot publishes a state per token. The list only needs to keep
    // up with the eye, so it folds the fleet at most four times a second (the
    // iOS session coalesces its loud publishes the same way).
    val state by remember(session) { session.state.throttleLatest(250) }.collectAsState(session.state.value)
    val homes by session.homesState.collectAsState()
    val connection by session.connection.collectAsState()
    val status by session.status.collectAsState()
    // The same preference the transcript folds by, from the same store: a reader
    // who turned activity off must not still read tool names here.
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()

    var bar by rememberSaveable(stateSaver = RosterBarSaver) { mutableStateOf(RosterBar()) }
    var hits by remember { mutableStateOf<List<SearchHit>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var showingUpdates by remember { mutableStateOf(false) }
    var showingNewGroup by remember { mutableStateOf(false) }
    var showingNewSection by remember { mutableStateOf(false) }
    var expandedBots by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var collapsedFolders by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var creatingThreads by remember { mutableStateOf(emptySet<String>()) }
    // One createBot at a time: a second tap while the first is in flight
    // would race two bots into existence.
    var creatingBot by remember { mutableStateOf(false) }
    var conversationFilter by rememberSaveable { mutableStateOf("all") }
    var managingThreads by remember { mutableStateOf<Chat?>(null) }
    var managingThreadsOwner by remember { mutableStateOf<Session?>(null) }
    val context = LocalContext.current
    val rosterPreferences = remember(context.applicationContext) { context.getSharedPreferences("roster-layout", android.content.Context.MODE_PRIVATE) }
    val rosterScope = connection?.id.orEmpty()
    var pinnedIds by remember(rosterScope) { mutableStateOf(rosterPreferences.getStringSet("$rosterScope.pinned", emptySet()).orEmpty().toSet()) }
    var hiddenIds by remember(rosterScope) { mutableStateOf(rosterPreferences.getStringSet("$rosterScope.hidden", emptySet()).orEmpty().toSet()) }
    var showingHidden by remember { mutableStateOf(false) }
    var showingProfile by remember { mutableStateOf(false) }
    val personalPreferences = remember(context.applicationContext) { context.getSharedPreferences("personal-profile", android.content.Context.MODE_PRIVATE) }
    var personalPhoto by remember(rosterScope) { mutableStateOf(personalPreferences.getString("$rosterScope.photo", "").orEmpty()) }
    var conversationMenu by remember { mutableStateOf<RosterConversation?>(null) }
    fun pin(entry: RosterConversation) {
        pinnedIds = if (entry.key in pinnedIds) pinnedIds - entry.key else pinnedIds + entry.key
        rosterPreferences.edit().putStringSet("$rosterScope.pinned", pinnedIds).commit()
    }
    fun hide(entry: RosterConversation) {
        hiddenIds = if (entry.key in hiddenIds) hiddenIds - entry.key else hiddenIds + entry.key
        rosterPreferences.edit().putStringSet("$rosterScope.hidden", hiddenIds).commit()
    }
    fun open(entry: RosterConversation) {
        if (entry.connectionId == connection?.id) navigator.open(entry.summary.chat) else navigator.openHome(entry.connectionId, entry.summary.chat)
    }
    fun call(entry: RosterConversation) {
        val bot = (entry.summary.chat as? Chat.BotChat)?.bot ?: return
        navigator.push(Destination.VoiceCall(VoiceCallTarget(entry.connectionId, bot.id, bot.threadId, bot.name)))
    }


    val query = bar.query

    // Local filtering is always on; the computer is only asked past two
    // characters and after a quiet moment (§10).
    LaunchedEffect(query) {
        when (val decision = SearchPolicy.decide(query)) {
            SearchPolicy.Decision.Clear -> {
                hits = emptyList()
                searching = false
            }
            is SearchPolicy.Decision.Remote -> {
                searching = true
                delay(SearchPolicy.DEBOUNCE_MILLIS)
                hits = session.search(decision.query)
                searching = false
            }
        }
    }

    // Folding the fleet walks every thread's transcript, so it is keyed on the
    // state and the activity level alone: typing filters the fold instead of
    // repeating it.
    val summaries = remember(state, activityDetail) { state.chatSummaries(activityDetail) }
    // Only a search has rows to filter; the unsearched roster is assembled
    // section by section below.
    val rows = remember(summaries, query, state.queuedThreadIds) {
        rosterThreadRows(summaries, query, state.queuedThreadIds)
    }
    val approvals = remember(state) { state.pendingApprovals }
    val waiting = remember(state, approvals) { RosterLayout.waitingChats(state, approvals) }
    // One pass over the fleet rather than one per row: resolving a face walks the
    // chat's visible transcript. The activity feed rides in `state`, so a bot
    // that starts work in a thread nobody has open re-faces its row here.
    val faces = remember(state, summaries) {
        summaries.associate { it.id to MascotFace.forRow(it.chat, state) }
    }
    val summariesById = remember(summaries) { summaries.associateBy { it.id } }
    // Hoisted out of the list: read inside a lazy item, `state` would make that
    // item's recompose scope the whole fleet.
    val rooms = state.rooms
    val tiles = remember(state) {
        rooms.associate { it.id to RosterLayout.memberBots(state, it) }
    }
    // Read by the bar over the list and by nothing inside it, so the rows never
    // recompose for it. `approvals` is handed over rather than walked again.
    val updates = remember(state, approvals) { state.updates(approvals) }
    // The cross-bot Needs attention section rides above every roster section.
    val attention = remember(state) { state.crossBotAttention() }

    val allConversations = remember(summaries, homes, activityDetail, session, rosterScope) { buildList {
        summaries.forEach { add(RosterConversation(it, session, rosterScope, null)) }
        homes.filter { it.connection.id != connection?.id }.forEach { home ->
            home.state.chatSummaries(activityDetail).forEach { summary ->
                val label = home.connection.name + when(home.status) { Session.Status.Live -> ""; Session.Status.Connecting -> " · checking"; else -> " · asleep" }
                add(RosterConversation(summary, home.session, home.connection.id, label))
            }
        }
    } }
    fun matchesFilter(entry: RosterConversation): Boolean = when(conversationFilter) {
        "unread" -> entry.summary.chat.unread
        "waiting" -> entry.summary.id in RosterLayout.waitingChats(entry.owner.state.value, entry.owner.state.value.pendingApprovals)
        "running" -> entry.summary.chat.busy
        else -> true
    }
    val pinnedConversations = allConversations.filter { it.key in pinnedIds && it.key !in hiddenIds && matchesFilter(it) }
    val hiddenConversations = allConversations.filter { it.key in hiddenIds }
    val entry: @Composable (ChatSummary, Boolean) -> Unit = { summary, last ->
        // Remembered per chat, reading the newest summary when tapped: a fresh
        // lambda each frame would make the row's inputs differ and redraw it.
        val latest by rememberUpdatedState(summary)
        val onClick = remember(summary.id, session, rosterScope) { { open(RosterConversation(latest, session, rosterScope, null)) } }
        val onLongClick = remember(summary.id, session, rosterScope) { { conversationMenu = RosterConversation(latest, session, rosterScope, null) } }
        ChatRow(summary, faces[summary.id] ?: MascotFace(MausState.IDLE), summary.id in waiting, last,
            onClick = onClick, onLongClick = onLongClick)
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            RosterHeader(
                name = connection?.name,
                photo = personalPhoto,
                status = status,
                onSettings = { showingProfile = true },
                onSearch = { bar = bar.openSearch() },
                canAdminister = connection?.canAdminister == true,
                canCreateBot = !creatingBot,
                canCreateSection = SectionRules.selectable(state).isNotEmpty(),
                onNewGroup = { showingNewGroup = true },
                onNewSection = { showingNewSection = true },
                onNewBot = { if (!creatingBot) { creatingBot = true; scope.launch { try { session.createBot()?.let { navigator.open(Chat.BotChat(it)) } } finally { creatingBot = false } } } },
            )
            StatusBanner()

            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        // Session.refresh waits until the stream leaves connecting
                        // (or 10s), so the spinner means what it appears to mean.
                        session.refresh()
                        refreshing = false
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                // Unsearched, the empty state is about bots: channels are tiles
                // in the strip, not rows.
                val nothingToList =
                    if (query.isEmpty()) allConversations.none { showingHidden || it.key !in hiddenIds } else rows.isEmpty()
                if (nothingToList && hits.isEmpty() && status !is Session.Status.Connecting) {
                    EmptyState(
                        title = if (query.isEmpty()) "No bots yet" else "Nothing matches",
                        description = if (query.isEmpty()) {
                            "Bots you create on your computer show up here."
                        } else {
                            "No thread matches “$query”."
                        },
                    )
                }

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = BAR_CLEARANCE),
                ) {
                    if (query.isEmpty()) {
                        homes.forEach { home -> item(key = "people-${home.connection.id}") { HomeScope(home.session) { SharedRosterPanel(home.session, home.connection.id, home.connection.name.takeIf { homes.size > 1 }) { room, selfId, contacts -> navigator.openShared(home.connection.id, room, selfId, contacts) } } } }
                        item(key = "conversation-filter") {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp))) {
                                listOf("all" to "All", "unread" to "Unread", "waiting" to "Waiting", "running" to "Running").forEach { (id, label) ->
                                    Text(localized(label), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.weight(1f)
                                            .background(if (conversationFilter == id) MaterialTheme.colorScheme.surface else Color.Transparent, RoundedCornerShape(9.dp))
                                            .clickable(role = Role.RadioButton) { conversationFilter = id }
                                            .padding(vertical = 10.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                                }
                            }
                        }
                        if (conversationFilter == "all" && attention.isNotEmpty()) {
                            item(key = "attention-label") { SectionLabel(localized("Needs attention"), Modifier.padding(top = 2.dp, bottom = 4.dp)) }
                            items(attention, key = { "attention-${it.id}" }) { attentionEntry ->
                                AttentionRow(entry = attentionEntry, onOpen = {
                                    state.bots.firstOrNull { it.id == attentionEntry.botId }
                                        ?.let { bot -> Chat.BotChat(bot.forTask(attentionEntry.task.threadId) ?: bot) }
                                        ?.let(navigator::open)
                                })
                            }
                        }
                        val visible = summaries.filter { summary ->
                            val key = "$rosterScope:${summary.id}"
                            (key !in pinnedIds && (showingHidden || key !in hiddenIds)) && when (conversationFilter) { "unread" -> summary.chat.unread; "waiting" -> summary.id in waiting; "running" -> summary.chat.busy; else -> true }
                        }
                        if (pinnedConversations.isNotEmpty()) item(key = "pinned-chats") {
                            Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                pinnedConversations.chunked(3).forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                    row.forEach { conversation -> HomeScope(conversation.owner) {
                                        Column(Modifier.weight(1f).combinedClickable(onClick = { open(conversation) }, onLongClick = { conversationMenu = conversation }), horizontalAlignment = Alignment.CenterHorizontally) {
                                            ChatAvatar(conversation.summary.chat, 82.dp, MascotFace.forRow(conversation.summary.chat, conversation.owner.state.value).state, animated = conversation.summary.chat.busy)
                                            Text(conversation.summary.chat.name, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    } }
                                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                                } }
                            }
                        }
                        item(key = "chats-label") { SectionLabel(localized("Chats"), Modifier.padding(top = 18.dp, bottom = 4.dp)) }
                        if (visible.isEmpty() && conversationFilter != "all") item(key = "empty-filter") { Text(localized("No conversations match this filter."), color = secondaryTint, modifier = Modifier.padding(16.dp)) }
                        itemsIndexed(visible, key = { _, summary -> "conversation-${summary.id}" }) { index, summary -> entry(summary, index == visible.lastIndex) }
                        homes.filter { it.connection.id != connection?.id }.forEach { home ->
                            val homeSummaries = home.state.chatSummaries(activityDetail).filter { summary ->
                                val key = "${home.connection.id}:${summary.id}"
                                (key !in pinnedIds && (showingHidden || key !in hiddenIds)) && when (conversationFilter) {
                                    "unread" -> summary.chat.unread
                                    "waiting" -> summary.id in RosterLayout.waitingChats(home.state, home.state.pendingApprovals)
                                    "running" -> summary.chat.busy
                                    else -> true
                                }
                            }
                            if (homeSummaries.isNotEmpty()) {
                                item(key = "home-${home.connection.id}") { SectionLabel(home.connection.name, Modifier.padding(top = 18.dp, bottom = 4.dp)) }
                                itemsIndexed(homeSummaries, key = { _, summary -> "home-${home.connection.id}-${summary.id}" }) { index, summary ->
                                    val conversation = allConversations.first { it.connectionId == home.connection.id && it.summary.id == summary.id }
                                    val face = if (home.status == Session.Status.Live) MascotFace.forRow(summary.chat, home.state) else MascotFace(if (home.status == Session.Status.Connecting) MausState.WAKING else MausState.SLEEPING)
                                    HomeScope(home.session) { ChatRow(summary, face,
                                        summary.id in RosterLayout.waitingChats(home.state, home.state.pendingApprovals), index == homeSummaries.lastIndex,
                                        onClick = { open(conversation) }, onLongClick = { conversationMenu = conversation }, homeLabel = conversation.homeLabel) }
                                }
                            }
                        }
                    }

                    if (query.isEmpty() && hiddenConversations.isNotEmpty()) item(key = "hidden-chats") {
                        TextButton(onClick = { showingHidden = !showingHidden }, modifier = Modifier.padding(horizontal = 20.dp)) { Text(if (showingHidden) localized("Hide hidden chats") else "${hiddenConversations.size} ${localized("hidden")}") }
                    }

                    if (query.isNotEmpty() && hits.isNotEmpty()) {
                        item(key = "search-header") {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 10.dp, bottom = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionLabel(localized("Messages"))
                                Spacer(Modifier.weight(1f))
                                if (searching) {
                                    CircularProgressIndicator(
                                        modifier = Modifier
                                            .padding(end = 20.dp)
                                            .size(14.dp),
                                        strokeWidth = 2.dp,
                                    )
                                }
                            }
                        }
                        items(hits, key = { it.id }) { hit ->
                            SearchHitRow(
                                hit = hit,
                                onClick = {
                                    scope.launch {
                                        // Session.open switches task, sets the
                                        // active branch, loads the `around` page
                                        // and focuses the message — the chat
                                        // screen honours the focus when it opens.
                                        session.open(hit)?.let {
                                            haptics.play(TactileAction.OPEN_SEARCH_RESULT)
                                            navigator.open(it)
                                        }
                                    }
                                },
                            )
                        }
                        item(key = "chats-label") {
                            SectionLabel(localized("Threads"), Modifier.padding(top = 14.dp, bottom = 4.dp))
                        }
                    }

                    if (query.isNotEmpty()) {
                        itemsIndexed(rows, key = { _, summary -> summary.chat.threadId }) { index, summary ->
                            entry(summary, index == rows.lastIndex)
                        }
                    }
                }
            }
        }

        RosterBottomBar(
            updates = updates,
            bar = bar,
            onBar = { bar = it },
            onOpenUpdates = {
                haptics.play(TactileAction.OPEN_UPDATES)
                showingUpdates = true
            },
            onOpenSearch = {
                haptics.play(TactileAction.OPEN_SEARCH)
                bar = bar.openSearch()
            },
            onCreateBot = {
                if (!creatingBot) {
                    creatingBot = true
                    scope.launch {
                        try {
                            session.createBot()?.let {
                                haptics.play(TactileAction.CREATE_BOT_SUCCESS)
                                navigator.open(Chat.BotChat(it))
                            }
                        } finally {
                            creatingBot = false
                        }
                    }
                }
            },
            canCreateBot = !creatingBot,
            onCreateSection = {
                haptics.play(TactileAction.START_NEW_SECTION)
                showingNewSection = true
            },
            // The same rule the sheet picks from: two copies of "which bots can
            // be sectioned" could disagree about a hidden one.
            canCreateSection = remember(state) { SectionRules.selectable(state).isNotEmpty() },
            canAdminister = connection?.canAdminister == true,
            onCreateGroup = { showingNewGroup = true },
            onVoice = { connection?.id?.let { navigator.push(Destination.Walkie(it)) } },
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    if (showingUpdates) {
        UpdatesSheet(
            onOpen = { chat ->
                showingUpdates = false
                navigator.open(chat)
            },
            onDismiss = { showingUpdates = false },
        )
    }

    if (showingNewGroup) {
        NewGroupSheet(
            onCreated = { room ->
                showingNewGroup = false
                navigator.open(Chat.RoomChat(room))
            },
            onDismiss = { showingNewGroup = false },
        )
    }

    if (showingNewSection) {
        NewSectionSheet(onDismiss = { showingNewSection = false })
    }

    if (showingProfile) ModalBottomSheet(onDismissRequest = { showingProfile = false }) {
        PersonalProfileScreen(onClose = { showingProfile = false }, onOpenSettings = { showingProfile = false; navigator.push(Destination.Settings) }, onPhotoChanged = { personalPhoto = it })
    }
    conversationMenu?.let { conversation ->
        val bot = (conversation.summary.chat as? Chat.BotChat)?.bot
        val task = bot?.tasks?.firstOrNull { it.threadId == bot.threadId }
        AlertDialog(onDismissRequest = { conversationMenu = null }, title = { Text(conversation.summary.chat.name) }, text = {
            Column {
                TextButton(onClick = { pin(conversation); conversationMenu = null }) { Text(localized(if (conversation.key in pinnedIds) "Unpin chat" else "Pin chat")) }
                if (bot != null) {
                    TextButton(onClick = { managingThreads = conversation.summary.chat; managingThreadsOwner = conversation.owner; conversationMenu = null }) { Text(localized("All threads")) }
                    if (bot.remote == null) TextButton(onClick = { conversationMenu = null; call(conversation) }) { Text(localized("Call")) }
                    if (task != null) TextButton(enabled = task.canMarkDone, onClick = { conversationMenu = null; scope.launch { conversation.owner.archiveTask(task, bot, System.currentTimeMillis().toDouble()) } }) { Text(localized("Mark done")) }
                }
                TextButton(onClick = { conversationMenu = null; navigator.push(Destination.Walkie(conversation.connectionId, conversation.summary.chat.target)) }) { Text(localized("Walkie")) }
                if (conversation.homeLabel != null || bot?.remote != null) TextButton(onClick = { hide(conversation); conversationMenu = null }) { Text(localized(if (conversation.key in hiddenIds) "Show in list" else "Hide")) }
            }
        }, confirmButton = { TextButton(onClick = { conversationMenu = null }) { Text(localized("Done")) } })
    }

    managingThreads?.let { chat ->
        val owner = managingThreadsOwner ?: session
        HomeScope(owner) { TaskSheet(chat = chat, onDismiss = { managingThreads = null }, onSelectTask = { target ->
            managingThreads = null
            owner.state.value.chat(target)?.let { selected -> if (owner.connection.value?.id == connection?.id) navigator.open(selected) else owner.connection.value?.id?.let { navigator.openHome(it, selected) } }
        }) }
    }
}

/** Room for the floating bar, so the last row can scroll clear of it. */
private val BAR_CLEARANCE = 96.dp

/** Two flags and a string: enough to survive a rotation with the search still up. */
private val RosterBarSaver = listSaver<RosterBar, Any>(
    save = { listOf(it.searchOpen, it.query) },
    restore = { RosterBar(searchOpen = it[0] as Boolean, query = it[1] as String) },
)

private val StringSetSaver = listSaver<Set<String>, String>(
    save = { it.toList() },
    restore = { it.toSet() },
)

/**
 * You (the computer you are paired with) on the left, settings on the right, and
 * where you are in between. Search and both creations are not here any more —
 * they live in the bar at the bottom and at the end of the groups strip.
 */
@Composable
private fun RosterHeader(name: String?, photo: String, status: Session.Status, onSettings: () -> Unit, onSearch: () -> Unit,
    canAdminister: Boolean, canCreateBot: Boolean, canCreateSection: Boolean, onNewGroup: () -> Unit, onNewSection: () -> Unit, onNewBot: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TouchTarget(onClick = onSettings, size = 44.dp, contentDescription = "Your profile and settings") {
            val bitmap = remember(photo) { personalPhotoBitmap(photo) }; if (bitmap != null) Image(bitmap.asImageBitmap(), null, Modifier.size(44.dp).clip(CircleShape)) else ProfileAvatar(name ?: "You", 44.dp)
        }
        Spacer(Modifier.weight(1f))
        ChromeButton(Icons.Filled.Search, "Search", onSearch)
        if (canAdminister) RosterCreateMenu(canCreateBot, canCreateSection, onNewGroup, onNewSection, onNewBot)
        else ChromeButton(Icons.Filled.Add, "New group", onNewGroup)
    }
}

/** A heading over a stretch of the list. */
@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = RosterLayout.sectionLabel(text),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.4.sp,
        color = secondaryTint,
        modifier = modifier.padding(horizontal = 20.dp),
    )
}

/**
 * Every group, across the top, with the tile that makes one at the end — the
 * place iOS puts it, and the reason the header no longer carries a second plus.
 */
@Composable
private fun GroupsStrip(
    title: String,
    rooms: List<Room>,
    members: Map<String, List<Bot>>,
    onOpen: (Room) -> Unit,
    onCreate: (() -> Unit)?,
) {
    Column(
        modifier = Modifier.padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionLabel(title)
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 16.dp),
        ) {
            items(rooms, key = { it.id }) { room ->
                GroupTile(
                    room = room,
                    members = members[room.id].orEmpty(),
                    onClick = { onOpen(room) },
                )
            }
            if (onCreate != null) {
                item(key = "new-group") { NewGroupTile(onClick = onCreate) }
            }
        }
    }
}

/**
 * A room as a round tile: the first two members' mascots stacked, its name
 * beneath.
 */
@Composable
private fun GroupTile(room: Room, members: List<Bot>, onClick: () -> Unit) {
    GroupTileFrame(
        label = room.name,
        labelColor = MaterialTheme.colorScheme.onSurface,
        onClick = onClick,
    ) {
        Box(
            Modifier
                .size(64.dp)
                .background(secondaryTint.copy(alpha = 0.14f), CircleShape),
        )
        members.getOrNull(0)?.let {
            BotAvatar(
                bot = it,
                size = 34.dp,
                state = MausState.HAPPY,
                animated = false,
                modifier = Modifier.offset(x = (-9).dp, y = (-6).dp),
            )
        }
        members.getOrNull(1)?.let {
            Box(
                modifier = Modifier
                    .offset(x = 11.dp, y = 9.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp),
            ) {
                BotAvatar(bot = it, size = 30.dp, state = MausState.HAPPY, animated = false)
            }
        }
        if (room.unread) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(3.dp)
                    .size(14.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp)
                    .background(BubbleColor.mine, CircleShape),
            )
        }
    }
}

/** The empty tile at the end of the strip: this is where a group is made. */
@Composable
private fun NewGroupTile(onClick: () -> Unit) {
    val outline = secondaryTint.copy(alpha = 0.6f)
    GroupTileFrame(label = "New group", labelColor = secondaryTint, onClick = onClick) {
        Spacer(
            modifier = Modifier
                .size(64.dp)
                .drawWithCache {
                    val width = 1.5.dp.toPx()
                    val dash = 4.dp.toPx()
                    val style = Stroke(
                        width = width,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), 0f),
                    )
                    val radius = size.minDimension / 2f - width / 2f
                    onDrawBehind { drawCircle(color = outline, radius = radius, style = style) }
                },
        )
        Icon(
            imageVector = Icons.Filled.Add,
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(24.dp),
        )
    }
}

@Composable
private fun GroupTileFrame(
    label: String,
    labelColor: Color,
    onClick: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .width(76.dp)
            .clip(RoundedCornerShape(18.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(modifier = Modifier.size(64.dp), contentAlignment = Alignment.Center, content = content)
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = labelColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(
    summary: ChatSummary,
    face: MascotFace,
    waiting: Boolean,
    last: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit = {},
    homeLabel: String? = null,
) {
    val chat = summary.chat
    val now = remember(summary.lastActivity) { System.currentTimeMillis() }
    val accent = remember(chat.color) { Color(MausPalette.argb(chat.color)) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(role = Role.Button, onClick = onClick, onLongClick = onLongClick)
            .semantics(mergeDescendants = true) { stateDescription = if (chat.busy) "Working" else if (chat.unread) "Unread" else "" }
            .padding(start = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // The unread dot, in the bot's own colour, at the very edge.
        Box(
            modifier = Modifier
                .width(22.dp)
                .align(Alignment.CenterVertically),
            contentAlignment = Alignment.Center,
        ) {
            if (chat.unread && !chat.busy) {
                Box(Modifier.size(10.dp).background(accent, CircleShape))
            }
        }

        Row(
            modifier = Modifier
                .weight(1f)
                .padding(end = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.Top,
        ) {
            ChatAvatar(
                chat = chat,
                size = 52.dp,
                state = face.state,
                animated = face.animated,
                modifier = Modifier.padding(top = 12.dp),
            )

            Box(modifier = Modifier.weight(1f)) {
                Column(
                    modifier = Modifier.padding(vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            modifier = Modifier.weight(1f),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = chat.name,
                                fontSize = 17.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            homeLabel?.let { Text(it, fontSize = 12.sp, color = secondaryTint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                        Text(
                            text = RelativeStamp.list(
                                summary.lastActivity,
                                now,
                                locale = Locale.getDefault(),
                            ),
                            fontSize = 15.sp,
                            color = secondaryTint,
                            maxLines = 1,
                        )
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = secondaryTint.copy(alpha = 0.5f),
                            modifier = Modifier.size(16.dp),
                        )
                    }

                    if (chat is Chat.BotChat && chat.subtitle.isNotBlank()) {
                        Text(chat.subtitle, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                            color = secondaryTint, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        // One line for every bot, so the rows keep one rhythm.
                        Text(
                            text = if (chat.busy) localized("Working…") else summary.preview.ifEmpty { localized("No messages yet") },
                            fontSize = 15.sp,
                            color = secondaryTint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (chat.busy) {
                            TickSpinner(
                                modifier = Modifier
                                    .padding(top = 3.dp)
                                    .size(12.dp),
                                strokeWidth = 2.dp,
                            )
                        }
                    }

                    if (waiting) {
                        Row(
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .background(accent, CircleShape)
                                .padding(horizontal = 9.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Notifications,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(12.dp),
                            )
                            Text(
                                text = localized("Waiting on you"),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = Color.White,
                            )
                        }
                    }
                }

                if (!last) HorizontalDivider(modifier = Modifier.align(Alignment.BottomStart))
            }
        }
    }
}

/**
 * The bar over the bottom of the list: Updates beside search and new bot, or —
 * once search is open — the field beside Cancel.
 *
 * Cancel is what closes it, and it takes the query with it: that is what puts the
 * groups strip back and returns the list to bots only.
 */
@Composable
private fun RosterBottomBar(
    updates: List<ChatUpdate>,
    bar: RosterBar,
    onBar: (RosterBar) -> Unit,
    onOpenUpdates: () -> Unit,
    onOpenSearch: () -> Unit,
    onCreateBot: () -> Unit,
    canCreateBot: Boolean,
    onCreateSection: () -> Unit,
    canCreateSection: Boolean,
    canAdminister: Boolean,
    onCreateGroup: () -> Unit,
    onVoice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    LaunchedEffect(bar.searchOpen) {
        if (bar.searchOpen) focus.requestFocus() else focusManager.clearFocus()
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bar.searchOpen) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .chromeCapsule()
                    .height(BAR_HEIGHT)
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(18.dp),
                )
                Box(modifier = Modifier.weight(1f)) {
                    if (bar.query.isEmpty()) {
                        Text(localized("Search threads"), fontSize = 17.sp, color = secondaryTint)
                    }
                    BasicTextField(
                        value = bar.query,
                        onValueChange = { onBar(bar.typed(it)) },
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(
                            fontSize = 17.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus),
                    )
                }
                if (bar.query.isNotEmpty()) {
                    TouchTarget(onClick = { onBar(bar.clearQuery()) }, size = 24.dp) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = "Clear search",
                            tint = secondaryTint,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }

            Box(
                modifier = Modifier
                    .chromeCapsule()
                    .clip(CircleShape)
                    .height(BAR_HEIGHT)
                    .clickable(role = Role.Button, onClick = { onBar(bar.cancelSearch()) })
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(localized("Cancel"), fontSize = 17.sp)
            }
        } else {
            UpdatesBar(
                updates = updates,
                onOpen = onOpenUpdates,
                modifier = Modifier.weight(1f),
            )
            ChromeButton(
                icon = Icons.Filled.Search,
                contentDescription = "Search",
                onClick = onOpenSearch,
                size = MIN_TOUCH_TARGET,
            )
            ChromeButton(painter = painterResource(R.drawable.ic_mic), contentDescription = "Walkie", onClick = onVoice, size = MIN_TOUCH_TARGET)
            if (canAdminister) RosterCreateMenu(canCreateBot, canCreateSection, onCreateGroup, onCreateSection, onCreateBot)
        }
    }
}

private val BAR_HEIGHT = 52.dp

@Composable
private fun SearchHitRow(hit: SearchHit, onClick: () -> Unit) {
    val now = remember(hit.id) { System.currentTimeMillis() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // Who said it. Two hits with the same words are otherwise identical.
        Icon(
            // A person for what you said, the Maus mark for what a bot said —
            // iOS makes the same split with person.fill and a speech bubble.
            painter = if (SearchHitRole.isFromUser(hit.role)) {
                rememberVectorPainter(Icons.Filled.Person)
            } else {
                painterResource(R.drawable.ic_maus_mark)
            },
            contentDescription = SearchHitRole.contentDescription(hit.role, hit.name),
            tint = secondaryTint,
            modifier = Modifier
                .size(26.dp)
                .background(secondaryTint.copy(alpha = 0.13f), CircleShape)
                .padding(5.dp),
        )

        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(hit.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                hit.task?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, fontSize = 12.sp, color = secondaryTint)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = RelativeStamp.list(hit.at, now, locale = Locale.getDefault()),
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
            Text(
                text = hit.snippet,
                fontSize = 14.sp,
                color = secondaryTint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Connection state, shown only when it is not "fine". */
@Composable
fun StatusBanner() {
    val session = LocalCompanion.current.session
    val status by session.status.collectAsState()
    val serverWasReset by session.serverWasReset.collectAsState()
    val connection by session.connection.collectAsState()
    val banner: Pair<String, Color>? = when (val current = status) {
        Session.Status.Live, Session.Status.Unpaired -> null
        Session.Status.Connecting -> "Connecting…" to secondaryTint
        is Session.Status.Offline -> (if (connection?.serverEnvironmentId != null)
            "Your BOS is waking up or offline. ${current.message}" else current.message) to Color(MausPalette.argb("orange"))
        Session.Status.Unauthorized ->
            (if (serverWasReset) "This computer was reset, pair again." else "This phone was unpaired on the computer.") to MaterialTheme.colorScheme.error
    }
    val (text, tint) = banner ?: return
    Text(
        text = text,
        fontSize = 13.sp,
        color = tint,
        modifier = Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .background(secondaryTint.copy(alpha = 0.12f), CircleShape)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data

private data class RosterConversation(val summary: ChatSummary, val owner: Session, val connectionId: String, val homeLabel: String?) {
    val key: String get() = "$connectionId:${summary.id}"
}
@Composable
private fun RosterCreateMenu(canCreateBot: Boolean, canCreateSection: Boolean, onGroup: () -> Unit, onSection: () -> Unit, onBot: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        ChromeButton(Icons.Filled.Add, "Create", { expanded = true }, size = MIN_TOUCH_TARGET)
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(text = { Text(localized("New group")) }, onClick = { expanded = false; onGroup() })
            DropdownMenuItem(text = { Text(localized("New section")) }, enabled = canCreateSection, onClick = { expanded = false; onSection() })
            DropdownMenuItem(text = { Text(localized("New bot")) }, enabled = canCreateBot, onClick = { expanded = false; onBot() })
        }
    }
}

/**
 * The newest value, at most once per [millis]: the first after a quiet spell goes
 * straight through, a burst lands its last value when the window closes.
 */
private fun <T> Flow<T>.throttleLatest(millis: Long): Flow<T> = channelFlow {
    var sent = 0L
    collectLatest { value ->
        val wait = sent + millis - android.os.SystemClock.uptimeMillis()
        if (wait > 0) delay(wait)
        sent = android.os.SystemClock.uptimeMillis()
        send(value)
    }
}
