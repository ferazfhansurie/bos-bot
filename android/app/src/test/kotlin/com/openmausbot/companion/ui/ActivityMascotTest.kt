package com.openmausbot.companion.ui

import com.openmausbot.companion.core.ActivityFeedEntry
import com.openmausbot.companion.core.ActivityState
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.ToolActivity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Which face the server's activity feed asks for, and where. A chat-list row
 * shows the busiest thing its bot is doing anywhere — so work in a thread nobody
 * has open still moves — while the open chat's header answers for exactly its
 * own (bot, thread) lane. Without a feed entry both fall back to the face the
 * bot wore before the feed existed.
 */
class ActivityMascotTest {
    private val plain = bot(title = "", name = "Bot")

    // -- forActivity ---------------------------------------------------------

    @Test
    fun `no activity, or idle, has nothing to say`() {
        assertNull(MascotFace.forActivity(null))
        assertNull(MascotFace.forActivity(ActivityState.IDLE))
        assertNull(MascotFace.forActivity(ActivityState.IDLE, toolName = "web_search"))
    }

    @Test
    fun `thinking and typing both think, and keep moving`() {
        assertEquals(MascotFace(MausState.THINKING, animated = true), MascotFace.forActivity(ActivityState.THINKING))
        assertEquals(MascotFace(MausState.THINKING, animated = true), MascotFace.forActivity(ActivityState.TYPING))
    }

    @Test
    fun `a running tool works, unless it is a search`() {
        assertEquals(MascotFace(MausState.WORKING), MascotFace.forActivity(ActivityState.TOOL))
        assertEquals(MascotFace(MausState.WORKING), MascotFace.forActivity(ActivityState.TOOL, toolName = "shell"))
        assertEquals(MascotFace(MausState.SEARCHING), MascotFace.forActivity(ActivityState.TOOL, toolName = "web_search"))
        assertEquals(MascotFace(MausState.SEARCHING), MascotFace.forActivity(ActivityState.TOOL, toolName = "Web_Search"))
        // a tool name only matters while a tool runs
        assertEquals(MascotFace(MausState.THINKING), MascotFace.forActivity(ActivityState.THINKING, toolName = "web_search"))
    }

    @Test
    fun `waiting on a person is curious`() {
        assertEquals(MascotFace(MausState.CURIOUS), MascotFace.forActivity(ActivityState.WAITING))
    }

    @Test
    fun `failed and stopped settle on a still face`() {
        assertEquals(MascotFace(MausState.IDLE, animated = false), MascotFace.forActivity(ActivityState.FAILED))
        assertEquals(MascotFace(MausState.IDLE, animated = false), MascotFace.forActivity(ActivityState.STOPPED))
    }

    // -- forRow --------------------------------------------------------------

    @Test
    fun `a bot busy in a thread nobody has open still moves its row`() {
        val chat = Chat.BotChat(plain)
        val state = withFeed(
            CompanionState(bots = listOf(plain)),
            lane(plain.id, "some-other-thread", ActivityState.TYPING),
            lane(plain.id, "yet-another-thread", ActivityState.TOOL),
            lane(plain.id, plain.threadId, ActivityState.FAILED),
        )
        assertEquals(MascotFace(MausState.WORKING), MascotFace.forRow(chat, state))
    }

    @Test
    fun `a row without a feed entry is exactly the old face`() {
        val researcher = bot() // "research" title: the role face is SEARCHING
        val chat = Chat.BotChat(researcher)
        val state = CompanionState(bots = listOf(researcher))
        assertEquals(MascotFace(MausState.forChat(chat, state)), MascotFace.forRow(chat, state))
        assertEquals(MascotFace(MausState.SEARCHING), MascotFace.forRow(chat, state))

        // an idle lane, or another bot's lane, is no word either
        val idle = withFeed(state, lane(researcher.id, researcher.threadId, ActivityState.IDLE), lane("bot-2", "t", ActivityState.TOOL))
        assertEquals(MascotFace(MausState.forChat(chat, idle)), MascotFace.forRow(chat, idle))
    }

    @Test
    fun `a bot row ignores the bot's room lanes`() {
        val chat = Chat.BotChat(plain)
        val state = withFeed(
            CompanionState(bots = listOf(plain)),
            lane(plain.id, room().threadId, ActivityState.WAITING, roomId = room().id),
        )
        assertEquals(MascotFace(MausState.forChat(chat, state)), MascotFace.forRow(chat, state))
    }

