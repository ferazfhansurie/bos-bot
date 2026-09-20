package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Message

/**
 * Which face a bot wears — the desktop's `stateForBot`, ported from
 * `ios/App/MascotState.swift`.
 *
 * A pinned expression wins; then what the bot is doing right now; then a guess
 * from its role. Same rules, same order, so a bot looks the same on the phone as
 * on the laptop.
 */

/** The desktop's legacy names, kept so an older bot record still resolves. */
private val legacy: Map<String, MausState> = mapOf(
    "deadpan" to MausState.IDLE,
    "friendly" to MausState.HAPPY,
    "focused" to MausState.WORKING,
    "thinking" to MausState.THINKING,
    "excited" to MausState.EXCITED,
    "sleepy" to MausState.DROWSY,
    "surprised" to MausState.SURPRISED,
    "skeptical" to MausState.SUSPICIOUS,
    "worried" to MausState.SCARED,
    "mischievous" to MausState.PLAYFUL,
)

private val byId: Map<String, MausState> = MausState.entries.associateBy(MausState::id)

/**
 * A face a bot's description argues for, and the words that argue for it. Whole
 * words only: a "codebase" bot is not a coder, and "qa" must not match "aqua".
 */
private class RoleFace(val state: MausState, words: List<String>) {
    private val patterns = words.map { Regex("\\b${Regex.escape(it)}\\b") }

    fun matches(profile: String): Boolean = patterns.any { it.containsMatchIn(profile) }
}

/** In order: the first that matches wins, as on the desktop. */
private val roleFaces: List<RoleFace> = listOf(
    RoleFace(
        MausState.WORKING,
        listOf("code", "coding", "developer", "development", "engineer", "engineering", "build", "debug", "program", "software"),
    ),
    RoleFace(
        MausState.SEARCHING,
        listOf("research", "researcher", "search", "investigate", "strategy", "strategist", "study", "learn", "knowledge"),
    ),
    RoleFace(
        MausState.EXCITED,
        listOf("marketing", "growth", "launch", "campaign", "social", "sales", "outreach", "brand"),
    ),
    RoleFace(
        MausState.DROWSY,
        listOf("overnight", "night", "background", "async", "queue", "batch", "long-running"),
    ),
    RoleFace(
        MausState.RADAR,
        listOf("monitor", "monitoring", "incident", "alert", "watch", "status", "uptime"),
    ),
    RoleFace(
        MausState.SUSPICIOUS,
        listOf("review", "reviewer", "audit", "critic", "critique", "quality", "qa", "test", "legal"),
    ),
    RoleFace(
        MausState.SCARED,
        listOf("security", "secure", "compliance", "risk", "privacy", "finance", "financial"),
    ),
    RoleFace(
        MausState.PLAYFUL,
        listOf("design", "designer", "creative", "brainstorm", "art", "illustration", "music", "story"),
    ),
    RoleFace(
        MausState.HAPPY,
        listOf("support", "help", "success", "onboarding", "coach", "teacher", "guide", "welcome"),
    ),
)

/** Resolves any stored value — current, legacy or junk — to a real state. */
internal fun MausState.Companion.normalize(value: String?): MausState? {
    if (value.isNullOrEmpty()) return null
    return byId[value] ?: legacy[value]
}

internal fun MausState.Companion.forBot(bot: Bot, last: Message?): MausState {
    normalize(bot.mascotExpression)?.let { return it }

    if (last?.kind == Message.Kind.ACTIVITY && last.tool?.ok == false) return MausState.ALERTING
    if (bot.busy == true) return MausState.WORKING
    if (bot.unread) return MausState.NOTIFYING
    if (last?.kind == Message.Kind.OPTIONS) return MausState.CURIOUS

    val profile = "${bot.name} ${bot.title} ${bot.description}".lowercase()
    for (role in roleFaces) {
        if (role.matches(profile)) return role.state
    }
    return MausState.IDLE
}

/**
 * The face for a chat as a whole: a bot's own, a room's is "happy" — which is what
 * the desktop draws for room avatars.
 */
internal fun MausState.Companion.forChat(chat: Chat, state: CompanionState): MausState =
    forChat(chat, state.visibleTranscript(chat.threadId).lastOrNull())

/** The same, for a caller that already walked the chat's visible transcript. */
internal fun MausState.Companion.forChat(chat: Chat, last: Message?): MausState = when (chat) {
    is Chat.BotChat -> forBot(chat.bot, last)
    is Chat.RoomChat -> MausState.HAPPY
}
