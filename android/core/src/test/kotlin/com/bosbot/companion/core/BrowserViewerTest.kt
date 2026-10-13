package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlinx.serialization.json.jsonPrimitive

class BrowserViewerTest {
    @Test fun namedEventsAndMultilineCRLF() {
        val parser = BrowserSSEParser()
        assertNull(parser.line(": heartbeat\r"))
        parser.line("event: ready\r")
        parser.line("data: {\r")
        parser.line("data: \"viewerId\":\"viewer-1\"}\r")
        val event = assertNotNull(parser.line("\r"))
        assertEquals("ready", event.name)
        assertEquals("viewer-1", event.payload.viewerId)
        assertNull(parser.line(""))
    }
    @Test fun incompleteEventsNeverCarryAcrossAReset() {
        val parser = BrowserSSEParser()
        parser.line("event: frame"); parser.line("data: {\"seq\":1}")
        parser.reset()
        parser.line("event: heartbeat"); parser.line("data: {}")
        assertEquals("heartbeat", parser.line("")?.name)
    }
    @Test fun invalidFramesAndUnknownEventsStopTheStream() {
        assertFailsWith<IllegalArgumentException> { BrowserViewerEvent.decode("arbitrary", "{}") }
        assertFailsWith<IllegalArgumentException> { BrowserViewerEvent.decode("frame", """{"seq":0,"data":"AA==","metadata":{"deviceWidth":10,"deviceHeight":10}}""") }
        assertFailsWith<IllegalArgumentException> { BrowserViewerEvent.decode("frame", """{"seq":1,"data":"AA==","metadata":{"deviceWidth":8192,"deviceHeight":8192}}""") }
        assertNotNull(BrowserViewerEvent.decode("frame", """{"seq":1,"data":"AA==","metadata":{"deviceWidth":1920,"deviceHeight":1080}}"""))
    }
    @Test fun incompleteOversizedEventsAreRejected() {
        val parser = BrowserSSEParser()
        assertFailsWith<IllegalArgumentException> { parser.line("data: " + "a".repeat(4 * 1024 * 1024)) }
    }
    @Test fun coordinatesExcludeLetterboxAndBindToPagePixels() {
        assertNull(browserPagePoint(10f, 10f, 100, 100, 200, 100))
        assertEquals(100.0 to 50.0, browserPagePoint(50f, 50f, 100, 100, 200, 100))
        assertNull(browserPagePoint(100f, 50f, 100, 100, 200, 100))
        assertNull(browserPagePoint(Float.NaN, 50f, 100, 100, 200, 100))
        assertNull(browserPagePoint(10f, 10f, 0, 100, 200, 100))
    }
    @Test fun actionsKeepDisplayedSequenceAndProtocolFieldNames() {
        val tap = BrowserViewerAction.Tap(17, 12.0, 22.0).body()
        assertEquals("tap", tap["type"]?.jsonPrimitive?.content)
        assertEquals("17", tap["seq"]?.jsonPrimitive?.content)
        val wheel = BrowserViewerAction.Scroll(18, 1.0, 2.0, -3.0, 4.0).body()
        assertEquals("18", wheel["frameSeq"]?.jsonPrimitive?.content)
        assertNull(wheel["seq"])
        assertEquals("mouseWheel", wheel["eventType"]?.jsonPrimitive?.content)
        assertEquals("tab-select", BrowserViewerAction.SelectTab("t1").body()["type"]?.jsonPrimitive?.content)
        assertEquals("keyDown", BrowserViewerAction.Enter.body()["eventType"]?.jsonPrimitive?.content)
    }
    @Test fun navigationEscapesSearchInput() {
        assertEquals("https://example.com", browserNavigationURL(" example.com "))
        assertEquals("https://example.com/a", browserNavigationURL("https://example.com/a"))
        assertEquals("https://www.google.com/search?q=foo+%26+bar", browserNavigationURL("foo & bar"))
        assertTrue(browserNavigationURL("javascript:alert(1)").startsWith("https://www.google.com/search?q="))
    }
    @Test fun dedicatedStreamReadsNamedReadyAndClosesOnCancellation() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("event: ready\ndata: {\"viewerId\":\"v1\"}\n\n"))
            val event = withTimeout(5000) { browserViewerStream(Request.Builder().url(server.url("/browser/live")).build(), OkHttpClient()).first() }
            assertEquals("v1", event.payload.viewerId)
            assertEquals("/browser/live", server.takeRequest().path)
        } finally { server.shutdown() }
    }
    @Test fun authorizationErrorIsNotRetried() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(403))
            assertFailsWith<APIError.Status> { withTimeout(5000) { browserViewerStream(Request.Builder().url(server.url("/browser/live")).build(), OkHttpClient()).first() } }
            assertEquals(1, server.requestCount)
        } finally { server.shutdown() }
    }
}