    @Test
    fun `a room row shows its busiest member across the room's lanes`() {
        val standup = room()
        val chat = Chat.RoomChat(standup)
        val base = CompanionState(rooms = listOf(standup))
        val state = withFeed(
            base,
            lane("bot-1", standup.threadId, ActivityState.THINKING, roomId = standup.id),
            lane("bot-2", "thread-room-task", ActivityState.WAITING, roomId = standup.id),
            lane("bot-1", "thread-bot-1", ActivityState.TOOL), // a member's own lane is not the room's
        )
        assertEquals(MascotFace(MausState.CURIOUS), MascotFace.forRow(chat, state))

        // no feed: the room keeps its happy face
        assertEquals(MascotFace(MausState.HAPPY), MascotFace.forRow(chat, base))
    }

    @Test
    fun `a room row falls back to its thread when lanes carry no roomId`() {
        val standup = room()
        val state = withFeed(
            CompanionState(rooms = listOf(standup)),
            lane("bot-2", standup.threadId, ActivityState.TYPING),
        )
        assertEquals(MascotFace(MausState.THINKING), MascotFace.forRow(Chat.RoomChat(standup), state))
    }

    // -- forOpenChat ---------------------------------------------------------

    @Test
    fun `the open chat answers for exactly its own lane`() {
        val chat = Chat.BotChat(plain)
        val elsewhere = withFeed(
            CompanionState(bots = listOf(plain)),
            lane(plain.id, "some-other-thread", ActivityState.TOOL),
            lane("bot-2", plain.threadId, ActivityState.WAITING),
        )
        // busy elsewhere moves the row, not the open chat
        assertEquals(MascotFace(MausState.WORKING), MascotFace.forRow(chat, elsewhere))
        assertEquals(MascotFace(MausState.forChat(chat, null as Message?)), MascotFace.forOpenChat(chat, elsewhere.activity, null))
        assertEquals(MascotFace(MausState.IDLE), MascotFace.forOpenChat(chat, elsewhere.activity, null))

        val here = withFeed(elsewhere, lane(plain.id, plain.threadId, ActivityState.WAITING))
        assertEquals(MascotFace(MausState.CURIOUS), MascotFace.forOpenChat(chat, here.activity, null))
    }

    @Test
    fun `the open chat names the running tool from its last activity`() {
        val chat = Chat.BotChat(plain)
        val state = withFeed(CompanionState(bots = listOf(plain)), lane(plain.id, plain.threadId, ActivityState.TOOL))
        assertEquals(MascotFace(MausState.SEARCHING), MascotFace.forOpenChat(chat, state.activity, activity("web_search")))
        assertEquals(MascotFace(MausState.WORKING), MascotFace.forOpenChat(chat, state.activity, activity("shell")))
        // a tool on anything but an activity names nothing
        val text = activity("web_search").copy(kind = Message.Kind.TEXT)
        assertEquals(MascotFace(MausState.WORKING), MascotFace.forOpenChat(chat, state.activity, text))
    }

    @Test
    fun `the open chat falls back to its last message without a lane`() {
        val chat = Chat.BotChat(plain)
        val failed = activity("shell", ok = false)
        val state = CompanionState(bots = listOf(plain))
        assertEquals(MascotFace(MausState.ALERTING), MascotFace.forOpenChat(chat, state.activity, failed))
    }

    @Test
    fun `an open room shows its busiest member in this thread`() {
        val standup = room()
        val chat = Chat.RoomChat(standup)
        val state = withFeed(
            CompanionState(rooms = listOf(standup)),
            lane("bot-1", standup.threadId, ActivityState.THINKING, roomId = standup.id),
            lane("bot-2", standup.threadId, ActivityState.TOOL, roomId = standup.id),
            lane("bot-2", "thread-room-task", ActivityState.WAITING, roomId = standup.id),
        )
        assertEquals(MascotFace(MausState.SEARCHING), MascotFace.forOpenChat(chat, state.activity, activity("web_search")))
        assertEquals(MascotFace(MausState.HAPPY), MascotFace.forOpenChat(chat, CompanionState(rooms = listOf(standup)).activity, null))
    }

    private fun withFeed(state: CompanionState, vararg lanes: ActivityFeedEntry): CompanionState =
        state.apply(Frame.Activity(lanes.toList(), replace = true))

    private fun lane(
        botId: String,
        threadId: String,
        state: ActivityState,
        roomId: String? = null,
    ) = ActivityFeedEntry(botId = botId, threadId = threadId, roomId = roomId, state = state)

    private fun activity(tool: String, ok: Boolean? = null) = Message(
        id = "m-$tool",
        role = Message.Role.BOT,
        kind = Message.Kind.ACTIVITY,
        at = 0.0,
        tool = ToolActivity(name = tool, ok = ok),
    )
}
