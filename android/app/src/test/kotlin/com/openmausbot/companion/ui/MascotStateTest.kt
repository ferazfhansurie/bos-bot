package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.ToolActivity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Which face a bot wears, in the desktop's order: a pinned expression, then a
 * failure, then work, then unread, then a question, then its role. The order is
 * the point — it is what makes "this one stopped and needs you" louder than "this
 * one is busy", so each rung is tested against the one below it.
 *
 * Ported alongside `ios/App/MascotState.swift`; a divergence here is a bot wearing
 * one face on the laptop and another on the phone.
 */
class MascotStateTest {
    private val idle = bot(title = "", name = "Bot")

    @Test
    fun `a pinned expression wins over everything the bot is doing`() {
        val pinned = idle.copy(
            mascotExpression = "celebrate",
            busy = true,
            unread = true,
        )
        assertEquals(MausState.CELEBRATE, MausState.forBot(pinned, failedActivity))
    }

    @Test
    fun `the desktop's legacy expression names still resolve`() {
        assertEquals(MausState.IDLE, MausState.normalize("deadpan"))
        assertEquals(MausState.HAPPY, MausState.normalize("friendly"))
        assertEquals(MausState.WORKING, MausState.normalize("focused"))
        assertEquals(MausState.THINKING, MausState.normalize("thinking"))
        assertEquals(MausState.EXCITED, MausState.normalize("excited"))
        assertEquals(MausState.DROWSY, MausState.normalize("sleepy"))
        assertEquals(MausState.SURPRISED, MausState.normalize("surprised"))
        assertEquals(MausState.SUSPICIOUS, MausState.normalize("skeptical"))
        assertEquals(MausState.SCARED, MausState.normalize("worried"))
        assertEquals(MausState.PLAYFUL, MausState.normalize("mischievous"))
    }

    @Test
    fun `every current expression name resolves to itself`() {
        for (state in MausState.entries) {
            assertEquals(state, MausState.normalize(state.id), state.id)
        }
    }

    @Test
    fun `an unknown or missing expression is not a pin`() {
        assertNull(MausState.normalize(null))
        assertNull(MausState.normalize(""))
        assertNull(MausState.normalize("smouldering"))
        // and so the bot falls through to the rest of the ladder
        assertEquals(
            MausState.WORKING,
            MausState.forBot(idle.copy(mascotExpression = "smouldering", busy = true), null),
        )
    }

    @Test
    fun `a failed tool beats being busy`() {
        val busy = idle.copy(busy = true, unread = true)
        assertEquals(MausState.ALERTING, MausState.forBot(busy, failedActivity))
    }

    @Test
    fun `an activity that did not fail is not an alert`() {
        val ok = message(Message.Kind.ACTIVITY, tool = ToolActivity(name = "grep", ok = true))
        val unknown = message(Message.Kind.ACTIVITY, tool = ToolActivity(name = "grep"))
        assertEquals(MausState.IDLE, MausState.forBot(idle, ok))
        assertEquals(MausState.IDLE, MausState.forBot(idle, unknown))
    }

    @Test
    fun `a failure only counts on an activity`() {
        val text = message(Message.Kind.TEXT, tool = ToolActivity(name = "grep", ok = false))
        assertEquals(MausState.IDLE, MausState.forBot(idle, text))
    }

    @Test
    fun `busy beats unread`() {
        assertEquals(MausState.WORKING, MausState.forBot(idle.copy(busy = true, unread = true), null))
    }

    @Test
    fun `unread beats a question waiting on you`() {
        assertEquals(MausState.NOTIFYING, MausState.forBot(idle.copy(unread = true), optionsCard))
    }

    @Test
    fun `a question waiting on you beats the bot's role`() {
        val researcher = bot(title = "research", name = "Bot")
        assertEquals(MausState.SEARCHING, MausState.forBot(researcher, null))
        assertEquals(MausState.CURIOUS, MausState.forBot(researcher, optionsCard))
    }

    @Test
    fun `the role is read from name, title and description alike`() {
        assertEquals(MausState.WORKING, MausState.forBot(idle.copy(name = "Debug"), null))
        assertEquals(MausState.WORKING, MausState.forBot(idle.copy(title = "engineer"), null))
        assertEquals(MausState.WORKING, MausState.forBot(idle.copy(description = "writes software"), null))
    }

    @Test
    fun `each role wears the desktop's face for it`() {
        assertEquals(MausState.WORKING, roleFace("engineering"))
        assertEquals(MausState.SEARCHING, roleFace("investigate"))
        assertEquals(MausState.EXCITED, roleFace("campaign"))
        assertEquals(MausState.DROWSY, roleFace("overnight"))
        assertEquals(MausState.RADAR, roleFace("uptime"))
        assertEquals(MausState.SUSPICIOUS, roleFace("qa"))
        assertEquals(MausState.SCARED, roleFace("compliance"))
        assertEquals(MausState.PLAYFUL, roleFace("illustration"))
        assertEquals(MausState.HAPPY, roleFace("onboarding"))
    }

    @Test
    fun `the first matching role wins, in the desktop's order`() {
        // "security" is checked before "design", and "code" before either
        assertEquals(MausState.SCARED, roleFace("security design"))
        assertEquals(MausState.WORKING, roleFace("code security design"))
    }

    @Test
    fun `a role matches whole words only`() {
        assertEquals(MausState.IDLE, roleFace("codebase"))
        assertEquals(MausState.IDLE, roleFace("aqua"))
        assertEquals(MausState.SUSPICIOUS, roleFace("runs qa, mostly"))
        assertEquals(MausState.DROWSY, roleFace("long-running errands"))
    }

    @Test
    fun `a bot with nothing to go on is idle`() {
        assertEquals(MausState.IDLE, MausState.forBot(idle, null))
    }

    @Test
    fun `a room always looks happy`() {
        val state = CompanionState(rooms = listOf(room()))
        assertEquals(MausState.HAPPY, MausState.forChat(Chat.RoomChat(room()), state))
    }

    @Test
    fun `a chat is resolved from its last visible message`() {
        val waiting = idle.copy(id = "bot-1")
        val state = CompanionState(
            bots = listOf(waiting),
            messages = mapOf(waiting.threadId to listOf(message(Message.Kind.TEXT), optionsCard)),
        )
        assertEquals(MausState.CURIOUS, MausState.forChat(Chat.BotChat(waiting), state))
    }

    @Test
    fun `a chat with no transcript still resolves`() {
        val state = CompanionState(bots = listOf(idle))
        assertEquals(MausState.IDLE, MausState.forChat(Chat.BotChat(idle), state))
    }

    private fun roleFace(description: String): MausState =
        MausState.forBot(idle.copy(description = description), null)

    private val failedActivity = message(
        Message.Kind.ACTIVITY,
        tool = ToolActivity(name = "shell", ok = false),
    )

    private val optionsCard = message(
        Message.Kind.OPTIONS,
        card = OptionCard(title = "Deploy?", subtitle = "", options = listOf("Yes"), requestId = "r1"),
    )

    private fun message(
        kind: Message.Kind,
        tool: ToolActivity? = null,
        card: OptionCard? = null,
    ) = Message(
        id = "m-${kind.name}-${tool?.ok}",
        role = Message.Role.BOT,
        kind = kind,
        at = 0.0,
        tool = tool,
        card = card,
    )
}
