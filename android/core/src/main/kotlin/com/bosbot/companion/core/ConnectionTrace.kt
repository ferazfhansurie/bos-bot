package com.openmausbot.companion.core

/** Typed events cannot accidentally carry a host, credential, error payload or message. */
class ConnectionTrace(private val capacity: Int = 240) {
    enum class Event { UNPAIRED, CONNECTING, LIVE, OFFLINE, UNAUTHORIZED, SERVER_RESET, DISCONNECT }
    private val lines = ArrayDeque<String>()

    init { require(capacity > 0) }

    @Synchronized fun record(event: Event) {
        while (lines.size >= capacity) lines.removeFirst()
        lines.addLast("${System.currentTimeMillis()} ${event.name.lowercase()}")
    }

    @Synchronized fun export(): String =
        "BOS connection trace (connection events only)\n" +
            if (lines.isEmpty()) "No connection events recorded.\n" else lines.joinToString("\n", postfix = "\n")
}
