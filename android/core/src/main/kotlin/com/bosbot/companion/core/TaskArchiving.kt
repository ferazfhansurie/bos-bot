package com.openmausbot.companion.core

/** Change only the target task stamp, retaining every later profile/task field. */
internal fun CompanionState.withTaskArchive(botId: String, threadId: String, archivedAt: Double?, expected: Double? = null,
    requireExpected: Boolean = false): CompanionState = copy(bots = bots.map { bot ->
    if (bot.id != botId) bot else bot.copy(tasks = bot.tasks?.map { task ->
        if (task.threadId != threadId || (requireExpected && task.archivedAt != expected)) task else task.copy(archivedAt = archivedAt)
    })
})
