package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ConnectionTraceTest {
    @Test fun exportKeepsOnlyTheLatestEvents() {
        val trace = ConnectionTrace(capacity = 3)
        repeat(8) { trace.record(ConnectionTrace.Event.CONNECTING) }
        trace.record(ConnectionTrace.Event.SERVER_RESET)
        val lines = trace.export().trim().lines()
        assertEquals(4, lines.size)
        assertEquals("BOS connection trace (connection events only)", lines.first())
        assertTrue(lines.last().endsWith("server_reset"))
    }

    @Test fun emptyExportExplainsThereAreNoEvents() {
        assertTrue(ConnectionTrace().export().contains("No connection events recorded."))
    }
}
