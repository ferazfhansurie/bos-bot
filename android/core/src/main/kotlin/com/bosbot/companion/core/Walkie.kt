package com.openmausbot.companion.core

/** Hold-to-talk sends reviewed text; only settled bot replies are spoken. */
object Walkie {
    fun settledReply(transcript: List<Message>, baseline: Set<String>, busy: Boolean): String? {
        val fresh = transcript.filter { it.role == Message.Role.BOT && it.id !in baseline }
        fun spoken(message: Message): String? = when (message.kind) {
            Message.Kind.TEXT -> message.text?.trim()?.takeIf(String::isNotEmpty)
            Message.Kind.OPTIONS -> message.card?.let { listOf(it.title, it.subtitle).filter(String::isNotBlank).joinToString(" ").takeIf(String::isNotEmpty) }
            else -> null
        }
        if (busy) return fresh.lastOrNull { it.kind == Message.Kind.OPTIONS }?.let(::spoken)
        return fresh.mapNotNull(::spoken).joinToString("\n\n").takeIf(String::isNotEmpty)
    }

    fun busy(state: CompanionState, chat: Chat): Boolean {
        if (state.streaming.keys.any { it == chat.threadId || it.startsWith("${chat.threadId}:room:") }) return true
        return when (chat) {
            is Chat.BotChat -> state.bot(chat.bot.id)?.forTask(chat.threadId)?.busy == true
            is Chat.RoomChat -> state.roomOwningTask(chat.threadId)?.let { room ->
                room.tasks?.firstOrNull { it.threadId == chat.threadId }?.busy == true ||
                    (room.threadId == chat.threadId && room.busyBotId != null)
            } == true
        }
    }

    fun speakable(markdown: String, limit: Int = 600): String {
        require(limit > 0)
        val cleaned = markdown.replace(Regex("(?s)```.*?```"), "\nCode omitted.\n")
            .replace(Regex("!?\\[([^\\]]*)\\]\\([^)]*\\)"), "$1")
            .replace(Regex("https?://\\S+"), "a link")
        val text = cleaned.lineSequence().map { raw ->
            raw.trim().replace(Regex("^(#{1,6}\\s*|[-*+]\\s+|\\d+[.)]\\s+|>\\s*)"), "")
                .replace("**", "").replace("__", "").replace("~~", "").replace("`", "").replace("|", ", ")
                .replace(Regex("(?<!\\w)[*_](.+?)[*_](?!\\w)"), "$1").trim(' ', ',')
        }.filter(String::isNotEmpty).joinToString(" ") { if (it.last() in ".!?:;") it else "$it." }
            .replace(Regex("\\s+"), " ")
        if (text.length <= limit) return text
        val head = text.take(limit)
        val sentence = head.indexOfLast { it in ".!?" }
        val cut = if (sentence > limit / 3) head.take(sentence + 1)
            else head.take(head.lastIndexOf(' ').takeIf { it > 0 } ?: head.length) + "…"
        return "$cut The rest is in the chat."
    }

    fun utterances(text: String, limit: Int = 320): List<String> {
        require(limit in 1..500)
        val output = mutableListOf<String>()
        var current = ""
        text.trim().split(Regex("\\s+")).filter(String::isNotEmpty).forEach { raw ->
            var word = raw
            while (word.length > limit) {
                if (current.isNotEmpty()) { output += current; current = "" }
                output += word.take(limit); word = word.drop(limit)
            }
            if (word.isNotEmpty()) {
                if (current.isEmpty()) current = word
                else if (current.length + word.length + 1 <= limit) current += " $word"
                else { output += current; current = word }
            }
        }
        if (current.isNotEmpty()) output += current
        return output
    }
}

/** Uses only the selected pairing; the text is bounded by the existing TTS route. */
suspend fun Session.walkieSpeech(text: String, voiceId: String?, expectedConnectionId: String): ByteArray =
    synthesizeWalkie(text, voiceId, expectedConnectionId)

suspend fun Session.stopWalkie(chat: Chat, expectedConnectionId: String) {
    val snapshot = state.value
    val botId = when (chat) {
        is Chat.BotChat -> chat.bot.id
        is Chat.RoomChat -> snapshot.roomOwningTask(chat.threadId)?.busyBotId
            ?: snapshot.activity.entries.values.firstOrNull { it.threadId == chat.threadId && it.state.isLive }?.botId
    } ?: throw APIError.Transport("Open the chat to stop this reply.")
    if (connection.value?.id != expectedConnectionId) throw APIError.Transport("The selected computer changed.")
    val bot = snapshot.bot(botId) ?: throw APIError.Transport("Open the chat to stop this reply.")
    interrupt(bot.copy(threadId = chat.threadId))
}
