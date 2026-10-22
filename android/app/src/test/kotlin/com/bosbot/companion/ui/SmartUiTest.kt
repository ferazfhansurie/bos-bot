package com.openmausbot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class SmartUiTest {
    @Test
    fun `handles the four smart languages, any case`() {
        listOf("chart", "stats", "openui", "openui-lang", "Chart", "OPENUI-LANG").forEach {
            assertTrue(SmartUi.handles(it), it)
        }
        listOf(null, "", "kotlin", "json", "openui2", "charts").forEach {
            assertFalse(SmartUi.handles(it), it.toString())
        }
    }

    @Test
    fun `only openui blocks get the caption`() {
        assertTrue(SmartUi.isOpenUi("openui"))
        assertTrue(SmartUi.isOpenUi("OpenUI-Lang"))
        assertFalse(SmartUi.isOpenUi("chart"))
        assertFalse(SmartUi.isOpenUi("stats"))
    }

    @Test
    fun `payload carries the page's render contract`() {
        val saved = buildJsonObject { put("n", 3) }
        val json = Json.parseToJsonElement(
            SmartUi.payload("chart", "{\"a\":1}", streaming = true, dark = true, states = mapOf("b1" to saved)).toString(),
        ).jsonObject
        assertEquals("chart", json["lang"]!!.jsonPrimitive.content)
        assertEquals("{\"a\":1}", json["code"]!!.jsonPrimitive.content)
        assertTrue(json["streaming"]!!.jsonPrimitive.boolean)
        assertEquals("dark", json["theme"]!!.jsonPrimitive.content)
        assertEquals(saved, json["states"]!!.jsonObject["b1"])
        assertEquals(
            "light",
            SmartUi.payload("stats", "", false, false, emptyMap()).get("theme")!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `live values win over what the server saved`() {
        val server = mapOf("b1" to buildJsonObject { put("v", "old") }, "b2" to buildJsonObject { put("v", "kept") })
        val live = mapOf("m1" to mapOf("b1" to buildJsonObject { put("v", "new") }))
        val merged = SmartUi.states("m1", server, live)
        assertEquals(JsonPrimitive("new"), merged["b1"]!!["v"])
        assertEquals(JsonPrimitive("kept"), merged["b2"]!!["v"])
        assertEquals(server, SmartUi.states("other", server, live))
        assertEquals(server, SmartUi.states(null, server, live))
        assertTrue(SmartUi.states("m1", null, emptyMap()).isEmpty())
    }

    @Test
    fun `parses every message the page posts`() {
        assertEquals(SmartUiEvent.Ready, SmartUi.parseEvent("""{"type":"ready"}"""))
        assertEquals(SmartUiEvent.Failed, SmartUi.parseEvent("""{"type":"failed"}"""))
        assertEquals(SmartUiEvent.Height(212.5), SmartUi.parseEvent("""{"type":"height","value":212.5}"""))
        assertEquals(SmartUiEvent.Assistant("book it"), SmartUi.parseEvent("""{"type":"assistant","text":"book it"}"""))
        assertEquals(SmartUiEvent.OpenUrl("https://a.b/c"), SmartUi.parseEvent("""{"type":"openUrl","url":"https://a.b/c"}"""))
        assertEquals(
            SmartUiEvent.State("b1x", buildJsonObject { put("k", 1) }),
            SmartUi.parseEvent("""{"type":"state","key":"b1x","state":{"k":1}}"""),
        )
    }

    @Test
    fun `rejects what is not a usable message`() {
        assertNull(SmartUi.parseEvent("not json"))
        assertNull(SmartUi.parseEvent("[]"))
        assertNull(SmartUi.parseEvent("""{"type":"height","value":0}"""))
        assertNull(SmartUi.parseEvent("""{"type":"height","value":"tall"}"""))
        assertNull(SmartUi.parseEvent("""{"type":"assistant","text":""}"""))
        assertNull(SmartUi.parseEvent("""{"type":"openUrl","url":"javascript:alert(1)"}"""))
        assertNull(SmartUi.parseEvent("""{"type":"openUrl","url":"file:///etc/passwd"}"""))
        assertNull(SmartUi.parseEvent("""{"type":"state","key":"b1","state":"x"}"""))
        assertNull(SmartUi.parseEvent("""{"type":"mystery"}"""))
    }

    @Test
    fun `cache key separates theme and code`() {
        val a = SmartUi.cacheKey("chart", "x", dark = false)
        assertEquals(a, SmartUi.cacheKey("CHART", "x", dark = false))
        assertTrue(a != SmartUi.cacheKey("chart", "x", dark = true))
        assertTrue(a != SmartUi.cacheKey("chart", "y", dark = false))
    }
}
